import { describe, expect, it } from 'vitest';
import {
  OmpCommandCatalog,
  parseOmpCommands,
  readOmpCommandCatalogPayload,
} from './commands.js';

const command = (name = 'model', extra: Record<string, unknown> = {}) => ({
  name,
  source: 'builtin',
  ...extra,
});

describe('OMP command catalog', () => {
  it('accepts only the documented response/push command envelopes', () => {
    const commands = [command('compact')];
    expect(readOmpCommandCatalogPayload(commands)).toBe(commands);
    expect(readOmpCommandCatalogPayload({ commands })).toBe(commands);
    expect(() => readOmpCommandCatalogPayload({ command: commands })).toThrow(
      'Invalid OMP command catalog',
    );
  });

  it.each(['builtin', 'skill', 'extension', 'custom', 'mcp_prompt', 'file'])(
    'retains %s runtime metadata',
    (source) => {
      const parsed = parseOmpCommands([
        command('plan', {
          source,
          aliases: ['p'],
          description: 'Plan work',
          input: { hint: 'instructions' },
          subcommands: [
            { name: 'off', description: 'Stop planning', usage: '/plan off' },
          ],
        }),
      ]);
      expect(parsed[0]).toEqual({
        name: 'plan',
        source,
        aliases: ['p'],
        description: 'Plan work',
        input: { hint: 'instructions' },
        subcommands: [
          { name: 'off', description: 'Stop planning', usage: '/plan off' },
        ],
      });
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(Object.isFrozen(parsed[0].subcommands[0])).toBe(true);
    },
  );

  it.each([
    null,
    {},
    [command('/model')],
    [command(' bad-name')],
    [command('bad-name ')],
    [command('bad  name')],
    [command('bad\tname')],
    [command('')],
    [command('model', { source: 'future-source' })],
    [command(), command()],
    [command('model', { aliases: 'model' })],
    [command('model', { subcommands: [null] })],
    [command('model', { input: 'hint' })],
    [command('model', { description: 'x'.repeat(8193) })],
    Array.from({ length: 2049 }, (_, index) => command('command' + index)),
  ])('rejects an invalid catalog atomically: %j', (value) => {
    expect(() => parseOmpCommands(value)).toThrow();
  });

  it('accepts and resolves upstream multi-word native command names', () => {
    const catalog = new OmpCommandCatalog();
    catalog.replace([command('mm list')]);

    expect(catalog.getSnapshot()).toMatchObject({
      status: 'loaded',
      commands: [{ name: 'mm list' }],
    });
    expect(catalog.resolve('/mm list')).toMatchObject({ name: 'mm list' });
    expect(catalog.resolve('/mm list installed')).toMatchObject({ name: 'mm list' });
    expect(catalog.resolve('/mm')).toBeUndefined();
  });

  it('preserves skill namespaces and native spelling without Pi alias rewriting', () => {
    const catalog = new OmpCommandCatalog();
    catalog.replace([
      command('skill:Build', { source: 'skill', aliases: ['build'] }),
    ]);
    expect(
      catalog.resolve('  /skill:Build keep  spaces\nnext line')?.name,
    ).toBe('skill:Build');
    expect(catalog.resolve('/build argument')).toBeUndefined();
    expect(catalog.resolve('/skill:build')).toBeUndefined();
    expect(catalog.resolve('text /build')).toBeUndefined();
    expect(catalog.resolve('/missing')).toBeUndefined();
  });

  it('refuses ambiguous builtin primary-name and alias collisions', () => {
    const catalog = new OmpCommandCatalog();
    catalog.replace([
      command('first', { aliases: ['shared', 'second'] }),
      command('second', { aliases: ['shared'] }),
    ]);
    expect(catalog.resolve('/second')).toBeUndefined();
    expect(catalog.resolve('/shared')).toBeUndefined();
  });

  it('does not let a pending read overwrite a pushed command update', () => {
    const catalog = new OmpCommandCatalog();
    const pending = catalog.beginRead();
    catalog.replace([command('new')]);
    expect(catalog.completeRead(pending, [command('old')])).toBe(false);
    catalog.failRead(pending);
    expect(catalog.resolve('/new')?.name).toBe('new');
  });

  it('replays and publishes catalog snapshots without letting one observer block another', () => {
    const catalog = new OmpCommandCatalog();
    const observed: Array<{ revision: number; status: string; names: string[] }> = [];
    const dispose = catalog.subscribe((snapshot, revision) => {
      observed.push({
        revision,
        status: snapshot.status,
        names: snapshot.commands.map((entry) => entry.name),
      });
    });
    catalog.subscribe(() => {
      throw new Error('observer failure must be isolated');
    });

    catalog.replace([command('compact')]);
    catalog.invalidate('failed');
    dispose();
    catalog.replace([command('model')]);

    expect(observed).toEqual([
      { revision: 0, status: 'unknown', names: [] },
      { revision: 1, status: 'loaded', names: ['compact'] },
      { revision: 2, status: 'failed', names: [] },
    ]);
  });

  it('rejects superseded, reused, cross-session and pre-disconnect read tickets', () => {
    const catalog = new OmpCommandCatalog();
    const old = catalog.beginRead();
    const latest = catalog.beginRead();
    expect(catalog.completeRead(old, [command('old')])).toBe(false);
    expect(catalog.completeRead(latest, [command('new')])).toBe(true);
    expect(catalog.completeRead(latest, [command('old')])).toBe(false);
    const other = new OmpCommandCatalog();
    expect(catalog.completeRead(other.beginRead(), [command()])).toBe(false);
    const beforeDisconnect = catalog.beginRead();
    catalog.invalidate();
    expect(catalog.completeRead(beforeDisconnect, [command()])).toBe(false);
    expect(catalog.getSnapshot()).toEqual({ status: 'unknown', commands: [] });
  });

  it('invalid updates revoke stale executable commands', () => {
    const catalog = new OmpCommandCatalog();
    catalog.replace([command()]);
    expect(() =>
      catalog.replace([command('unsafe', { source: 'unknown' })]),
    ).toThrow();
    expect(catalog.getSnapshot()).toEqual({ status: 'failed', commands: [] });
    expect(catalog.resolve('/model')).toBeUndefined();
    catalog.completeRead(catalog.beginRead(), []);
    expect(catalog.getSnapshot()).toEqual({ status: 'loaded', commands: [] });
  });
});
