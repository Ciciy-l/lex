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

test('OMP promote writes the .version marker that ensureBinary skips on', () => {
  // ensure-agent-binaries 的跳过条件是「文件合法 **且** `.version` == pin」,
  // 而这个标记由 promoteOnePlatform 写。少了它,已经下载好的运行时会每次都被判为
  // 未就位并重下 161MB —— 用户在新机器上不该遇到这种情况,所以把这条伴随产物钉住。
  const source = fs.readFileSync(new URL('./update.mjs', import.meta.url), 'utf8');
  assert.match(source, /writeFileSync\(path\.join\(destinationDirectory, '\.version'\)/);
  // 顺序也重要:先按 pin 校验 promoted 产物,再写标记 —— 反过来会把坏产物盖上
  // 「已验证」的章,而 ensureBinary 之后只认标记。
  const verifyIndex = source.indexOf('verifyPromotedRuntime(');
  const markerIndex = source.indexOf("'.version'");
  assert.ok(verifyIndex > -1, 'promote must verify the promoted runtime');
  assert.ok(markerIndex > -1, 'promote must write the .version marker');
  assert.ok(
    verifyIndex < markerIndex,
    'the marker must be written only after the promoted runtime passed verification',
  );
});
