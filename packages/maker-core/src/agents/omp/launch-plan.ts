import path from 'node:path';
import { OMP_COMPATIBILITY_BASELINE } from './commands.js';
import {
  OMP_CINDY_API_KEY_ENV,
  OMP_CINDY_PROVIDER_ID,
  OMP_CINDY_SESSION_ID_ENV,
  OMP_CINDY_SESSION_TOKEN_ENV,
  OMP_MODELS_FILE_NAME,
} from './models-config.js';
import {
  resolveOmpApprovalMode,
  type OmpApprovalMode,
} from './permission-map.js';

/** OMP 把 PI_CONFIG_DIR 当作 HOME 下的**目录名**，不是绝对路径。 */
export const OMP_CONFIG_DIR_NAME = '.omp';
export const OMP_SETTINGS_FILE_NAME = 'omp-settings.yaml';
export const OMP_SYSTEM_PROMPT_DIRECTORY_NAME = 'system-prompts';

export interface OmpSessionRoots {
  /**
   * Lex 受管的**持久** OMP 根（`userData/omp-agent-home`）。
   * 绝不能是 `~/.omp`，更不能是 Pi 的目录 —— 两者上游仓库不同但环境变量名相近。
   */
  home: string;
  /** 会话的真实项目目录（不是沙箱临时目录）。 */
  workingDir: string;
  platform?: NodeJS.Platform;
  /** Windows 即使重建环境也需要的非敏感 OS 路径。 */
  windowsSystemRoot?: string;
}

export interface OmpLaunchModel {
  provider?: string;
  model?: string;
}

export interface OmpSessionCredentials {
  /** 交给 models.yml `apiKey` 指向的 env 的占位值；只进子进程 env，不落盘。 */
  proxyKey?: string;
  sessionId?: string;
  sessionToken?: string;
}

/**
 * The small, host-owned part of the parent environment that native OMP tools
 * need in order to find and launch local programs.  This is deliberately a
 * whitelist rather than a `process.env` clone: credentials, provider state and
 * arbitrary application flags stay out of the child process.
 */
export interface OmpSessionExecutableEnvironment {
  /** Search path used by native shell, PTY, LSP and MCP process launches. */
  path?: string;
  /** POSIX shell selected by the host when one is available. */
  shell?: string;
  /** Terminal capabilities for native PTY output. */
  term?: string;
  colorTerm?: string;
  /** Locale is needed for correctly decoding tool output on POSIX hosts. */
  lang?: string;
  lcCtype?: string;
  /** Windows command interpreter and executable suffix resolution. */
  systemRoot?: string;
  comSpec?: string;
  pathext?: string;
}

export interface OmpSessionLaunchPlanInput {
  readonly roots: OmpSessionRoots;
  /** Lex 权限档位；未知/缺失一律 fail-closed 到 `always-ask`（见 permission-map）。 */
  readonly permissionMode?: unknown;
  readonly model?: OmpLaunchModel;
  readonly credentials?: OmpSessionCredentials;
  /**
   * Explicit host-approved executable environment.  Omitted values are not
   * inherited from the parent process.
   */
  readonly executableEnvironment?: OmpSessionExecutableEnvironment;
  /**
   * Host-owned remote network variables. This narrow surface exists for the
   * existing SSH agent-proxy preference; caller data can never replace HOME,
   * credentials, config roots, or arbitrary process environment entries.
   */
  readonly remoteProxyEnvironment?: Readonly<Record<string, string>>;
  /** OMP runtime names to disable through its native skill extension setting. */
  readonly disabledSkillNames?: readonly string[];
  /**
   * 可选：把会话 JSONL 指到受管根内。
   * 上游 `--session-dir` 未在 v18.1.18 spike 中实证，因此默认不传（agent 目录
   * 本身已在受管根内，默认落点即受管）；需要显式钉住时才打开。
   */
  readonly sessionDir?: string;
  /**
   * Opaque host-generated key for a managed append-system-prompt file.  The
   * prompt bytes never enter argv; this key only selects a session-unique path
   * under the OMP agent root.
   */
  readonly appendSystemPromptKey?: string;
}

export interface OmpSessionLaunchPlan {
  readonly roots: Readonly<{
    home: string;
    config: string;
    agent: string;
    sessions: string;
    workingDir: string;
    temporary: string;
    settingsFile: string;
    modelsFile: string;
    /** Managed projection point for the shared ~/.agents/skills root. */
    globalSkillsDirectory: string;
    systemPromptDirectory: string;
    systemPromptFile?: string;
  }>;
  /** 实际生效的 OMP 档位（双写进 --approval-mode 与 settings YAML，防默认 yolo）。 */
  readonly approvalMode: OmpApprovalMode;
  readonly settingsYaml: string;
  /** 生产会话启动参数：没有 `--no-session` / `--no-tools`。 */
  readonly arguments: readonly string[];
  /** 全新环境，绝不克隆父进程 environment。 */
  readonly environment: Readonly<Record<string, string>>;
}

