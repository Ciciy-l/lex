import path from 'node:path';
import { OMP_COMPATIBILITY_BASELINE } from './commands.js';

export const OMP_PROBE_SETTINGS_FILE = 'omp-probe-settings.yaml';
/** OMP interprets PI_CONFIG_DIR as a directory name below HOME, not a path. */
export const OMP_PROBE_CONFIG_DIR_NAME = '.omp';

export interface OmpIsolatedRoots {
  /** A host-created, unique and otherwise empty directory for one probe. */
  sandboxRoot: string;
  platform?: NodeJS.Platform;
  /** Windows needs this non-secret OS runtime path even with a fresh environment. */
  windowsSystemRoot?: string;
}

export interface OmpProbeModel {
  provider: string;
  model: string;
}

export interface OmpProbeLaunchPlan {
  readonly roots: Readonly<{
    sandboxRoot: string;
    home: string;
    config: string;
    agent: string;
    workingDirectory: string;
    temporary: string;
    settingsFile: string;
  }>;
  /**
   * This is a deliberately small overlay, not an allowlist for OMP discovery.
   * The host must create every root empty before it starts the process.
   */
  readonly settingsYaml: string;
  /** Exact argv for an isolated, no-prompt RPC capability probe. */
  readonly arguments: readonly string[];
  /** A fresh environment, never a clone of the parent process environment. */
  readonly environment: Readonly<Record<string, string>>;
}

const MAX_ARGUMENT_VALUE_LENGTH = 512;
const VERSION_OUTPUT = /^omp\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\r?\n$/u;

/**
 * OMP v18.1.18 prints exactly `omp/<semver>\\n` for `--version`. Keeping this
 * strict avoids treating arbitrary diagnostic output as a vetted executable.
 */
export function parseOmpVersionOutput(output: string): string | undefined {
  if (typeof output !== 'string' || output.length > 256) return undefined;
  return VERSION_OUTPUT.exec(output)?.[1];
}

/** The initial RPC adapter intentionally supports one audited upstream tag. */
export function isOmpCompatibilityBaseline(output: string): boolean {
  return parseOmpVersionOutput(output) === OMP_COMPATIBILITY_BASELINE;
}

function pathApi(platform: NodeJS.Platform): typeof path {
  return platform === 'win32' ? path.win32 : path.posix;
}

function requireAbsolutePath(value: string, name: string, implementation: typeof path): string {
  if (typeof value !== 'string' || !value || value.includes('\0'))
    throw new Error(`Invalid OMP ${name}`);
  const resolved = implementation.resolve(value);
  if (!implementation.isAbsolute(resolved) || resolved === implementation.parse(resolved).root)
    throw new Error(`OMP ${name} must be an absolute non-root directory`);
  return resolved;
}

function requireArgumentValue(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > MAX_ARGUMENT_VALUE_LENGTH ||
    value.includes('\0') ||
    value.startsWith('-')
  ) {
    throw new Error(`Invalid OMP ${name}`);
  }
  return value;
}

/**
 * Validates the optional model selector before a probe can materialize any
 * filesystem state. Keep the launch-plan call below as a second boundary: it
 * is also used directly by the sandbox materializer.
 */
export function validateOmpProbeModel(model: unknown): OmpProbeModel | undefined {
  if (model === undefined) return undefined;
  if (!model || typeof model !== 'object' || Array.isArray(model))
    throw new Error('Invalid OMP probe model');
  const candidate = model as Partial<OmpProbeModel>;
  return Object.freeze({
    provider: requireArgumentValue(candidate.provider, 'probe provider'),
    model: requireArgumentValue(candidate.model, 'probe model'),
  });
}

function requireWindowsSystemRoot(value: string | undefined): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 4096 ||
    value.includes('\0') ||
    !path.win32.isAbsolute(value)
  ) {
    throw new Error('OMP probe requires a valid Windows system root');
  }
  return path.win32.normalize(value);
}

function descendant(root: string, child: string, implementation: typeof path): string {
  const relative = implementation.relative(root, child);
  if (!relative || relative.startsWith('..') || implementation.isAbsolute(relative))
    throw new Error('Invalid OMP isolated root layout');
  return child;
}

