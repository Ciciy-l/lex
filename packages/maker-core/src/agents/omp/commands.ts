export const OMP_COMPATIBILITY_BASELINE = '18.1.18';

export type OmpCommandSource =
  'builtin' | 'skill' | 'extension' | 'custom' | 'mcp_prompt' | 'file';

export interface OmpCommand {
  name: string;
  aliases: readonly string[];
  description?: string;
  input?: { hint?: string };
  subcommands: readonly {
    name: string;
    description?: string;
    usage?: string;
  }[];
  source: OmpCommandSource;
}

/**
 * Both `get_available_commands` responses and pushed
 * `available_commands_update` frames carry a command array.  Keep the wire
 * envelope handling in one place so the session bridge cannot accidentally
 * validate one form while accepting a different one.
 */
export function readOmpCommandCatalogPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (isOmpRecord(value) && Array.isArray(value.commands)) return value.commands;
  throw new Error('Invalid OMP command catalog');
}

export function isOmpRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, limit: number): string {
  if (
    typeof value !== 'string' ||
    value.length > limit ||
    value.includes('\0')
  ) {
    throw new Error('Invalid OMP command metadata');
  }
  return value;
}

function commandName(value: unknown, allowInternalSpaces = false): string {
  const name = text(value, 256);
  if (
    !name ||
    name !== name.trim() ||
    name.includes('/') ||
    (!allowInternalSpaces && name.includes(' ')) ||
    (allowInternalSpaces && name.includes('  ')) ||
    Array.from(name).some(
      (char) => (char !== ' ' && /\s/u.test(char))
        || char.charCodeAt(0) < 32
        || char.charCodeAt(0) === 127,
    )
  )
    throw new Error('Invalid OMP command name');
  return name;
}

function matchesAsciiSpaceInvocationName(input: string, name: string): boolean {
  return input === name || (input.startsWith(name) && input.charAt(name.length) === ' ');
}

function optionalText(value: unknown): string | undefined {
  return value === undefined ? undefined : text(value, 8192);
}

export function parseOmpCommands(value: unknown): readonly OmpCommand[] {
  if (!Array.isArray(value) || value.length > 2048)
    throw new Error('Invalid OMP command catalog');
  const names = new Set<string>();
  const sources: readonly unknown[] = [
    'builtin',
    'skill',
    'extension',
    'custom',
    'mcp_prompt',
    'file',
  ];
  return Object.freeze(
    value.map((entry): OmpCommand => {
      if (!isOmpRecord(entry) || !sources.includes(entry.source))
        throw new Error('Unsupported OMP command metadata');
      const source = entry.source as OmpCommandSource;
      // The pinned native catalog legitimately includes multi-word commands
      // such as `mm list`. Permit only ASCII-separated words in every command
      // metadata field while still rejecting path separators and invisible
      // whitespace. The names are opaque native syntax, not host commands.
      const name = commandName(entry.name, true);
      if (names.has(name)) throw new Error('Duplicate OMP command name');
      names.add(name);
      const aliases = entry.aliases ?? [];
      const subcommands = entry.subcommands ?? [];
      if (
        !Array.isArray(aliases) ||
        aliases.length > 64 ||
        !Array.isArray(subcommands) ||
        subcommands.length > 256
      ) {
        throw new Error('Invalid OMP command metadata');
      }
      if (entry.input !== undefined && !isOmpRecord(entry.input))
        throw new Error('Invalid OMP command input');
      return Object.freeze({
        name,
        aliases: Object.freeze(aliases.map((alias) => commandName(alias, true))),
        description: optionalText(entry.description),
        input:
          entry.input === undefined
            ? undefined
            : Object.freeze({ hint: optionalText(entry.input.hint) }),
        subcommands: Object.freeze(
          subcommands.map((subcommand) => {
            if (!isOmpRecord(subcommand))
              throw new Error('Invalid OMP subcommand');
            return Object.freeze({
              name: commandName(subcommand.name, true),
              description: optionalText(subcommand.description),
              usage: optionalText(subcommand.usage),
            });
          }),
        ),
        source,
      });
    }),
  );
}

export interface OmpCatalogSnapshot {
  status: 'unknown' | 'loaded' | 'failed';
  commands: readonly OmpCommand[];
}

