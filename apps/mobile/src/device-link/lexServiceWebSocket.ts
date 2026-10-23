import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';
import type { WsLike } from '@cindy/device-link';
import { normalizeMobileLexServerOrigin } from '@/auth/mobileServerOrigin';

type SocketEvent = { id: string; type: 'open' | 'message' | 'close' | 'error'; data?: string; code?: number; reason?: string; message?: string };
interface LexSocketModule {
  connect(id: string, origin: string, url: string, headers: Record<string, string>): void;
  send(id: string, data: string): void; close(id: string, code: number, reason: string): void; terminate(id: string): void;
  addListener(name: 'socketEvent', listener: (event: SocketEvent) => void): { remove(): void };
}
const nativeModule = () => Platform.OS === 'android' ? requireOptionalNativeModule<LexSocketModule>('LexServiceWebSocket') : null;
export function supportsLexServiceWebSocket(): boolean { return !!nativeModule(); }
let sequence = 0;

/** No RN fallback: an old binary cannot safely carry a Lex bearer token. */
export function createLexServiceWebSocket(origin: string, url: string, headers: Record<string, string>): WsLike {
  const native = nativeModule();
  if (!native) throw new Error('LEX_SERVER_NATIVE_UPDATE_REQUIRED');
  const canonical = normalizeMobileLexServerOrigin(origin);
  if (url !== canonical.replace(/^http/u, 'ws') + '/api/device-link/ws') throw new Error('INVALID_SOCKET_ORIGIN');
  return new LexSocket(native, canonical, url, headers);
}

/** Adapts only transport events; protocol and reconnect ownership stay in DeviceLinkClient. */
class LexSocket implements WsLike {
  private readonly id = `lex_${Date.now()}_${++sequence}`;
  private readonly listeners = new Map<string, Array<(value?: unknown, extra?: unknown) => void>>();
  private readonly subscription: { remove(): void };
  private closed = false;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly module: LexSocketModule, origin: string, url: string, headers: Record<string, string>) {
    this.subscription = module.addListener('socketEvent', event => {
      if (event.id !== this.id || this.closed) return;
      if (event.type === 'message') this.emit('message', { toString: () => event.data ?? '' });
      else if (event.type === 'error') this.emit('error', new Error(event.message ?? 'WebSocket error'));
      else if (event.type === 'close') { this.emit('close', event.code ?? 1006, event.reason); this.dispose(); }
      else this.emit('open');
    });
    // DeviceLinkClient awaits the factory before attaching listeners. Use a task,
    // so synchronous native validation failures also reach the installed handlers.
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.closed) return;
      try { module.connect(this.id, origin, url, headers); }
      catch { this.emit('error', new Error('WebSocket connection failed')); this.emit('close', 1006); this.dispose(); }
    }, 0);
  }
  send(data: string): void { if (!this.closed) this.module.send(this.id, data); }
  close(code = 1000, reason = ''): void { if (!this.closed) { this.module.close(this.id, code, reason); this.emit('close', code, reason); this.dispose(); } }
  terminate(): void { if (!this.closed) { this.module.terminate(this.id); this.emit('close', 1006); this.dispose(); } }
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: { toString(): string }) => void): void;
  on(event: 'close', cb: (code: number, reason?: unknown) => void): void;
  on(event: 'error', cb: (error: Error) => void): void;
  on(event: string, cb: (...values: never[]) => void): void {
    const entries = this.listeners.get(event) ?? [];
    entries.push(cb as (value?: unknown, extra?: unknown) => void); this.listeners.set(event, entries);
  }
  private emit(event: string, value?: unknown, extra?: unknown): void { for (const listener of this.listeners.get(event) ?? []) listener(value, extra); }
  private dispose(): void { this.closed = true; if (this.connectTimer) clearTimeout(this.connectTimer); this.connectTimer = null; this.subscription.remove(); this.listeners.clear(); }
}