const MAX_ARGUMENT_VALUE_LENGTH = 512;
const MAX_ENV_VALUE_LENGTH = 4096;
const MAX_EXECUTABLE_ENV_VALUE_LENGTH = 32 * 1024;
const MAX_DISABLED_SKILL_NAMES = 256;
const REMOTE_PROXY_ENVIRONMENT_NAMES = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
]);
const VERSION_OUTPUT = /^omp\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\r?\n$/u;

/**
 * OMP v18.1.18 的 `--version` 输出严格是 `omp/<semver>\n`。保持严格，
 * 避免把任意诊断输出当成受审可执行文件。
 */
export function parseOmpVersionOutput(output: string): string | undefined {
  if (typeof output !== 'string' || output.length > 256) return undefined;
  return VERSION_OUTPUT.exec(output)?.[1];
}

/** RPC 适配器只支持一个经审计的上游 tag。 */
export function isOmpCompatibilityBaseline(output: string): boolean {
  return parseOmpVersionOutput(output) === OMP_COMPATIBILITY_BASELINE;
}

function pathApi(platform: NodeJS.Platform): typeof path {
  return platform === 'win32' ? path.win32 : path.posix;
}

function requireAbsolutePath(
  value: string,
  name: string,
  implementation: typeof path,
): string {
  if (typeof value !== 'string' || !value || value.includes('\0'))
    throw new Error(`Invalid OMP ${name}`);
  // 不做 resolve：相对路径必须由调用方先钉成绝对路径,避免静默落到进程 cwd。
  if (!implementation.isAbsolute(value))
    throw new Error(`OMP ${name} must be an absolute non-root directory`);
  const resolved = implementation.normalize(value);
  if (resolved === implementation.parse(resolved).root)
    throw new Error(`OMP ${name} must be an absolute non-root directory`);
  return resolved;
}

function requireArgumentValue(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > MAX_ARGUMENT_VALUE_LENGTH ||
    value.includes('\0') ||
    value.startsWith('-') ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    throw new Error(`Invalid OMP ${name}`);
  }
  return value;
}

function requirePromptKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(value)
  ) {
    throw new Error('Invalid OMP system prompt key');
  }
  return value;
}

function requireEnvironmentValue(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > MAX_ENV_VALUE_LENGTH ||
    value.includes('\0') ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    throw new Error(`Invalid OMP ${name}`);
  }
  return value;
}

function optionalExecutableEnvironmentValue(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > MAX_EXECUTABLE_ENV_VALUE_LENGTH ||
    value.includes('\0') ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    throw new Error(`Invalid OMP executable environment ${name}`);
  }
  return value;
}

function normalizeDisabledSkillNames(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_DISABLED_SKILL_NAMES)
    throw new Error('Invalid OMP disabled skills');
  const names = new Set<string>();
  for (const candidate of value) {
    if (
      typeof candidate !== 'string' ||
      !candidate ||
      candidate.length > MAX_ARGUMENT_VALUE_LENGTH ||
      candidate.includes('\0') ||
      Array.from(candidate).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    ) {
      throw new Error('Invalid OMP disabled skill name');
    }
    names.add(candidate);
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

function requireWindowsSystemRoot(value: string | undefined): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > MAX_ENV_VALUE_LENGTH ||
    value.includes('\0') ||
    !path.win32.isAbsolute(value)
  ) {
    throw new Error('OMP requires a valid Windows system root');
  }
  return path.win32.normalize(value);
}

function descendant(root: string, child: string, implementation: typeof path): string {
  const relative = implementation.relative(root, child);
  if (!relative || relative.startsWith('..') || implementation.isAbsolute(relative))
    throw new Error('Invalid OMP managed root layout');
  return child;
}

function freezeRecord(values: Record<string, string>): Readonly<Record<string, string>> {
  return Object.freeze(Object.assign(Object.create(null), values));
}

/**
 * 校验可选的 provider/model 选择器。provider 缺省时 settings 仍钉住 Cindy block，
 * 因为 models.yml 里 Cindy provider 总是由 host 物化。
 */
export function validateOmpLaunchModel(model: unknown): OmpLaunchModel | undefined {
  if (model === undefined) return undefined;
  if (!model || typeof model !== 'object' || Array.isArray(model))
    throw new Error('Invalid OMP launch model');
  const candidate = model as Partial<OmpLaunchModel>;
  if (candidate.provider === undefined && candidate.model === undefined)
    throw new Error('Invalid OMP launch model');
  return Object.freeze({
    ...(candidate.provider === undefined
      ? {}
      : { provider: requireArgumentValue(candidate.provider, 'provider') }),
    ...(candidate.model === undefined
      ? {}
      : { model: requireArgumentValue(candidate.model, 'model') }),
  });
}