export class OmpCommandCatalog {
  /** Fences asynchronous reads from push updates and disconnects. */
  private revision = 0;
  /** Changes only when the externally visible snapshot changes. */
  private snapshotRevision = 0;
  private readonly owner = Symbol('omp-catalog');
  private readonly listeners = new Set<(snapshot: OmpCatalogSnapshot, revision: number) => void>();
  private snapshot: OmpCatalogSnapshot = Object.freeze({
    status: 'unknown',
    commands: Object.freeze([]),
  });

  getSnapshot(): OmpCatalogSnapshot {
    return this.snapshot;
  }

  /** Monotonic revision of `getSnapshot()`, suitable for UI invalidation only. */
  getRevision(): number {
    return this.snapshotRevision;
  }

  /**
   * Subscribe to native catalog replacement. New subscribers synchronously see
   * the current snapshot, so a listener wired after an early RPC response
   * cannot miss it. A consumer exception must never interrupt OMP frame flow.
   */
  subscribe(listener: (snapshot: OmpCatalogSnapshot, revision: number) => void): () => void {
    this.listeners.add(listener);
    this.notify(listener);
    return () => this.listeners.delete(listener);
  }

  beginRead(): { owner: symbol; revision: number } {
    return { owner: this.owner, revision: ++this.revision };
  }

  completeRead(
    ticket: { owner: symbol; revision: number },
    commands: unknown,
  ): boolean {
    if (ticket.owner !== this.owner || ticket.revision !== this.revision)
      return false;
    this.replace(commands);
    return true;
  }

  failRead(ticket: { owner: symbol; revision: number }): void {
    if (ticket.owner === this.owner && ticket.revision === this.revision)
      this.invalidate('failed');
  }

  replace(commands: unknown): void {
    ++this.revision;
    try {
      this.snapshot = Object.freeze({
        status: 'loaded',
        commands: parseOmpCommands(commands),
      });
      this.publish();
    } catch (error) {
      this.invalidate('failed');
      throw error;
    }
  }

  invalidate(status: 'unknown' | 'failed' = 'unknown'): void {
    ++this.revision;
    this.snapshot = Object.freeze({ status, commands: Object.freeze([]) });
    this.publish();
  }

  private publish(): void {
    this.snapshotRevision += 1;
    for (const listener of this.listeners) this.notify(listener);
  }

  private notify(listener: (snapshot: OmpCatalogSnapshot, revision: number) => void): void {
    try {
      listener(this.snapshot, this.snapshotRevision);
    } catch {
      // A palette observer is never allowed to stop the RPC/frame processing path.
    }
  }

  resolve(message: string): OmpCommand | undefined {
    if (this.snapshot.status !== 'loaded') return undefined;
    const trimmed = message.trimStart();
    if (trimmed.startsWith('/skill:')) {
      const invocation = trimmed.slice(1).split(' ', 1)[0];
      return this.snapshot.commands.find(
        (command) => command.source === 'skill' && command.name === invocation,
      );
    }
    if (!message.startsWith('/')) return undefined;
    const builtinName = message.slice(1).split(/[\s:]/u, 1)[0];
    const builtins = this.snapshot.commands.filter(
      (command) =>
        command.source === 'builtin' &&
        (command.name === builtinName || command.aliases.includes(builtinName)),
    );
    if (builtins.length > 0)
      return builtins.length === 1 ? builtins[0] : undefined;

    const invocation = message.slice(1);
    const multiWordBuiltins = this.snapshot.commands.filter(
      (command) =>
        command.source === 'builtin'
        && command.name.includes(' ')
        && matchesAsciiSpaceInvocationName(invocation, command.name),
    );
    if (multiWordBuiltins.length > 0) {
      const longest = Math.max(...multiWordBuiltins.map((command) => command.name.length));
      const candidates = multiWordBuiltins.filter((command) => command.name.length === longest);
      return candidates.length === 1 ? candidates[0] : undefined;
    }
    const multiWordMatches = this.snapshot.commands.filter(
      (command) =>
        command.source !== 'builtin'
        && command.source !== 'skill'
        && command.name.includes(' ')
        && matchesAsciiSpaceInvocationName(invocation, command.name),
    );
    if (multiWordMatches.length > 0) {
      const longest = Math.max(...multiWordMatches.map((command) => command.name.length));
      const candidates = multiWordMatches.filter((command) => command.name.length === longest);
      return candidates.length === 1 ? candidates[0] : undefined;
    }

    const singleToken = message.slice(1).split(' ', 1)[0];
    return this.snapshot.commands.find(
      (command) =>
        command.source !== 'builtin' &&
        command.source !== 'skill' &&
        command.name === singleToken,
    );
  }
}
