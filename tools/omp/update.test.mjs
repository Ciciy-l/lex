import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  OMP_COMPATIBILITY_BASELINE,
  assertPinnedRuntimeAsset,
  isVerifiedRuntimeFile,
  readPinnedVersion,
} from './update.mjs';

const pin = {
  version: OMP_COMPATIBILITY_BASELINE,
  tag_name: `v${OMP_COMPATIBILITY_BASELINE}`,
  runtimeAssets: {
    'win32-x64': {
      url: 'https://example.test/omp-windows-x64.exe',
      sha256: 'a'.repeat(64),
      size: 1234,
    },
  },
};

function release(overrides = {}) {
  return {
    assets: [
      {
        name: 'omp-windows-x64.exe',
        digest: `sha256:${'a'.repeat(64)}`,
        browser_download_url: 'https://example.test/omp-windows-x64.exe',
        size: 1234,
      },
    ],
    ...overrides,
  };
}

test('OMP runtime pin keeps the adapter on its one audited baseline', () => {
  assert.equal(readPinnedVersion(), OMP_COMPATIBILITY_BASELINE);
  assert.equal(OMP_COMPATIBILITY_BASELINE, '18.1.18');
});

test('OMP runtime metadata requires exact name, URL, digest, and size matches', () => {
  const result = assertPinnedRuntimeAsset(pin, release(), OMP_COMPATIBILITY_BASELINE, 'win32-x64');
  assert.equal(result.platform.file, 'omp.exe');

  for (const altered of [
    release({
      assets: [{ ...release().assets[0], digest: `sha256:${'b'.repeat(64)}` }],
    }),
    release({
      assets: [
        {
          ...release().assets[0],
          browser_download_url: 'https://example.test/other',
        },
      ],
    }),
    release({ assets: [{ ...release().assets[0], size: 1 }] }),
    release({ assets: [] }),
  ]) {
    assert.throws(
      () => assertPinnedRuntimeAsset(pin, altered, OMP_COMPATIBILITY_BASELINE, 'win32-x64'),
      /does not match the committed pin/,
    );
  }
});

test('OMP runtime updater rejects unaudited version substitutions', () => {
  assert.throws(
    () => assertPinnedRuntimeAsset(pin, release(), '18.1.19', 'win32-x64'),
    /not the audited RPC baseline/,
  );
});

test('OMP local runtime acceptance requires its exact pinned size and SHA-256', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-runtime-test-'));
  const runtime = path.join(directory, 'omp.exe');
  const contents = Buffer.alloc(1_234, 7);
  fs.writeFileSync(runtime, contents);
  const expected = {
    sha256: createHash('sha256').update(contents).digest('hex'),
    size: contents.length,
  };

  assert.equal(isVerifiedRuntimeFile(runtime, expected), true);
  fs.writeFileSync(runtime, Buffer.alloc(contents.length, 8));
  assert.equal(isVerifiedRuntimeFile(runtime, expected), false);
  fs.writeFileSync(runtime, Buffer.alloc(contents.length - 1, 7));
  assert.equal(isVerifiedRuntimeFile(runtime, expected), false);
});
