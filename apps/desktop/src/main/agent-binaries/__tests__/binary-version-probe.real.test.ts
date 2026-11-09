import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { probeBinaryVersion } from '../binary-version-probe.js';

const PROBE_DIR_PREFIX = 'cindy-version-probe-';

describe('binary version probe (real spawn)', () => {
  it('spawns the current runtime and cleans its temporary Codex home', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lex-probe-test-'));
    const tmpdirSpy = vi.spyOn(os, 'tmpdir').mockReturnValue(root);
    try {
      await expect(probeBinaryVersion(process.execPath)).resolves.toMatch(/^\d+\.\d+\.\d+/);

      const entries = await fs.readdir(root, { withFileTypes: true });
      const leftovers = entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(PROBE_DIR_PREFIX))
        .map((entry) => entry.name);
      expect(leftovers).toEqual([]);
    } finally {
      tmpdirSpy.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
