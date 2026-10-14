import { randomBytes, timingSafeEqual } from 'node:crypto';

export const REMOTE_CHANNEL_TOKEN_HEADER = 'x-cindy-ssh-session-token';
type Engine = 'claude-code' | 'codex';
type Binding = { sessionId: string; engine: Engine; current: () => boolean; active: boolean };
const bindings = new Map<string, Binding>();
const requests = new WeakMap<object, Binding>();

export function registerRemoteChannelSession(
  sessionId: string,
  engine: Engine,
  current: () => boolean,
) {
  const token = randomBytes(32).toString('hex');
  const binding = { sessionId, engine, current, active: true };
  bindings.set(token, binding);
  return {
    token,
    release: () => {
      binding.active = false;
      bindings.delete(token);
    },
  };
}

export function authenticateRemoteChannelToken(candidate: unknown, token: string): boolean {
  if (
    typeof candidate !== 'string' ||
    !/^[a-f0-9]{64}$/.test(candidate) ||
    candidate.length !== token.length
  )
    return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(token));
}

/** Consume the private transport header before any upstream handler sees it.
 * Absent => ordinary local request; false => invalid/stale SSH capability. */
export function consumeRemoteChannelSession(
  headers: Record<string, string>,
  engine: Engine,
): string | false | null {
  const token = headers[REMOTE_CHANNEL_TOKEN_HEADER];
  if (token === undefined) return remoteChannelSession(headers, engine) ?? null;
  delete headers[REMOTE_CHANNEL_TOKEN_HEADER];
  const binding = bindings.get(token);
  if (!binding || binding.engine !== engine || !binding.current()) return false;
  requests.set(headers, binding);
  return binding.sessionId;
}

export function remoteChannelSession(headers: object, engine: Engine): string | undefined {
  const binding = requests.get(headers);
  return binding?.engine === engine && binding.active && binding.current()
    ? binding.sessionId
    : undefined;
}

/** A consumed capability stays identifiable after revocation; it cannot become
 * an ordinary local request and fall back to account/default routing. */
export function remoteChannelRequestCurrent(headers: object, engine: Engine): boolean {
  return !requests.has(headers) || remoteChannelSession(headers, engine) !== undefined;
}