function freezeRecord(values: Record<string, string>): Readonly<Record<string, string>> {
  return Object.freeze(Object.assign(Object.create(null), values));
}

/**
 * Builds a deliberately restricted launch plan for a one-shot OMP RPC probe.
 *
 * OMP's fixed v18.1.18 startup eagerly reads home/config/agent/project dotenv
 * files before its normal settings layer. Therefore this is only safe when the
 * Desktop host supplies a newly created, empty sandbox root. The function is
 * intentionally pure: it neither creates the directories nor starts a process.
 */
export function createOmpIsolatedProbeLaunchPlan(
  input: OmpIsolatedRoots,
  model?: OmpProbeModel,
): OmpProbeLaunchPlan {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid OMP isolated roots');
  const platform = input.platform ?? process.platform;
  if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux')
    throw new Error('Unsupported OMP platform');
  const implementation = pathApi(platform);
  const sandboxRoot = requireAbsolutePath(input.sandboxRoot, 'sandbox root', implementation);
  const buildPath = (name: string) =>
    descendant(sandboxRoot, implementation.join(sandboxRoot, name), implementation);
  const home = buildPath('home');
  const config = descendant(
    sandboxRoot,
    implementation.join(home, OMP_PROBE_CONFIG_DIR_NAME),
    implementation,
  );
  const agent = buildPath('agent');
  // OMP's project-plugin registry walk climbs from cwd until HOME. Keep this
  // below the fresh HOME so it cannot continue through the host temp parent.
  const workingDirectory = descendant(
    sandboxRoot,
    implementation.join(home, 'workdir'),
    implementation,
  );
  const temporary = buildPath('tmp');
  const settingsFile = descendant(
    sandboxRoot,
    implementation.join(sandboxRoot, OMP_PROBE_SETTINGS_FILE),
    implementation,
  );

  const environment: Record<string, string> = {
    HOME: home,
    PI_CONFIG_DIR: OMP_PROBE_CONFIG_DIR_NAME,
    PI_CODING_AGENT_DIR: agent,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    XDG_CONFIG_HOME: buildPath('xdg-config'),
    XDG_DATA_HOME: buildPath('xdg-data'),
    XDG_STATE_HOME: buildPath('xdg-state'),
    XDG_CACHE_HOME: buildPath('xdg-cache'),
  };
  if (platform === 'win32') {
    const parsedHome = implementation.parse(home);
    environment.USERPROFILE = home;
    environment.HOMEDRIVE = parsedHome.root.replace(/[\\/]$/u, '');
    environment.HOMEPATH = `\\${home.slice(parsedHome.root.length)}`;
    environment.APPDATA = buildPath('appdata');
    environment.LOCALAPPDATA = buildPath('localappdata');
    const systemRoot = requireWindowsSystemRoot(input.windowsSystemRoot);
    environment.SystemRoot = systemRoot;
    environment.WINDIR = systemRoot;
  }

  const argv = [
    '--mode',
    'rpc',
    '--config',
    settingsFile,
    '--no-session',
    '--no-tools',
    '--no-extensions',
    '--no-skills',
    '--no-rules',
    '--no-lsp',
    '--no-pty',
    '--no-title',
    '--approval-mode',
    'always-ask',
  ];
  const validatedModel = validateOmpProbeModel(model);
  if (validatedModel) {
    argv.push('--provider', validatedModel.provider, '--model', validatedModel.model);
  }

  return Object.freeze({
    roots: Object.freeze({
      sandboxRoot,
      home,
      config,
      agent,
      workingDirectory,
      temporary,
      settingsFile,
    }),
    settingsYaml: [
      'startup:',
      '  setupWizard: false',
      '  checkUpdate: false',
      'mcp:',
      '  enableProjectConfig: false',
      'tools:',
      '  approvalMode: always-ask',
      'enabledProviders: []',
      '',
    ].join('\n'),
    arguments: Object.freeze(argv),
    environment: freezeRecord(environment),
  });
}
