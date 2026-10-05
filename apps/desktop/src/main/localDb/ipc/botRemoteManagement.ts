import type { RemoteResourceHostContext } from '../../device-link/remoteResourceRegistry.js';
import { botRemoteResourceFromSource } from './botRemoteResourceProjection.js';
import { inspectAppDefaultModel } from '../../maker-ipc/appDefaultModelControl.js';
import type { BotModelRoute } from '../../../shared/botModelChain.js';
import { createBotRemoteSettingsResource, type BotRemoteOperationGuard } from './botRemoteSettingsResource.js';
import * as botStore from './bots.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../appSessionState.js';
import { throwIpcError } from '../../utils/ipcValidate.js';
import { listBotSkillsForBot, readBotSkillForBot, saveBotSkillForSession, deleteBotSkillForBot } from '../../maker-ipc/botSkillService.js';
import { requestBotRuntimeEpochRefresh } from '../../maker-ipc/botRuntimeEpochRefreshSignal.js';
import { createBotRemoteEditors } from './botRemoteEditors.js';
import { decodeBotAvatarImage } from './botAvatarSelection.js';
import { runRegisteredBotLifecycleAction } from '../../maker-ipc/botLifecycleService.js';
import { listBotSettingsCapabilities, validateBotCapabilityAdditions } from '../../maker-host/index.js';

