import { TurnDispatchRejectedError, type AgentSessionHandle } from '../base-agent.js';
import type { AgentNativeInputResolver, AgentNativeMediaResolver } from '../native-input.js';
import type { AgentEvent, InteractionResolver } from '../../types/events.js';
import { createAsyncQueue } from '../shared/async-queue.js';

export const PI_NATIVE_RAW_HISTORY = Symbol('pi-native-raw-history');
export interface PiNativeHistoryHandle extends AgentSessionHandle {
  revokeOrcaIdentity?(): void;
  forkNativeHistory(entryId: string, checkpoint: (nativeId: string) => Promise<void>): Promise<string>;
  reopenNativeHistory(nativeId: string): Promise<PiNativeHistoryHandle>;
}

/** Pi's command context expires at fork. Use its withSession readback once,
 * then retire the process and rebuild all host policy on that exact history. */
export function managePiNativeHistory(options: {
  initial: PiNativeHistoryHandle;
}): AgentSessionHandle {
  let current = options.initial, staged: PiNativeHistoryHandle | undefined;
  let changing = false, closed = false, usable = true, generation = 0, owner = 0;
  let resolver: AgentNativeInputResolver | undefined, media: AgentNativeMediaResolver | undefined;
  let interaction: InteractionResolver | undefined, savedDraft: string | undefined;
  let priorTokens = 0, priorCost = 0;
  let change: Promise<unknown> | undefined, closing: Promise<void> | undefined;
  const events = createAsyncQueue<AgentEvent>();
  const live = () => { if (changing || closed || !usable) throw new TurnDispatchRejectedError('Pi history handoff is not ready'); };
  const usage = () => { const value = current.getUsageSnapshot(); return { ...value, tokenUsage: priorTokens + value.tokenUsage, costUsd: priorCost + value.costUsd }; };
  const forward = (handle: PiNativeHistoryHandle, replacement: boolean) => {
    const epoch = ++generation;
    void (async () => {
      try { for await (const event of handle.events()) {
        if (closed || epoch !== generation) return;
        if (replacement && event.type === 'session_id') continue;
        events.push(event.type === 'status' ? { ...event, data: { ...event.data as object, ...usage() } } : event);
      } } finally { if (!closed && epoch === generation) events.end(); }
    })().catch(() => { if (!closed && epoch === generation) { usable = false; events.end(); } });
  };
  forward(current, false);
  const overrides: Partial<AgentSessionHandle> = {
    events: () => events, getUsageSnapshot: usage,
    async getSessionTree() { live(); return { ...await current.getSessionTree!(), navigationMode: 'tree-and-fork' }; },
    async readSessionTree() {
      live(); const result = await current.readSessionTree!();
      return { ...result, tree: { ...result.tree, navigationMode: 'tree-and-fork' } };
    },
    isTurnRunning: () => changing || !usable || (current.isTurnRunning?.() ?? false),
    setNativeInputResolver(next, nextMedia) {
      if (resolver !== next || media !== nextMedia) owner++;
      resolver = next; media = nextMedia;
      if (!changing && usable) current.setNativeInputResolver?.(next, nextMedia);
    },
    setInteractionResolver(next) { interaction = next; if (!changing && usable) current.setInteractionResolver(next); },
    async setVendorOptions(patch) {
      if (changing && Object.keys(patch).some(key => key.startsWith('orca') || key === 'initialWorker')) {
        owner++; current.revokeOrcaIdentity?.(); staged?.revokeOrcaIdentity?.();
      }
      live(); await current.setVendorOptions!(patch);
    },
    async readNativeEditorDraft() { return savedDraft ?? await current.readNativeEditorDraft!(); },
    async navigateSessionTree(entryId, navigation, handoff) {
      live();
      if (!navigation?.fork) {
        const result = await current.navigateSessionTree!(entryId, navigation, handoff);
        return { ...result, tree: { ...result.tree, navigationMode: 'tree-and-fork' } };
      }
      if (!handoff || current.isTurnRunning?.() || !entryId || entryId.length > 128 || navigation.summarize)
        throw new TurnDispatchRejectedError('Pi fork requires an idle managed history transaction');
      changing = true;
      const old = current, source = old.id, epoch = owner;
      const assertCurrent = () => { if (closed || owner !== epoch) throw new Error('Pi history owner changed'); };
      const task = (async () => {
        handoff.holdInput(old.presentation!.suspendInput!());
        savedDraft = await old.readNativeEditorDraft!(); assertCurrent();
        if (savedDraft === undefined || old.isTurnRunning?.()) throw new Error('Pi native draft is unavailable');
        await handoff.beforeReplacement(); assertCurrent();
        usable = false;
        const target = await old.forkNativeHistory(entryId, async nativeId => { assertCurrent(); await handoff.target(nativeId); assertCurrent(); });
        assertCurrent(); generation++;
        await old.close(); assertCurrent();
        const next = await old.reopenNativeHistory(target); staged = next;
        handoff.holdInput(next.presentation!.suspendInput!());
        assertCurrent();
        if (next.id !== target || next.model !== old.model) throw new Error('Pi replacement identity changed');
        await next.restoreNativeEditorDraft!(savedDraft);
        if (await next.readNativeEditorDraft!() !== savedDraft) throw new Error('Pi replacement draft changed');
        const result = await next.readSessionTree!(); assertCurrent();
        if (resolver) next.setNativeInputResolver?.(resolver, media);
        if (interaction) next.setInteractionResolver(interaction);
        const prior = usage(); priorTokens = prior.tokenUsage; priorCost = prior.costUsd;
        current = next; staged = undefined; usable = true; savedDraft = undefined;
        forward(next, true);
        return { ...result, tree: { ...result.tree, navigationMode: 'tree-and-fork' as const },
          nativeIdentity: { source, target }, ...(target === source ? { cancelled: true } : {}) };
      })(); change = task;
      try { return await task; }
      finally { changing = false; if (staged) { await staged.close(); staged = undefined; } }
    },
    close() {
      if (closing) return closing;
      closed = true; generation++;
      closing = (async () => {
        await Promise.all([current.close(), staged?.close()]); await change?.catch(() => {});
        await staged?.close(); events.end();
      })(); return closing;
    },
  };
  // All ordinary Pi settings remain the original implementation, including
  // permissions, native install/update, extensions and explicit host commands.
  return new Proxy(overrides as AgentSessionHandle, { get(target, key) {
    if (Object.hasOwn(target, key)) return Reflect.get(target, key);
    const value = Reflect.get(current, key);
    return typeof value === 'function' ? (...args: unknown[]) => { live(); return value.apply(current, args); } : value;
  } });
}
