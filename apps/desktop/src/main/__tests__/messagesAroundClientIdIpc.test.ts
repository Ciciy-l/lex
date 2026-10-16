import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// Windows checkout(core.autocrlf)下源码是 CRLF;统一归一成 LF,含 \n 的多行片段断言才跨平台成立。
const readTextLf = (...args: Parameters<typeof readFileSync>): string =>
  String(readFileSync(...args)).replace(/\r\n/g, '\n');

const messagesIpcSource = readTextLf(
  resolve(__dirname, '..', 'localDb', 'ipc', 'messages.ts'),
  'utf8',
);
const preloadSource = readTextLf(
  resolve(__dirname, '..', '..', 'preload', 'preload.ts'),
  'utf8',
);
const viteEnvSource = readTextLf(
  resolve(__dirname, '..', '..', 'renderer', 'vite-env.d.ts'),
  'utf8',
);

describe('messages around-client-id IPC boundary', () => {
  it('exposes the clientId-based around lookup across main, preload, and renderer types', () => {
    expect(messagesIpcSource).toContain("handleMessageIpc(\n    'local-db:messages:around-client-id'");
    const wrapperStart = messagesIpcSource.indexOf('function handleMessageIpc(');
    const wrapperEnd = messagesIpcSource.indexOf('export async function readMessagesList(', wrapperStart);
    expect(wrapperStart).toBeGreaterThan(-1);
    expect(wrapperEnd).toBeGreaterThan(wrapperStart);
    const wrapper = messagesIpcSource.slice(wrapperStart, wrapperEnd);
    expect(wrapper).toContain('ipcMain.handle(channel,');
    expect(wrapper).toContain('await captureMessageSessionAccess(sid)');
    expect(wrapper).toContain('await listener(event, sid, ...args)');
    expect(preloadSource).toContain('aroundClientId: (');
    expect(preloadSource).toContain("'local-db:messages:around-client-id'");
    expect(viteEnvSource).toContain('aroundClientId: (');
  });
});