function settingsYaml(
  approvalMode: OmpApprovalMode,
  providers: readonly string[],
  disabledSkillNames: readonly string[],
): string {
  return [
    'startup:',
    '  setupWizard: false',
    '  checkUpdate: false',
    'tools:',
    // 与 --approval-mode 同值双写：OMP 上游默认 yolo，不能依赖任何一侧的默认值。
    `  approvalMode: ${approvalMode}`,
    'enabledProviders:',
    ...providers.map((provider) => `  - ${JSON.stringify(provider)}`),
    ...(disabledSkillNames.length === 0
      ? []
      : [
          'disabledExtensions:',
          ...disabledSkillNames.map((name) => `  - ${JSON.stringify(`skill:${name}`)}`),
        ]),
    '',
  ].join('\n');
}

/**
 * 构建**生产会话**启动计划（替代已删除的探测版 `createOmpIsolatedProbeLaunchPlan`）。
 *
 * 与探测版的差异：cwd 是真实项目目录；HOME 等根是持久受管目录（不是一次性沙箱）；
 * 不再带 `--no-session` / `--no-tools`（会话与工具是生产会话的本体）。
 * 函数保持纯：既不创建目录，也不启动进程。
 */
export function createOmpSessionLaunchPlan(
  input: OmpSessionLaunchPlanInput,
): OmpSessionLaunchPlan {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid OMP session launch input');
  const roots = input.roots;
  if (!roots || typeof roots !== 'object' || Array.isArray(roots))
    throw new Error('Invalid OMP session roots');
  const platform = roots.platform ?? process.platform;
  if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux')
    throw new Error('Unsupported OMP platform');
  const implementation = pathApi(platform);
  const home = requireAbsolutePath(roots.home, 'home', implementation);
  // 真实项目目录：不在 HOME 之下（否则 OMP 的项目插件上爬会一路爬到受管根）。
  const workingDir = requireAbsolutePath(roots.workingDir, 'working directory', implementation);
  const buildPath = (name: string) =>
    descendant(home, implementation.join(home, name), implementation);
  const config = descendant(
    home,
    implementation.join(home, OMP_CONFIG_DIR_NAME),
    implementation,
  );
  const agent = descendant(
    home,
    implementation.join(config, 'agent'),
    implementation,
  );
  const sessions =
    input.sessionDir === undefined
      ? descendant(home, implementation.join(agent, 'sessions'), implementation)
      : requireAbsolutePath(input.sessionDir, 'session directory', implementation);
  const temporary = buildPath('tmp');
  const settingsFile = descendant(
    home,
    implementation.join(agent, OMP_SETTINGS_FILE_NAME),
    implementation,
  );
  const modelsFile = descendant(
    home,
    implementation.join(agent, OMP_MODELS_FILE_NAME),
    implementation,
  );
  const globalSkillsDirectory = descendant(
    home,
    implementation.join(home, '.agents', 'skills'),
    implementation,
  );
  const systemPromptDirectory = descendant(
    home,
    implementation.join(agent, OMP_SYSTEM_PROMPT_DIRECTORY_NAME),
    implementation,
  );
  const systemPromptKey =
    input.appendSystemPromptKey === undefined
      ? undefined
      : requirePromptKey(input.appendSystemPromptKey);
  const systemPromptFile = systemPromptKey === undefined
    ? undefined
    : descendant(
        home,
        implementation.join(systemPromptDirectory, `${systemPromptKey}.md`),
        implementation,
      );

  const approvalMode = resolveOmpApprovalMode(input.permissionMode).approvalMode;
  const model = validateOmpLaunchModel(input.model);
  const disabledSkillNames = normalizeDisabledSkillNames(input.disabledSkillNames);

  const environment: Record<string, string> = {
    HOME: home,
    PI_CONFIG_DIR: OMP_CONFIG_DIR_NAME,
    PI_CODING_AGENT_DIR: agent,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    XDG_CONFIG_HOME: buildPath('.config'),
    XDG_DATA_HOME: buildPath('.local/share'),
    XDG_STATE_HOME: buildPath('.local/state'),
    XDG_CACHE_HOME: buildPath('.cache'),
  };
  if (platform === 'win32') {
    const parsedHome = implementation.parse(home);
    environment.USERPROFILE = home;
    environment.HOMEDRIVE = parsedHome.root.replace(/[\\/]$/u, '');
    environment.HOMEPATH = `\\${home.slice(parsedHome.root.length)}`;
    environment.APPDATA = buildPath('appdata');
    environment.LOCALAPPDATA = buildPath('localappdata');
    const systemRoot = requireWindowsSystemRoot(roots.windowsSystemRoot);
    environment.SystemRoot = systemRoot;
    environment.WINDIR = systemRoot;
  }

  const executableEnvironment = input.executableEnvironment;
  if (executableEnvironment !== undefined) {
    if (
      !executableEnvironment ||
      typeof executableEnvironment !== 'object' ||
      Array.isArray(executableEnvironment)
    ) {
      throw new Error('Invalid OMP executable environment');
    }
    const executable = executableEnvironment as OmpSessionExecutableEnvironment;
    const pathValue = optionalExecutableEnvironmentValue(executable.path, 'PATH');
    if (pathValue !== undefined) environment.PATH = pathValue;
    const shell = optionalExecutableEnvironmentValue(executable.shell, 'SHELL');
    if (shell !== undefined) environment.SHELL = shell;
    const term = optionalExecutableEnvironmentValue(executable.term, 'TERM');
    if (term !== undefined) environment.TERM = term;
    const colorTerm = optionalExecutableEnvironmentValue(executable.colorTerm, 'COLORTERM');
    if (colorTerm !== undefined) environment.COLORTERM = colorTerm;
    const lang = optionalExecutableEnvironmentValue(executable.lang, 'LANG');
    if (lang !== undefined) environment.LANG = lang;
    const lcCtype = optionalExecutableEnvironmentValue(executable.lcCtype, 'LC_CTYPE');
    if (lcCtype !== undefined) environment.LC_CTYPE = lcCtype;
    if (platform === 'win32') {
      const comSpec = optionalExecutableEnvironmentValue(executable.comSpec, 'ComSpec');
      if (comSpec !== undefined) environment.ComSpec = comSpec;
      const pathext = optionalExecutableEnvironmentValue(executable.pathext, 'PATHEXT');
      if (pathext !== undefined) environment.PATHEXT = pathext;
    }
  }

  if (input.remoteProxyEnvironment !== undefined) {
    const proxyEnvironment = input.remoteProxyEnvironment;
    if (
      !proxyEnvironment ||
      typeof proxyEnvironment !== 'object' ||
      Array.isArray(proxyEnvironment)
    ) {
      throw new Error('Invalid OMP remote proxy environment');
    }
    for (const [name, value] of Object.entries(proxyEnvironment)) {
      if (!REMOTE_PROXY_ENVIRONMENT_NAMES.has(name))
        throw new Error('Invalid OMP remote proxy environment');
      environment[name] = requireEnvironmentValue(value, 'remote proxy ' + name);
    }
  }

  // 凭证只进子进程 env；models.yml 里 apiKey 写的是 env 名，文件内不含密钥。
  const credentials = input.credentials;
  if (credentials !== undefined) {
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials))
      throw new Error('Invalid OMP session credentials');
    if (credentials.proxyKey !== undefined)
      environment[OMP_CINDY_API_KEY_ENV] = requireEnvironmentValue(
        credentials.proxyKey,
        'proxy key',
      );
    if (credentials.sessionId !== undefined)
      environment[OMP_CINDY_SESSION_ID_ENV] = requireEnvironmentValue(
        credentials.sessionId,
        'session id',
      );
    if (credentials.sessionToken !== undefined)
      environment[OMP_CINDY_SESSION_TOKEN_ENV] = requireEnvironmentValue(
        credentials.sessionToken,
        'session token',
      );
  }

  const argv: string[] = [
    '--mode',
    'rpc',
    '--config',
    settingsFile,
    '--approval-mode',
    approvalMode,
    // Lex owns task titles; all other native project capability discovery stays enabled.
    '--no-title',
  ];
  if (input.sessionDir !== undefined) argv.push('--session-dir', sessions);
  // OMP accepts a file path for --append-system-prompt.  Keep prompt bytes out
  // of process listings and preserve the stable argv prefix for prompt caching.
  if (systemPromptFile !== undefined) argv.push('--append-system-prompt', systemPromptFile);
  if (model?.provider !== undefined) argv.push('--provider', model.provider);
  if (model?.model !== undefined) argv.push('--model', model.model);

  // The Lex source-provider is transported as a managed proxy header rather
  // than exposed as a second native OMP provider. OMP sees only the host-owned
  // Cindy definition from models.yml.
  const providers = [OMP_CINDY_PROVIDER_ID];

  return Object.freeze({
    roots: Object.freeze({
      home,
      config,
      agent,
      sessions,
      workingDir,
      temporary,
      settingsFile,
      modelsFile,
      globalSkillsDirectory,
      systemPromptDirectory,
      ...(systemPromptFile === undefined ? {} : { systemPromptFile }),
    }),
    approvalMode,
    settingsYaml: settingsYaml(approvalMode, providers, disabledSkillNames),
    arguments: Object.freeze(argv),
    environment: freezeRecord(environment),
  });
}
