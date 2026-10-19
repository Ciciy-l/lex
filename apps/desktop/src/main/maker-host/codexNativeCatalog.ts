import { deriveModelList, isModelVisible, type CatalogModel } from '@cindy/model-providers';
import { projectCodexNativeConfig, projectCodexNativeModels, type CodexNativeTaskRoutingOptions, type CodexModelListItem } from '@cindy/maker-core';
import { getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getDesktopProviderService } from './createDesktopProviderService.js';
import { getModelVisibilityOverride, waitForModelVisibilityMirror } from './model-visibility-mirror.js';

export interface CodexNativeCatalogRuntime {
  /** Exact catalog identity, which can differ from the native server's alias. */
  model: string;
  /** Resolved connection identity. Never infer it from a model name. */
  providerId: string | null;
  nativeModel?: string;
  nativeModelProvider?: string;
  effort?: string;
  fastMode: boolean;
}

/** Same account/provider/visibility data as GUI, with no credential discovery side effects. */
export function createDesktopCodexNativeCatalog(context: {
  nativeSessionId: string;
  cwd: string;
  isCurrent(): boolean;
  readRuntime(): CodexNativeCatalogRuntime;
}): CodexNativeTaskRoutingOptions['catalog'] {
  const owner = { ...getActiveAppSession() };
  const assertCurrent = (signal: AbortSignal) => {
    const active = getActiveAppSession();
    if (signal.aborted || !context.isCurrent() || !context.nativeSessionId || isAppSessionBoundaryPending()
      || owner.dataOwnerId !== active.dataOwnerId || owner.generation !== active.generation) {
      throw new Error('Native catalog no longer belongs to this task');
    }
  };
  return async call => {
    assertCurrent(call.signal);
    const initial = { ...context.readRuntime() };
    if (!initial.providerId || !initial.model) throw new Error('Native catalog requires an exact task route');
    const providerId = initial.providerId;
    const check = () => {
      assertCurrent(call.signal);
      const live = context.readRuntime();
      if (live.model !== initial.model || live.providerId !== initial.providerId
        || live.nativeModelProvider !== initial.nativeModelProvider || live.nativeModel !== initial.nativeModel || live.effort !== initial.effort
        || live.fastMode !== initial.fastMode) throw new Error('Native catalog settings changed while reading');
    };
    if (call.request.method === 'config/read') {
      const value = await call.forward({ cwd: context.cwd, includeLayers: false });
      check();
      return projectCodexNativeConfig(value, { model: initial.model, modelProvider: initial.nativeModelProvider,
        effort: initial.effort, serviceTier: initial.fastMode ? 'fast' : null });
    }
    if (call.request.method === 'mcpServerStatus/list') {
      // The task router has already validated any explicitly requested child.
      // An omitted id must resolve to this task, never the service's global list.
      const params = call.request.params as Record<string, unknown> | undefined;
      const value = await call.forward({ ...params, threadId: params?.threadId ?? context.nativeSessionId });
      check(); return value;
    }
    if (call.request.method !== 'model/list') throw new Error('Native catalog operation is not supported');
    await waitForModelVisibilityMirror(); check();
    const providers = await getDesktopProviderService().listProviders({ allowSideEffects: false });
    check();
    const selectedProvider = providers.filter(provider => provider.id === initial.providerId);
    if (selectedProvider.length !== 1) throw new Error('Native task provider is unavailable');
    const visible = (providerId: string, model: CatalogModel) =>
      isModelVisible(getModelVisibilityOverride('codex', providerId, model.id, model.visibilityAliases), model.defaultEnabled);
    const models = deriveModelList({ providers: selectedProvider, agent: 'codex',
      providerScope: 'connected-for-agent', dedupe: 'none', isVisible: visible,
      keepSelected: { providerId: initial.providerId, modelId: initial.model } });
    // Read presentation metadata from this concrete service. Membership,
    // reasoning, Fast and known image capabilities still come from the task route.
    const native: CodexModelListItem[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; ; page++) {
      if (page >= 10) throw new Error('Native model metadata pagination is incomplete');
      const response = await call.forward({ cursor, limit: 100, includeHidden: true }) as
        { data?: CodexModelListItem[]; nextCursor?: unknown } | null;
      check();
      if (!response || !Array.isArray(response.data) || response.data.some(row => !row || typeof row.model !== 'string')
        || (response.nextCursor !== null && typeof response.nextCursor !== 'string')) {
        throw new Error('Native model metadata response is invalid');
      }
      native.push(...response.data);
      if (response.nextCursor === null) break;
      cursor = response.nextCursor as string;
      if (cursors.has(cursor)) throw new Error('Native model metadata cursor repeated');
      cursors.add(cursor);
    }
    // Preserve the actual selected model's alias metadata without using that
    // alias as a product catalog identity or borrowing another connection.
    const currentNative = native.find(row => row.model === initial.nativeModel);
    const metadata = native.filter(row => row.model !== initial.model);
    const current = currentNative ?? native.find(row => row.model === initial.model);
    if (current) metadata.push({ ...current, model: initial.model });
    const data = models.map(model => ({ id: model.id, name: model.name, description: model.description,
      visible: visible(providerId, model), efforts: model.efforts,
      defaultEffort: model.defaultEffort ?? 'none', fastMode: model.supportsFastMode === true,
      imageInput: model.supportsImageInput }));
    check();
    return projectCodexNativeModels(data, metadata, initial.model);
  };
}
