import { spawn } from 'node:child_process';
import path from 'node:path';
import type { MakeSourceGitProgress } from '../../shared/cindyMakeDoctor.js';

export function parseSourceGitProgress(line: string): MakeSourceGitProgress | undefined {
  const match =
    /(?:^|remote:\s*)(Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files):\s+(\d{1,3})%/.exec(
      line.trim(),
    );
  if (!match || Number(match[2]) > 100) return undefined;
  const stages: Record<string, MakeSourceGitProgress['stage']> = {
    'Counting objects': 'counting',
    'Compressing objects': 'compressing',
    'Receiving objects': 'receiving',
    'Resolving deltas': 'resolving',
    'Updating files': 'checkingOut',
  };
  return { stage: stages[match[1]], percent: Number(match[2]) };
}

function gitFailure(message: string): Error & { code: 'gitFailed' } {
  return Object.assign(new Error(message), { code: 'gitFailed' as const });
}

// Cindy Make proves Git topology before allowing host-owned commits.  An
// inherited Git override must not redirect those checks to a different index,
// object store, or repository.  Keep ordinary user Git configuration intact:
// these are only process-environment overrides, not the user's normal config.
const GIT_REPOSITORY_OVERRIDE_VARIABLES = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_EXEC_PATH',
  'GIT_TEMPLATE_DIR',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_SSL_NO_VERIFY',
]);

function isGitRepositoryOverrideVariable(key: string): boolean {
  const normalized = key.toUpperCase();
  return (
    GIT_REPOSITORY_OVERRIDE_VARIABLES.has(normalized) ||
    /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(normalized)
  );
}

function replaceEnvironmentVariable(
  environment: NodeJS.ProcessEnv,
  key: string,
  value: string,
): void {
  // Windows treats environment names case-insensitively.  Removing an existing
  // spelling first also makes the intended value unambiguous on POSIX.
  for (const existing of Object.keys(environment)) {
    if (existing.toUpperCase() === key) delete environment[existing];
  }
  environment[key] = value;
}

/** Build the bounded environment used for every host-owned Cindy Make Git command. */
export function makeSourceGitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...env };
  for (const key of Object.keys(environment)) {
    if (isGitRepositoryOverrideVariable(key)) delete environment[key];
  }
  replaceEnvironmentVariable(environment, 'LC_ALL', 'C');
  replaceEnvironmentVariable(environment, 'LANG', 'C');
  replaceEnvironmentVariable(environment, 'GIT_TERMINAL_PROMPT', '0');
  return environment;
}

function quoteWindowsBatchArgument(argument: string): string | null {
  if (/["%\r\n!^&|<>]/.test(argument)) return null;
  if (argument.length === 0) return '""';
  if (!/\s/.test(argument)) return argument;
  // cmd itself does not treat backslash as a quote escape, but the subsequent
  // Windows argument parser does. Double a trailing run before the close quote.
  return `"${argument.replace(/(\\+)$/u, '$1$1')}"`;
}

function windowsCommandProcessor(environment: NodeJS.ProcessEnv): string | null {
  const systemRoot = Object.entries(environment).find(
    ([key]) => key.toUpperCase() === 'SYSTEMROOT' || key.toUpperCase() === 'WINDIR',
  )?.[1];
  return typeof systemRoot === 'string' &&
    path.isAbsolute(systemRoot) &&
    !/[\0\r\n]/.test(systemRoot)
    ? path.join(systemRoot, 'System32', 'cmd.exe')
    : null;
}

/** Drain progress without buffering an entire clone log or passing raw Git output to the UI. */
export async function runSourceGit(
  gitExecutable: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  onProgress?: (progress: MakeSourceGitProgress) => void,
): Promise<string> {
  signal.throwIfAborted();
  if (
    !path.isAbsolute(gitExecutable) ||
    /[\0\r\n]/.test(gitExecutable) ||
    !path.isAbsolute(cwd) ||
    /[\0\r\n]/.test(cwd) ||
    args.some((arg) => typeof arg !== 'string' || /[\0\r\n]/.test(arg))
  ) {
    throw gitFailure('invalid Git source launch');
  }
  return new Promise((resolve, reject) => {
    const environment = makeSourceGitEnvironment(env);
    const batch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(gitExecutable);
    const commandProcessor = batch ? windowsCommandProcessor(environment) : null;
    const encodedArgs = batch ? args.map(quoteWindowsBatchArgument) : undefined;
    if (
      batch &&
      (!encodedArgs ||
        !commandProcessor ||
        encodedArgs.some((argument) => argument === null) ||
        /["%\r\n!^&|<>]/.test(gitExecutable))
    ) {
      reject(gitFailure('unsafe Git batch launch'));
      return;
    }
    const child = batch
      ? spawn(
          commandProcessor!,
          ['/d', '/s', '/c', `""${gitExecutable}" ${(encodedArgs as string[]).join(' ')}"`],
          {
            cwd,
            env: environment,
            windowsHide: true,
            windowsVerbatimArguments: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            signal,
          },
        )
      : spawn(gitExecutable, args, {
          cwd,
          env: environment,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          signal,
        });
    let stdout = '';
    let stderrTail = '';
    let failed = false;
    let latest: MakeSourceGitProgress | undefined;
    let sent: MakeSourceGitProgress | undefined;
    let lastSent = 0;
    const publish = () => {
      if (!latest || (sent?.stage === latest.stage && sent.percent === latest.percent)) return;
      onProgress?.(latest);
      sent = latest;
      lastSent = Date.now();
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (failed) return;
      stdout += chunk;
      if (stdout.length > 64 * 1024) {
        failed = true;
        child.kill();
      }
    });
    child.stderr.on('data', (chunk: string) => {
      const lines = (stderrTail + chunk).split(/[\r\n]/);
      stderrTail = (lines.pop() ?? '').slice(-1024);
      for (const line of lines) {
        const progress = parseSourceGitProgress(line);
        if (!progress) continue;
        latest = progress;
        if (
          sent?.stage !== progress.stage ||
          progress.percent === 100 ||
          Date.now() - lastSent >= 200
        )
          publish();
      }
    });
    child.on('error', () => {
      failed = true;
    });
    // Wait for close, including abort/error paths, before another operation can touch the checkout.
    child.on('close', (code) => {
      if (signal.aborted || failed || code !== 0) {
        reject(
          Object.assign(new Error('Git source operation failed'), {
            code: signal.aborted ? 'cancelled' : 'gitFailed',
          }),
        );
        return;
      }
      latest = parseSourceGitProgress(stderrTail) ?? latest;
      publish();
      resolve(stdout.trim());
    });
  });
}
