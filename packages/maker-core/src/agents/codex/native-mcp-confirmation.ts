import type { McpServerElicitationRequestParams, McpServerElicitationRequestResponse } from './app-server/protocol.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Only native MCP tool confirmations, after the existing host policy passed. */
export function projectNativeMcpConfirmation(params: McpServerElicitationRequestParams, allowSession: boolean): Record<string, unknown> {
  const copy = structuredClone(params);
  if (copy.mode !== 'form' || !record(copy._meta) || copy._meta.codex_approval_kind !== 'mcp_tool_call') {
    throw new Error('Native MCP tool confirmation requires its host policy owner');
  }
  // The native UI reads these advertised persistence choices. Never display a
  // session/always button when the host only permits this particular call.
  const advertised = copy._meta.persist;
  if (!allowSession) delete copy._meta.persist;
  else if (Array.isArray(advertised)) copy._meta.persist = advertised.filter(scope => scope === 'session');
  else if (advertised !== 'session') delete copy._meta.persist;
  return copy;
}

export function decodeNativeMcpConfirmation(response: unknown, projected: Record<string, unknown>): {
  response: McpServerElicitationRequestResponse; decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel';
} | undefined {
  if (!record(response) || Object.keys(response).some(key => !['action', 'content', '_meta'].includes(key))) return undefined;
  const { action, content, _meta } = response;
  if (action !== 'accept' && action !== 'decline' && action !== 'cancel') return undefined;
  // Tool confirmations have no form fields. This is not a generic form parser.
  if (content != null && (!record(content) || Object.keys(content).length !== 0)) return undefined;
  if (_meta != null && (!record(_meta) || Object.keys(_meta).some(key => key !== 'persist'))) return undefined;
  const persist = record(_meta) ? _meta.persist : undefined;
  if (persist !== undefined && persist !== 'session') return undefined;
  if (persist !== undefined && action !== 'accept') return undefined;
  const advertised = record(projected._meta) ? projected._meta.persist : undefined;
  if (persist === 'session' && advertised !== 'session' && !(Array.isArray(advertised) && advertised.includes('session'))) return undefined;
  return { response: { action, content: content == null ? null : {}, _meta: persist ? { persist } : null },
    decision: action === 'accept' && persist === 'session' ? 'acceptForSession' : action };
}