/** Composition only: profile transactions, skill reads and lifecycle stay with their existing owners. */
const deps = {
  owner: activeOwnerScopeKey,
  assertOwner(owner: string) {
    if (isAppSessionBoundaryPending() || owner !== activeOwnerScopeKey()) throwIpcError('PRECONDITION_FAILED', 'Account changed');
  },
  // Keep this lookup lazy.  A host that only exposes the legacy Bot/memory
  // projection can still load this module without advertising the settings
  // service in its test/compatibility surface; settings callers get the
  // normal unsupported-capability error when they actually ask for it.
  read: (...args: Parameters<typeof botStore.getBotRemoteSettingsSource>) =>
    botStore.getBotRemoteSettingsSource(...args),
  update: async (input: Record<string, unknown>, version: number, operationGuard?: BotRemoteOperationGuard) => {
    const owner = activeOwnerScopeKey();
    const capabilities = input.capabilities as { modelChainOverride?: BotModelRoute[] | null } | undefined;
    if (Array.isArray(capabilities?.modelChainOverride)) {
      const scope = activeOwnerScopeKey();
      const catalog = await inspectAppDefaultModel();
      if (isAppSessionBoundaryPending() || scope !== activeOwnerScopeKey()) throwIpcError('PRECONDITION_FAILED', 'Account changed');
      operationGuard?.();
      for (const route of capabilities.modelChainOverride) {
        const entry = catalog.available.find(item => item.route.harness === route.harness && item.route.model === route.model && item.route.providerId === route.providerId);
        if (!entry || route.effort && !entry.efforts.some(effort => effort === route.effort) || route.fastMode && !entry.supportsFastMode) throwIpcError('INVALID_PARAMS', 'Model route unavailable');
      }
    }
    if (isAppSessionBoundaryPending() || owner !== activeOwnerScopeKey()) throwIpcError('PRECONDITION_FAILED', 'Account changed');
    operationGuard?.();
    return botStore.updateBotProfile(input, version, validateBotCapabilityAdditions, operationGuard);
  },
  skills: (botId: string, operationGuard?: BotRemoteOperationGuard) => listBotSkillsForBot(botId, { operationGuard }),
};
const settings = createBotRemoteSettingsResource({ ...deps,
  lifecycle: (botId, action, confirmName, guard, operationGuard) => runRegisteredBotLifecycleAction(
    { botId, action, confirmName, keepTaskHistory: true, worktreeDisposition: 'retain' },
    guard,
    operationGuard,
  ),
});
const getEditor = createBotRemoteEditors({ ...deps,
  async create(input, operationGuard) {
    const owner = deps.owner(); deps.assertOwner(owner);
    operationGuard?.();
    let source;
    try { source = await botStore.getBotRemoteResourceSource(input.id); }
    catch (error) {
      // Only absence admits creation; a transient read failure must not start a second intent.
      if (!(error instanceof Error) || !error.message.includes('[NOT_FOUND]')) throw error;
    }
    deps.assertOwner(owner);
    if (!source) {
      await botStore.createBotProfile({ ...input, prepareInvitation: true }, operationGuard);
      deps.assertOwner(owner);
      operationGuard?.();
      source = await botStore.getBotRemoteResourceSource(input.id);
    }
    deps.assertOwner(owner);
    if (source.status !== 'active') throwIpcError('PRECONDITION_FAILED', 'Teammate unavailable');
    if (!source.canonicalSessionId && (!source.invitation || source.invitation.stage === 'ready')) {
      await botStore.createBotCanonicalSession(
        { botId: source.id, expectedCanonicalSessionId: null, expectedProfileVersion: source.currentVersion },
        operationGuard,
      );
    }
    deps.assertOwner(owner);
    operationGuard?.();
  },
  async avatar(botId, bytes, version, expectedAvatar, operationGuard) {
    const image = decodeBotAvatarImage(bytes);
    if (!image) throwIpcError('INVALID_PARAMS', 'Avatar required');
    await botStore.setBotProfileAvatar(botId, image, version, expectedAvatar, operationGuard);
  },
  skill: (botId: string, slug: string, operationGuard?: BotRemoteOperationGuard) => readBotSkillForBot(botId, slug, { operationGuard }),
  async saveSkill(botId, skill, operationGuard) {
    const owner = deps.owner();
    const { source } = await deps.read(botId);
    deps.assertOwner(owner);
    operationGuard?.();
    if (!source.canonicalSessionId) throwIpcError('PRECONDITION_FAILED', 'Teammate unavailable');
    const result = await saveBotSkillForSession({ callerSessionId: source.canonicalSessionId, ...skill }, { operationGuard });
    operationGuard?.();
    if (!result.ok) throwIpcError('PRECONDITION_FAILED', 'Skill could not be saved; refresh before retrying');
  },
  async removeSkill(botId, slug, operationGuard) {
    const owner = deps.owner(); const { source } = await deps.read(botId); deps.assertOwner(owner);
    operationGuard?.();
    await deleteBotSkillForBot(botId, slug, { operationGuard }); deps.assertOwner(owner);
    operationGuard?.();
    if (source.canonicalSessionId) await requestBotRuntimeEpochRefresh(source.canonicalSessionId, 'resource');
    operationGuard?.();
  },
  async capabilities(callerSessionId, kind, operationGuard) {
    operationGuard?.();
    const result = await listBotSettingsCapabilities({ callerSessionId, kind });
    operationGuard?.();
    return result;
  },
}, settings.bindResource);
async function getInvitation(context: RemoteResourceHostContext, botId: string) {
  const owner = deps.owner();
  const source = await botStore.getBotRemoteResourceSource(botId); deps.assertOwner(owner);
  const resource = botRemoteResourceFromSource(source);
  if (source.invitation?.stage !== 'failed' || source.status !== 'active') return resource;
  const revision = `${source.currentVersion}:${source.invitation.stage}:${source.status}`;
  return settings.bindResource(context, { ...resource, revision, actions: [{ id: 'retry-invitation', label: { fallback: 'Try Again', translations: { 'zh-CN': '重试', 'zh-TW': '重試', ja: '再試行', ko: '다시 시도' } } }] }, async () => {
    const current = await botStore.getBotRemoteResourceSource(botId); deps.assertOwner(owner);
    return `${current.currentVersion}:${current.invitation?.stage}:${current.status}`;
  }, async request => {
    if (request.actionId !== 'retry-invitation' || Object.keys(request.input ?? {}).length) throwIpcError('INVALID_PARAMS', 'Invalid invitation retry');
    deps.assertOwner(owner);
    const operationGuard: BotRemoteOperationGuard = () => { context.assertCurrent?.(); deps.assertOwner(owner); };
    await botStore.updateBotProfile({ id: botId, retryInvitation: true }, undefined, undefined, operationGuard);
    operationGuard();
    return { effects: [{ kind: 'refresh-collection', collectionId: 'teammates' }] };
  });
}
export const botRemoteManagement = { ...settings, getEditor, getInvitation };
