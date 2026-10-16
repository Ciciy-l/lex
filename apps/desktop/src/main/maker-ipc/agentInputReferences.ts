import { readRetiredCompanionSessions } from '../localDb/retiredCompanions.js';
import { and, eq } from 'drizzle-orm';

import { boundAgentReferenceText, projectPersistedAgentFacingUserText, readAgentInputReferences, type AgentInputReference } from '@cindy/maker-shared/agent-input-projection';

import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { isAppSessionBoundaryPending } from '../appSessionState.js';
import { messages, sessions } from '../localDb/schema.js';

import { extractPlainText } from './agentHandoff.js';

type ReferencedMessageLookup =
  | { state: 'visible'; text: string | null }
  | { state: 'hidden' }
  | { state: 'missing' };

async function readReferencedMessageText(
  sessionId: string,
  messageClientId: string,
): Promise<ReferencedMessageLookup> {
  const owner = getCurrentDbClientSnapshot();
  if (!owner || isAppSessionBoundaryPending()) return { state: 'hidden' };
  if ((await readRetiredCompanionSessions([sessionId])).has(sessionId)) return { state: 'hidden' };
  if (getCurrentDbClientSnapshot() !== owner || isAppSessionBoundaryPending()) return { state: 'hidden' };
  const [row] = await owner.client
    .drizzle.select({
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
      rewindAt: messages.rewindAt,
      clearedAt: sessions.clearedAt,
    })
    .from(messages)
    .innerJoin(sessions, eq(sessions.id, messages.sessionId))
    .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, messageClientId)))
    .limit(1);
  if (getCurrentDbClientSnapshot() !== owner || isAppSessionBoundaryPending()) return { state: 'hidden' };
  if (!row) return { state: 'missing' };
  if (
    row.rewindAt != null
    || (row.clearedAt != null && row.createdAt <= row.clearedAt)
  ) {
    return { state: 'hidden' };
  }
  const projected = row.role === 'user'
    ? projectPersistedAgentFacingUserText(row.content)
    : null;
  return {
    state: 'visible',
    text: (projected ?? extractPlainText(row.content)).trim() || null,
  };
}

function persistReferences(
  persistedContent: string,
  references: readonly AgentInputReference[],
): string {
  try {
    const parsed = JSON.parse(persistedContent) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return persistedContent;
    const next = { ...(parsed as Record<string, unknown>) };
    delete next.agentReferences;
    const persistentReferences = references;
    return JSON.stringify({
      ...next,
      ...(persistentReferences.length > 0 ? { agentReferences: persistentReferences } : {}),
    });
  } catch {
    return persistedContent;
  }
}

function readPersistedReferences(
  persistedContent: string,
  text: string,
): { present: boolean; references: AgentInputReference[] } {
  try {
    const parsed = JSON.parse(persistedContent) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { present: false, references: [] };
    }
    const record = parsed as Record<string, unknown>;
    return {
      present: Object.hasOwn(record, 'agentReferences'),
      references: readAgentInputReferences(record.agentReferences, text),
    };
  } catch {
    return { present: false, references: [] };
  }
}

/**
 * Validate reference metadata and hydrate missing message bodies from the
 * authoritative host DB before the queue accepts/persists the item.
 */
export async function hydrateQueuedAgentReferences(
  queued: AgentInputQueuedMessage,
): Promise<AgentInputQueuedMessage> {
  const persisted = readPersistedReferences(queued.persistedContent, queued.text);
  const references = (queued.agentReferences !== undefined
    ? readAgentInputReferences(queued.agentReferences, queued.text)
    : persisted.references);
  if (references.length === 0) {
    if (queued.agentReferences === undefined && !persisted.present) return queued;
    const sanitized = { ...queued };
    delete sanitized.agentReferences;
    sanitized.persistedContent = persistReferences(queued.persistedContent, []);
    return sanitized;
  }

  const hydrated = await Promise.all(references.map(async (reference): Promise<AgentInputReference> => {
    if (reference.kind !== 'message') return reference;
    let lookup: ReferencedMessageLookup = { state: 'missing' };
    try {
      lookup = await readReferencedMessageText(
        reference.sessionId,
        reference.messageClientId,
      );
    } catch {
      // An unavailable owner must not disclose a retained companion's captured body.
      lookup = { state: 'hidden' };
    }
    const sourceText = lookup.state === 'visible'
      ? lookup.text ?? ''
      : lookup.state === 'hidden'
        ? ''
        : reference.text ?? '';
    const bounded = boundAgentReferenceText(sourceText);
    const capturedTruncated = reference.truncated;
    const base = { ...reference };
    delete base.text;
    delete base.truncated;
    return {
      ...base,
      ...(bounded.text ? { text: bounded.text } : {}),
      ...((lookup.state === 'missing' && capturedTruncated === true) || bounded.truncated
        ? { truncated: true }
        : {}),
    };
  }));

  return {
    ...queued,
    agentReferences: hydrated,
    persistedContent: persistReferences(queued.persistedContent, hydrated),
  };
}
