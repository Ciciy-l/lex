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

function commandName(value: unknown): string {
  const name = text(value, 256);
  if (
    !name ||
    /[\s/]/u.test(name) ||
    Array.from(name).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    throw new Error('Invalid OMP command name');
  return name;
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
      const name = commandName(entry.name);
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
        aliases: Object.freeze(aliases.map(commandName)),
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
              name: commandName(subcommand.name),
              description: optionalText(subcommand.description),
              usage: optionalText(subcommand.usage),
            });
          }),
        ),
        source: entry.source as OmpCommandSource,
      });
    }),
  );
}

export interface OmpCatalogSnapshot {
  status: 'unknown' | 'loaded' | 'failed';
  commands: readonly OmpCommand[];
}

export class OmpCommandCatalog {
  private revision = 0;
  private readonly owner = Symbol('omp-catalog');
  private snapshot: OmpCatalogSnapshot = Object.freeze({
    status: 'unknown',
    commands: Object.freeze([]),
  });

  getSnapshot(): OmpCatalogSnapshot {
    return this.snapshot;
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
    } catch (error) {
      this.invalidate('failed');
      throw error;
    }
  }

  invalidate(status: 'unknown' | 'failed' = 'unknown'): void {
    ++this.revision;
    this.snapshot = Object.freeze({ status, commands: Object.freeze([]) });
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
    const invocation = message.slice(1).split(' ', 1)[0];
    return this.snapshot.commands.find(
      (command) =>
        command.source !== 'builtin' &&
        command.source !== 'skill' &&
        command.name === invocation,
    );
  }
}
