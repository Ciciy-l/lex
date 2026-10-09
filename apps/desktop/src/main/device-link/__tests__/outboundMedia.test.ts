/**
 * outboundMedia.test.ts — 控制端出方向附件改写:上传 OSS + 替换为引用串。
 * mock mediaTransfer + imageCacheStore,验 scheme 路由 / 双形态(send block / enqueue files)/
 * 失败传播 / 非媒体 channel 与无附件透传。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

const uploadLocalFile = vi.hoisted(() => vi.fn());
const uploadBuffer = vi.hoisted(() => vi.fn());
vi.mock('../mediaTransfer', () => ({ uploadLocalFile, uploadBuffer, mimeOf: () => 'text/plain' }));

const resolveSafe = vi.hoisted(() => vi.fn());
vi.mock('../../imageCacheStore', () => ({ resolveSafe }));

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { rewriteOutboundMedia, withPeerAttachmentUpload, __testing } from '../outboundMedia';
import { REVIEW_START_REQUEST_LIMITS } from '../../maker-ipc/reviewStartHandler';
vi.mock('../../maker-ipc/reviewOutboundInput', () => ({ withPreparedOutboundReview: (request: unknown, upload: (value: unknown) => unknown) => upload(request) }));
import { buildPeerAttachmentRef, parsePeerAttachmentRef } from '@cindy/device-link';
import { parseAttachmentOssRef, isAttachmentOssRef } from '../../../shared/attachmentOssRef';

const SHA256 = 'a'.repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  uploadLocalFile.mockResolvedValue({
    key: 'cindy/device-link/u/x.png',
    size: 10,
    contentType: 'image/png',
    sha256: SHA256,
  });
  uploadBuffer.mockResolvedValue({
    key: 'cindy/device-link/u/b.png',
    size: 5,
    contentType: 'image/png',
    sha256: SHA256,
  });
});

describe('rewriteOutboundMedia — channel gating', () => {
  it('uses peer staging for exact file bytes, preserves the name and retains OSS fallback', async () => {
    const direct = vi.fn(async () => buildPeerAttachmentRef({ ticket: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', size: 10, sha256: SHA256, mimeType: 'text/plain' }));
    const args = ['session', { type: 'user', content: [{ type: 'file', path: '/controller/a.txt', originalName: 'a.txt' }] }];
    const result = await withPeerAttachmentUpload(direct, () => rewriteOutboundMedia('maker:send', args));
    const ref = (result[1] as any).content[0].path;
    expect(parsePeerAttachmentRef(ref)?.originalName).toBe('a.txt');
    expect(uploadLocalFile).not.toHaveBeenCalled();
    await withPeerAttachmentUpload(async () => null, () => rewriteOutboundMedia('maker:send', args));
    expect(uploadLocalFile).toHaveBeenCalledOnce();
  });
  it.each([
    ['count', () => Array.from({ length: 21 }, () => ({ name: 'a', path: '/controller/a' }))],
    ['metadata', () => [{ name: 'a', path: '/controller/a' }, { name: 'x'.repeat(4097), path: '/controller/b' }]],
    ['total metadata', () => Array.from({ length: 5 }, () => ({ name: 'a', url: 'a'.repeat(64 * 1024) }))],
    ['single inline payload', () => [{ name: 'a', base64: 'a'.repeat(REVIEW_START_REQUEST_LIMITS.attachmentBase64Chars + 1) }]],
    ['total inline payload', () => Array.from({ length: 3 }, () => ({ name: 'a', base64: 'a'.repeat(24 * 1024 * 1024) }))],
  ] as const)('rejects Review %s limits before reading, compressing or staging any attachment', async (_label, attachments) => {
    await expect(rewriteOutboundMedia('maker:review:start', [{
      sourceSessionId: 'source', attachments: attachments(),
    }])).rejects.toThrow('INVALID_PARAMS');
    expect(uploadLocalFile).not.toHaveBeenCalled();
    expect(uploadBuffer).not.toHaveBeenCalled();
    expect(resolveSafe).not.toHaveBeenCalled();
  });

  it('uploads Review attachments and strips controller-local paths without mutating the request', async () => {
    const request = { sourceSessionId: 'source', focus: 'docs', attachments: [
      { name: 'notes.md', path: '/controller/notes.md', category: 'text' },
    ] };
    const result = await rewriteOutboundMedia('maker:review:start', [request]);
    const rewritten = result[0] as typeof request;
    expect(rewritten.sourceSessionId).toBe('source');
    expect(rewritten.focus).toBe('docs');
    expect(isAttachmentOssRef(rewritten.attachments[0].path)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('/controller/notes.md');
    expect(request.attachments[0].path).toBe('/controller/notes.md');
    expect(uploadLocalFile).toHaveBeenCalledOnce();
  });

  it('rejects Review when attachment upload fails', async () => {
    uploadLocalFile.mockRejectedValue(new Error('upload failed'));
    await expect(rewriteOutboundMedia('maker:review:start', [{
      sourceSessionId: 'source', attachments: [{ name: 'notes.md', path: '/controller/notes.md' }],
    }])).rejects.toThrow('upload failed');
  });
  it('非媒体 channel → 原样,不上传', async () => {
    const args = [{ a: 1 }];
    const out = await rewriteOutboundMedia('maker:set-model', args);
    expect(out).toBe(args);
    expect(uploadLocalFile).not.toHaveBeenCalled();
  });

  it('send 纯文本(string message)→ 原样', async () => {
    const out = await rewriteOutboundMedia('maker:send', ['sess', 'hello']);
    expect(out[1]).toBe('hello');
    expect(uploadLocalFile).not.toHaveBeenCalled();
  });

  it('send 无附件 content → 不上传', async () => {
    await rewriteOutboundMedia('maker:send', [
      'sess',
      { type: 'user', content: [{ type: 'text', text: 'hi' }] },
    ]);
    expect(uploadLocalFile).not.toHaveBeenCalled();
    expect(uploadBuffer).not.toHaveBeenCalled();
  });
});

describe('rewriteQueued — persistedContent 同批改写 + 去重单上传', () => {
  it('files[] 与 persistedContent 的同一附件用同一 OSS 引用,只上传一次', async () => {
    resolveSafe.mockReturnValue({ absPath: '/abs/a.png', mimeType: 'image/png' });
    uploadLocalFile
      .mockResolvedValueOnce({
        key: 'cindy/device-link/u/img.png',
        size: 1,
        contentType: 'image/png',
        sha256: SHA256,
      })
      .mockResolvedValueOnce({
        key: 'cindy/device-link/u/doc.pdf',
        size: 1,
        contentType: 'application/pdf',
        sha256: SHA256,
      });

    const item = {
      clientId: 'c1',
      files: [
        { url: 'xdt-image://s/a.png', mimeType: 'image/png', category: 'image' },
        { path: '/abs/d.pdf', mimeType: 'application/pdf', category: 'file' },
      ],
      persistedContent: JSON.stringify({
        text: 'hi',
        images: [{ url: 'xdt-image://s/a.png', mimeType: 'image/png', originalName: 'a.png' }],
        files: [{ name: 'd.pdf', path: '/abs/d.pdf' }],
      }),
    };

    const out = (await __testing.rewriteQueued(item)) as {
      files: Array<{ url: string; path: string; size: number; sha256: string }>;
      persistedContent: string;
    };

    // 两个附件各只上传一次(persistedContent 复用 refMap,不再额外上传)。
    expect(uploadLocalFile).toHaveBeenCalledTimes(2);

    const imgRef = out.files[0].url;
    const fileRef = out.files[1].url;
    expect(isAttachmentOssRef(imgRef)).toBe(true);
    expect(isAttachmentOssRef(fileRef)).toBe(true);
    expect(out.files[0]).toMatchObject({ size: 1, sha256: SHA256 });
    expect(out.files[1]).toMatchObject({ size: 1, sha256: SHA256 });

    // persistedContent 用同一批引用(images→url、files→path),与 files[] 对齐。
    const pc = JSON.parse(out.persistedContent) as {
      images: Array<{ url: string; size: number; sha256: string }>;
      files: Array<{ path: string; size: number; sha256: string }>;
    };
    expect(pc.images[0]).toMatchObject({ url: imgRef, size: 1, sha256: SHA256 });
    expect(pc.files[0]).toMatchObject({ path: fileRef, size: 1, sha256: SHA256 });
  });

  it('persistedContent 解析失败 → 原样保留(降级),files[] 仍照常改写', async () => {
    uploadLocalFile.mockResolvedValue({
      key: 'cindy/device-link/u/x.png',
      size: 1,
      contentType: 'image/png',
      sha256: SHA256,
    });
    const item = {
      files: [{ path: '/abs/x.png', mimeType: 'image/png' }],
      persistedContent: 'not-json{',
    };
    const out = (await __testing.rewriteQueued(item)) as {
      files: Array<{ url: string }>;
      persistedContent: string;
    };
    expect(isAttachmentOssRef(out.files[0].url)).toBe(true);
    expect(out.persistedContent).toBe('not-json{'); // 解析失败原样
  });
});

describe('rewriteOutboundMedia — send/steer content-block 形态', () => {
  it('maker:send 同批改写 message 与持久内容，同一附件只上传一次并传播原名', async () => {
    uploadLocalFile.mockResolvedValue({
      key: 'cindy/device-link/u/setup.bin',
      size: 42,
      contentType: 'application/octet-stream',
      sha256: SHA256,
    });
    const persistedContent = JSON.stringify({
      text: 'check it',
      images: [],
      files: [{ name: 'setup.exe', path: 'C:\\cache\\setup.exe.bin' }],
    });

    const out = await rewriteOutboundMedia('maker:send', [
      'sess',
      {
        type: 'user',
        content: [
          {
            type: 'file',
            path: 'C:\\cache\\setup.exe.bin',
            mimeType: 'application/octet-stream',
            originalName: 'setup.exe',
          },
        ],
      },
      undefined,
      { persistUserMessage: { clientId: 'c1', content: persistedContent } },
    ]);

    expect(uploadLocalFile).toHaveBeenCalledTimes(1);
    const block = (out[1] as { content: Array<{ path: string; originalName: string }> }).content[0];
    const pc = JSON.parse(
      ((out[3] as { persistUserMessage: { content: string } }).persistUserMessage.content),
    ) as { files: Array<{ path: string }> };
    expect(pc.files[0].path).toBe(block.path);
    expect(block.originalName).toBe('setup.exe');
    expect(parseAttachmentOssRef(block.path)?.originalName).toBe('setup.exe');
  });

  it('uses queued file.name when originalName is absent', async () => {
    const out = await rewriteOutboundMedia('maker:input:enqueue', [
      'sess',
      {
        files: [
          {
            name: 'archive.zip',
            path: '/abs/archive.zip',
            mimeType: 'application/zip',
          },
        ],
      },
    ]);
    const ref = (out[1] as { files: Array<{ path: string }> }).files[0].path;
    expect(parseAttachmentOssRef(ref)?.originalName).toBe('archive.zip');
  });

  it('xdt-image:// 块 → resolveSafe → uploadLocalFile → block.path 变 OSS 引用,base64 清掉', async () => {
    resolveSafe.mockReturnValue({ absPath: '/cache/a.png', mimeType: 'image/png' });
    const out = await rewriteOutboundMedia('maker:send', [
      'sess',
      {
        type: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image', path: 'xdt-image://s/a.png', mimeType: 'image/png' },
        ],
      },
    ]);
    expect(resolveSafe).toHaveBeenCalledWith('xdt-image://s/a.png');
    expect(uploadLocalFile).toHaveBeenCalledWith('/cache/a.png', { contentType: 'image/png' });
    const block = (out[1] as { content: Array<{ type: string; path?: string }> }).content[1];
    expect(isAttachmentOssRef(block.path!)).toBe(true);
    expect(parseAttachmentOssRef(block.path!)?.ossKey).toBe('cindy/device-link/u/x.png');
  });

  it('base64 块 → uploadBuffer', async () => {
    const out = await rewriteOutboundMedia('maker:steer', [
      'sess',
      {
        type: 'user',
        content: [
          { type: 'image', base64: Buffer.from([1, 2]).toString('base64'), mimeType: 'image/png' },
        ],
      },
    ]);
    expect(uploadBuffer).toHaveBeenCalled();
    const block = (out[1] as { content: Array<{ path?: string; base64?: string }> }).content[0];
    expect(isAttachmentOssRef(block.path!)).toBe(true);
    expect(block.base64).toBeUndefined();
  });

  it('绝对路径块 → uploadLocalFile(原路径)', async () => {
    await rewriteOutboundMedia('maker:send', [
      'sess',
      {
        type: 'user',
        content: [{ type: 'file', path: '/abs/doc.pdf', mimeType: 'application/pdf' }],
      },
    ]);
    expect(uploadLocalFile).toHaveBeenCalledWith('/abs/doc.pdf', {
      contentType: 'application/pdf',
    });
  });
});

describe('rewriteOutboundMedia — enqueue files 形态', () => {
  it.each([
    ['maker:input:enqueue', undefined],
    ['maker:input:steer', { touchUserSend: true }],
    ['maker:input:steer', { removeFromQueue: false }],
  ])('uploads a new local HTML attachment for %s with %j', async (channel, opts) => {
    const localPath = path.resolve('controller-files', 'report.html');
    const file = {
      id: 'html',
      name: 'report.html',
      path: localPath,
      size: 42,
      ext: '.html',
      category: 'text',
      mimeType: 'text/html',
    };
    uploadLocalFile.mockResolvedValue({
      key: 'cindy/device-link/u/report.html',
      size: 42,
      contentType: 'text/html',
      sha256: SHA256,
    });
    const item = {
      clientId: 'new-html',
      files: [file],
      persistedContent: JSON.stringify({ text: 'read this', files: [{ name: file.name, path: file.path }] }),
    };

    const out = await rewriteOutboundMedia(channel, ['sess', item, opts]);
    const rewritten = out[1] as typeof item;
    const ref = rewritten.files![0].path;
    expect(uploadLocalFile).toHaveBeenCalledExactlyOnceWith(localPath, { contentType: 'text/html' });
    expect(parseAttachmentOssRef(ref)).toMatchObject({
      originalName: 'report.html',
      mimeType: 'text/html',
      size: 42,
      sha256: SHA256,
    });
    expect(JSON.parse(rewritten.persistedContent).files[0].path).toBe(ref);
    expect(item.files![0].path).toBe(localPath);
  });

  it.each([
    ['cached HTML', 'xdt-image://sess/report.html', 'report.html', 'text/html'],
    ['absolute PDF path', undefined, 'report.pdf', 'application/pdf'],
    ['media blob', `cindy-media://blobs/${SHA256}.png`, 'picture.png', 'image/png'],
  ])('preserves host-owned %s when sending an existing queue item', async (_label, url, name, mimeType) => {
    // These POSIX paths describe the remote host, regardless of the test platform.
    const hostPath = `/remote/cache/sess/${name}`;
    const item = {
      clientId: 'already-queued',
      text: 'read this',
      files: [{ name, path: hostPath, ...(url ? { url } : {}), mimeType }],
      persistedContent: JSON.stringify({ text: 'read this', files: [{ name, path: hostPath }] }),
    };
    const args = ['sess', item, { removeFromQueue: true, expectedClearBoundaryMs: null }];
    resolveSafe.mockReturnValue({ absPath: path.resolve('missing-controller-cache', name), mimeType });
    uploadLocalFile.mockRejectedValue(new Error('ENOENT: host attachment is not on the controller'));

    const out = await rewriteOutboundMedia('maker:input:steer', args);

    expect(out).toEqual(args);
    expect(out[1]).toBe(item);
    expect(resolveSafe).not.toHaveBeenCalled();
    expect(uploadLocalFile).not.toHaveBeenCalled();
    expect(uploadBuffer).not.toHaveBeenCalled();
  });

  it('item.files[] 上传 + url/path 变引用、base64 清掉(buildMakerUserMessage 取 url)', async () => {
    const out = await rewriteOutboundMedia('maker:input:enqueue', [
      'sess',
      {
        text: 'hi',
        files: [
          {
            id: '1',
            name: 'a.png',
            category: 'image',
            mimeType: 'image/png',
            base64: Buffer.from([9]).toString('base64'),
          },
        ],
      },
    ]);
    expect(uploadBuffer).toHaveBeenCalled();
    const f = (out[1] as { files: Array<{ url?: string; base64?: string }> }).files[0];
    expect(isAttachmentOssRef(f.url!)).toBe(true);
    expect(f.base64).toBeUndefined();
  });

  it('enqueue 无 files → 原样', async () => {
    const item = { text: 'hi' };
    const out = await rewriteOutboundMedia('maker:input:enqueue', ['sess', item]);
    expect(out[1]).toBe(item);
    expect(uploadLocalFile).not.toHaveBeenCalled();
  });

  it('maker:input:steer 同 enqueue 形态(steer 带附件也必须改写)', async () => {
    const out = await rewriteOutboundMedia('maker:input:steer', [
      'sess',
      {
        text: 'hi',
        files: [
          { id: '1', name: 'a.png', category: 'image', mimeType: 'image/png', path: '/abs/a.png' },
        ],
      },
    ]);
    expect(uploadLocalFile).toHaveBeenCalledWith('/abs/a.png', { contentType: 'image/png' });
    const f = (out[1] as { files: Array<{ url?: string }> }).files[0];
    expect(isAttachmentOssRef(f.url!)).toBe(true);
  });
});

describe('rewriteOutboundMedia — 失败传播', () => {
  it('上传失败 → 抛错(handleInvoke 转 MEDIA_TRANSFER_FAILED,整条不发)', async () => {
    uploadLocalFile.mockRejectedValue(new Error('OSS PUT 失败 (403)'));
    await expect(
      rewriteOutboundMedia('maker:send', [
        'sess',
        { type: 'user', content: [{ type: 'image', path: '/abs/a.png' }] },
      ]),
    ).rejects.toThrow(/OSS PUT/);
  });

  it('clipboard 占位 → 抛错', async () => {
    await expect(
      rewriteOutboundMedia('maker:send', [
        'sess',
        { type: 'user', content: [{ type: 'image', path: 'clipboard://paste-1' }] },
      ]),
    ).rejects.toThrow(/clipboard/);
  });
});


describe('SharedTask outbound attachments', () => {
  it('strips controller-only preview paths and reuses host-owned attachments during edit', async () => {
    const { withSharedTaskMedia } = await import('../sharedTaskMediaContext.js');
    const item = { files: [{ path: '/host/existing.pdf' }, { path: '/controller/new.pdf' }],
      chatMessage: { content: 'hello', files: [{ path: '/controller/private' }], retryFiles: [{ path: '/controller/private' }] } };
    const result = await withSharedTaskMedia('task', () => rewriteOutboundMedia('maker:input:update-content',
      ['session', 'message', item], new Set(['/host/existing.pdf'])));
    expect(uploadLocalFile).toHaveBeenCalledTimes(1);
    expect(uploadLocalFile).toHaveBeenCalledWith('/controller/new.pdf', {});
    expect((result[2] as typeof item).files[0]).toEqual({ path: '/host/existing.pdf' });
    expect((result[2] as typeof item).chatMessage).toEqual({ content: 'hello' });
    expect(item.chatMessage.files).toHaveLength(1);
  });
});
