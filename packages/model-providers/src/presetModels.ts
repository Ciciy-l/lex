import type { AgentKind } from './types.js';

const AGENTS: readonly AgentKind[] = ['claude-code', 'codex', 'pi', 'omp'];
const isAgent = (value: unknown): value is AgentKind =>
  typeof value === 'string' && (AGENTS as readonly string[]).includes(value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function malformedScope(model: unknown, declared: readonly string[]): boolean {
  if (!isRecord(model)) return true;
  if (model.engines !== undefined && (!Array.isArray(model.engines) || model.engines.length === 0 ||
      new Set(model.engines).size !== model.engines.length ||
      !model.engines.every((agent) => isAgent(agent) && declared.includes(agent)))) return true;
  return model.engineOverrides !== undefined && (!isRecord(model.engineOverrides) ||
    !Object.entries(model.engineOverrides).every(([agent, override]) =>
      isAgent(agent) && declared.includes(agent) && isRecord(override)));
}

/** Expand the new shared preset list, leaving legacy runtime.models documents untouched. */
export function expandPresetModels<T>(preset: T): T {
  if (!isRecord(preset) || !Array.isArray(preset.models)) return preset;
  if (!isRecord(preset.runtimes)) return preset;
  const runtimes = preset.runtimes;
  const sharedModels = preset.models as unknown[];
  const declared = Object.keys(runtimes);
  if (
    declared.length === 0
    || Object.values(runtimes).some((runtime) => !isRecord(runtime))
    || sharedModels.some((model) => malformedScope(model, declared))
  ) return preset;
  const expanded = Object.fromEntries(Object.entries(runtimes).map(([agent, runtime]) => {
    if (!isRecord(runtime)) return [agent, runtime];
    const models = sharedModels.flatMap((value) => {
      if (!isRecord(value)) return [value];
      const { engines, engineOverrides, ...shared } = value;
      if (Array.isArray(engines) && !engines.includes(agent)) return [];
      const override = isRecord(engineOverrides) ? engineOverrides[agent] : undefined;
      return [{ ...shared, ...(isRecord(override) ? override : {}) }];
    });
    return [agent, { ...runtime, models }];
  }));
  const { models: _models, ...rest } = preset;
  return { ...rest, runtimes: expanded } as T;
}
