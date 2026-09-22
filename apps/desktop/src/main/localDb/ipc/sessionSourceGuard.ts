import { throwIpcError } from '../../utils/ipcValidate.js';

/**
 * sessions.source is a host-owned provenance field. Renderer session creation
 * may omit it (the normal desktop source is assigned by the mapper), but it may
 * not select a producer-owned source such as bot, review, plugin, or a legacy
 * Cindy Make row. Those paths have their own Main-side creation boundary.
 */
export async function assertRendererSessionSourceAllowed(input: {
  source: unknown;
}): Promise<void> {
  if (input.source === undefined) return;
  throwIpcError('UNSUPPORTED_CAPABILITY', 'Session source is host-owned');
}
