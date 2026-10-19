import type { CodexModelListItem } from './app-server/protocol.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const publicScalars = new Set([
  'model', 'review_model', 'model_provider', 'model_context_window', 'model_auto_compact_token_limit',
  'model_auto_compact_token_limit_scope', 'approval_policy', 'approvals_reviewer', 'sandbox_mode', 'web_search',
  'model_reasoning_effort', 'model_reasoning_summary', 'model_verbosity', 'service_tier', 'personality',
  'default_permissions', 'plan_mode_reasoning_effort', 'hide_agent_reasoning', 'show_raw_agent_reasoning',
  'disable_paste_burst', 'suppress_unstable_features_warning', 'check_for_update_on_startup', 'file_opener',
  'allow_login_shell', 'include_environment_context', 'include_permissions_instructions',
  'include_collaboration_mode_instructions', 'include_apps_instructions',
]);
const publicTuiScalars = new Set(['alternate_screen', 'animations', 'show_tooltips', 'theme']);
function scalars(source: Record<string, unknown>, fields: Set<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => fields.has(key)
    && (value === null || ['string', 'number', 'boolean'].includes(typeof value))));
}

/** The remote original frontend needs presentation config, never service credentials. */
export function projectCodexNativeConfig(value: unknown, runtime: {
  model: string; modelProvider?: string; effort?: string | null; serviceTier?: string | null;
}): { config: Record<string, unknown>; origins: Record<string, never>; layers: null } {
  if (!record(value) || !record(value.config)) throw new Error('Native config response is invalid');
  const source = value.config, config = scalars(source, publicScalars);
  config.model = runtime.model;
  if (runtime.modelProvider !== undefined) config.model_provider = runtime.modelProvider;
  if (runtime.effort !== undefined) config.model_reasoning_effort = runtime.effort;
  if (runtime.serviceTier !== undefined) config.service_tier = runtime.serviceTier;
  // Current upstream also supports structured approval policy. Keep every
  // declared boolean without copying arbitrary config or silently dropping it.
  if (record(source.approval_policy)) {
    const granular = source.approval_policy.granular;
    const fields = ['sandbox_approval', 'rules', 'skill_approval', 'request_permissions', 'mcp_elicitations'];
    if (!record(granular) || fields.some(key => typeof granular[key] !== 'boolean')) {
      throw new Error('Native approval policy cannot be projected');
    }
    config.approval_policy = { granular: Object.fromEntries(fields.map(key => [key, granular[key]])) };
  }
  if (record(source.features)) config.features = Object.fromEntries(Object.entries(source.features).filter(([, value]) => typeof value === 'boolean'));
  if (record(source.tui)) {
    config.tui = scalars(source.tui, publicTuiScalars);
    // Status-line values are built-in item identifiers, not arbitrary config or commands.
    if (Array.isArray(source.tui.status_line) && source.tui.status_line.every(item => typeof item === 'string' && /^[a-z0-9-]+$/.test(item))) {
      (config.tui as Record<string, unknown>).status_line = [...source.tui.status_line];
    }
  }
  if (record(source.model_providers)) {
    config.model_providers = Object.fromEntries(Object.entries(source.model_providers).flatMap(([name, value]) =>
      record(value) ? [[name, scalars(value, new Set(['name', 'wire_api', 'requires_openai_auth']))]] : []));
  }
  // Native origins can contain filenames and source values. They are not the
  // authority for Lex task overrides, and must not leak the service's config.
  return { config, origins: {}, layers: null };
}

export interface CodexNativeCatalogChoice {
  id: string; name: string; description?: string; visible: boolean;
  efforts: readonly string[]; defaultEffort: string; fastMode: boolean;
  imageInput?: boolean;
}
/** Project only the owning provider's resolved choices; wire aliases stay explicit. */
export function projectCodexNativeModels(choices: readonly CodexNativeCatalogChoice[],
  native: readonly CodexModelListItem[], selected: string): { data: CodexModelListItem[]; nextCursor: null } {
  const nativeById = new Map(native.map(model => [model.model, model]));
  const ids = new Set<string>();
  const data = choices.flatMap(choice => {
    if ((!choice.visible && choice.id !== selected) || ids.has(choice.id)) return [];
    ids.add(choice.id);
    const original = nativeById.get(choice.id);
    const descriptions = new Map(original?.supportedReasoningEfforts?.map(item => [item.reasoningEffort as string, item.description]) ?? []);
    const entry: CodexModelListItem = {
      id: choice.id, model: choice.id, displayName: choice.name, description: choice.description ?? '',
      hidden: !choice.visible, isDefault: choice.id === selected,
      supportedReasoningEfforts: choice.efforts.map(reasoningEffort => ({ reasoningEffort: reasoningEffort as CodexModelListItem['defaultReasoningEffort'],
        description: descriptions.get(reasoningEffort) ?? '' })),
      defaultReasoningEffort: choice.defaultEffort as CodexModelListItem['defaultReasoningEffort'],
      additionalSpeedTiers: choice.fastMode ? ['fast'] : [],
      serviceTiers: choice.fastMode ? [{ id: 'priority', name: 'Fast', description: '' }] : [],
    };
    // Optional protocol metadata is copied explicitly, never a future credential field.
    for (const key of ['inputModalities', 'supportsPersonality', 'multiAgentVersion', 'modelSpecialty'] as const) {
      const value = original?.[key];
      if (value === null || typeof value === 'string' || typeof value === 'boolean'
        || (Array.isArray(value) && value.every(item => typeof item === 'string'))) entry[key] = structuredClone(value);
    }
    if (choice.imageInput !== undefined) entry.inputModalities = choice.imageInput ? ['text', 'image'] : ['text'];
    return [entry];
  });
  return { data, nextCursor: null };
}
