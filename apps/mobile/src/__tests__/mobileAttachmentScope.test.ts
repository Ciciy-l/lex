import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { authServiceScope, type AuthService } from '@cindy/auth-client';
import { getMobileAuthOwner, setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { registerAccountUnavailableHandler } from '@/api/client';
import { discardMobileUploadedAttachment, uploadMobileAttachmentFromFile } from '@/session/mobileAttachmentUpload';

const fixture = vi.hoisted(() => ({ service: { kind: 'cindy', realm: 'cn' } as AuthService,
  endpoint: 'https://cn.fixture.invalid' }));
vi.mock('@/auth/authService', () => ({ getActiveMobileAuthService: () => fixture.service }));
vi.mock('@/config/env', () => ({ get DEVICE_LINK_API_BASE_URL() { return fixture.endpoint; } }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));

function activate(service: AuthService) {
  fixture.service = service;
  fixture.endpoint = service.kind === 'cindy' ? 'https://' + service.realm + '.fixture.invalid' : service.origin;
  setMobileAuthOwner('same-member', authServiceScope(service));
}
const presign = () => new Response(JSON.stringify({ putUrl: 'https://oss.fixture.invalid/upload',
  key: 'cindy/device-link/same-member/file.txt', expiresAt: '' }), { status: 200 });
const readFileChunk = async () => Buffer.from('abc').toString('base64');
beforeEach(() => { activate({ kind: 'cindy', realm: 'cn' }); });
afterEach(() => { setMobileAuthOwner(null); vi.unstubAllGlobals(); });

it.each([false, true])('skips an old upload completing after a realm switch (via Lex: %s)', async viaLex => {
  const owner = getMobileAuthOwner();
  const http = vi.fn().mockImplementation(async () => presign()); vi.stubGlobal('fetch', http);
  let finish!: (value: { status: number }) => void;
  const uploadFile = vi.fn(() => new Promise<{ status: number }>(resolve => { finish = resolve; }));
  const pending = uploadMobileAttachmentFromFile({ name: 'file.txt', size: 3 }, 'file:///fixture', {
    token: 'invalid-cn-fixture', deps: { readFileChunk, uploadFile },
  });
  await vi.waitFor(() => expect(uploadFile).toHaveBeenCalledOnce());
  if (viaLex) activate({ kind: 'lex-server', origin: 'https://lex.fixture.invalid' });
  activate({ kind: 'cindy', realm: 'global' });
  finish({ status: 200 });
  const attachment = await pending;
  discardMobileUploadedAttachment(attachment, { owner, getToken: async () => 'invalid-cn-fixture' });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(http).toHaveBeenCalledTimes(1);
  expect(http.mock.calls[0][0]).toBe('https://cn.fixture.invalid/api/device-link/media/presign-put');
});

it('keeps the upload binding for controller disposal without an explicit owner option', async () => {
  const http = vi.fn().mockImplementation(async () => presign()); vi.stubGlobal('fetch', http);
  const attachment = await uploadMobileAttachmentFromFile({ name: 'file.txt', size: 3 }, 'file:///fixture', {
    token: 'invalid-cn-fixture', deps: { readFileChunk, uploadFile: async () => ({ status: 200 }) },
  });
  activate({ kind: 'cindy', realm: 'global' });
  discardMobileUploadedAttachment(attachment, { getToken: async () => 'invalid-cn-fixture' });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(http).toHaveBeenCalledTimes(1);
});

it('never issues a late cancelled-upload reclaim under the next owner', async () => {
  const http = vi.fn().mockImplementation(async () => presign()); vi.stubGlobal('fetch', http);
  const controller = new AbortController();
  let finish!: (value: { status: number }) => void;
  const uploadFile = vi.fn(() => new Promise<{ status: number }>(resolve => { finish = resolve; }));
  const pending = uploadMobileAttachmentFromFile({ name: 'file.txt', size: 3 }, 'file:///fixture', {
    token: 'invalid-cn-fixture', signal: controller.signal, deps: { readFileChunk, uploadFile },
  });
  const failed = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(uploadFile).toHaveBeenCalledOnce());
  activate({ kind: 'cindy', realm: 'global' }); controller.abort(); await failed;
  finish({ status: 200 }); await new Promise(resolve => setTimeout(resolve, 0));
  expect(http).toHaveBeenCalledTimes(1);
});

it('does not let an old cleanup 401 clear the next owner', async () => {
  const http = vi.fn().mockImplementation(async () => presign()); vi.stubGlobal('fetch', http);
  const attachment = await uploadMobileAttachmentFromFile({ name: 'file.txt', size: 3 }, 'file:///fixture', {
    token: 'invalid-cn-fixture', deps: { readFileChunk, uploadFile: async () => ({ status: 200 }) },
  });
  let finish!: (value: Response) => void;
  http.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
  const clear = vi.fn(); const off = registerAccountUnavailableHandler(clear);
  try {
    discardMobileUploadedAttachment(attachment, { owner: getMobileAuthOwner(), getToken: async () => 'invalid-cn-fixture' });
    await vi.waitFor(() => expect(http).toHaveBeenCalledTimes(2));
    activate({ kind: 'cindy', realm: 'global' });
    finish(new Response(JSON.stringify({ error: { code: 'ACCOUNT_UNAVAILABLE' } }), { status: 401 }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(clear).not.toHaveBeenCalled();
    expect(http.mock.calls.every(([url]) => String(url).startsWith('https://cn.fixture.invalid/'))).toBe(true);
  } finally { off(); }
});
