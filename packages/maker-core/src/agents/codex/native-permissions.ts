import { isDeepStrictEqual } from 'node:util';
import type { PermissionsRequestApprovalParams, PermissionsRequestApprovalResponse } from './app-server/protocol.js';
import type { CodexNativeInteractionRequest } from './native-approvals.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Match Codex's request-to-grant projection; absent overlays confer no grant. */
function requestedGrant(params: PermissionsRequestApprovalParams): Record<string, unknown> | undefined {
  if (!record(params.permissions)
    || Object.keys(params.permissions).some(key => key !== 'network' && key !== 'fileSystem')) return undefined;
  const grant: Record<string, unknown> = {};
  for (const key of ['network', 'fileSystem']) {
    const value = params.permissions[key];
    if (value != null) {
      if (!record(value)) return undefined;
      grant[key] = structuredClone(value);
    }
  }
  return grant;
}

/** A native choice can only approve the exact already-reviewed overlay or deny it. */
export function decodeNativePermissions(response: unknown, params: PermissionsRequestApprovalParams, allowSession: boolean): {
  response: PermissionsRequestApprovalResponse & { strictAutoReview?: boolean };
  decision: 'accept' | 'acceptForSession' | 'decline';
} | undefined {
  if (!record(response) || Object.keys(response).some(key => !['permissions', 'scope', 'strictAutoReview'].includes(key))
    || !record(response.permissions) || !['turn', 'session'].includes(String(response.scope))
    || (response.strictAutoReview !== undefined && typeof response.strictAutoReview !== 'boolean')) return undefined;
  const granted = response.permissions;
  const requested = requestedGrant(params);
  if (!requested) return undefined;
  const denied = Object.keys(granted).length === 0;
  if (!denied && !isDeepStrictEqual(granted, requested)) return undefined;
  if (response.scope === 'session' && (!allowSession || denied)) return undefined;
  return { response: { permissions: structuredClone(granted), scope: response.scope as 'turn' | 'session',
    ...(response.strictAutoReview === undefined ? {} : { strictAutoReview: response.strictAutoReview }) },
    decision: denied ? 'decline' : response.scope === 'session' ? 'acceptForSession' : 'accept' };
}

export interface CodexNativePermissionCopy {
  header: string;
  confirmation: string;
  once: string;
  onceDescription: string;
  strict: string;
  strictDescription: string;
  deny: string;
  denyDescription: string;
}
// Standalone maker-core hosts fall back to the upstream UI's language. Desktop
// supplies its selected locale through AgentDeps for both local and SSH tasks.
const defaultCopy: CodexNativePermissionCopy = {
  header: 'Permissions', confirmation: 'Lex requires confirmation for this operation.',
  once: 'Allow for this turn', onceDescription: 'Grant only these permissions for this turn.',
  strict: 'Allow with strict review', strictDescription: 'Grant for this turn and review every subsequent command.',
  deny: 'Continue without permissions', denyDescription: 'Do not grant additional permissions.',
};
const questionId = 'lex-permission-grant';

/**
 * Upstream's permissions overlay always offers a session grant. Where the host
 * requires per-call confirmation, use the upstream question form with only
 * eligible choices. Never advertise a grant and silently reduce its scope.
 */
export function projectNativePermissions(id: string | number, params: PermissionsRequestApprovalParams, allowSession: boolean,
  localizedCopy: CodexNativePermissionCopy = defaultCopy): {
  request: CodexNativeInteractionRequest;
  decode(value: unknown): ReturnType<typeof decodeNativePermissions>;
} {
  const snapshot = structuredClone(params);
  if (allowSession) return {
    request: { id, method: 'item/permissions/requestApproval', params: snapshot },
    decode: value => decodeNativePermissions(value, snapshot, true),
  };
  const permissions = requestedGrant(snapshot);
  if (!permissions) throw new Error('Native permissions have no reviewed grant');
  // Decode against the labels actually shown, even if locale changes meanwhile.
  const copy = structuredClone(localizedCopy);
  const { once, strict, deny } = copy;
  if (new Set([once, strict, deny]).size !== 3) throw new Error('Native permission choices must be distinct');
  return {
    request: { id, method: 'item/tool/requestUserInput', params: {
      threadId: snapshot.threadId, turnId: snapshot.turnId, itemId: snapshot.itemId,
      isBlocking: true, autoResolutionMs: null, questions: [{
        id: questionId, header: copy.header, isOther: false, isSecret: false,
        question: [copy.confirmation, snapshot.reason, JSON.stringify(snapshot.permissions, null, 2)]
          .filter(Boolean).join('\n\n'),
        options: [
          { label: once, description: copy.onceDescription },
          { label: strict, description: copy.strictDescription },
          { label: deny, description: copy.denyDescription },
        ],
      }],
    } },
    decode: value => {
      if (!record(value) || Object.keys(value).length !== 1 || !record(value.answers)
        || Object.keys(value.answers).some(key => key !== questionId)) return undefined;
      const answer = value.answers[questionId];
      if (answer === undefined && Object.keys(value.answers).length === 0) {
        return decodeNativePermissions({ permissions: {}, scope: 'turn' }, snapshot, false);
      }
      if (!record(answer) || Object.keys(answer).length !== 1 || !Array.isArray(answer.answers)
        || answer.answers.length > 1) return undefined;
      const choice = answer.answers[0];
      if (choice !== undefined && choice !== once && choice !== strict && choice !== deny) return undefined;
      return decodeNativePermissions({ permissions: choice === once || choice === strict ? permissions : {},
        scope: 'turn', ...(choice === strict ? { strictAutoReview: true } : {}) }, snapshot, false);
    },
  };
}
