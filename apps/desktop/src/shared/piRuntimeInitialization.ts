import type {
  AgentKind,
  ProviderPreset,
  ProviderPresetRuntime,
  ProviderRuntimeModelConfig,
} from '@cindy/model-providers';

/** Remote presets may predate explicit Pi protocol metadata. Such a runtime is not saveable. */
export function isConfiguredPresetRuntime(
  agent: AgentKind,
  runtime: ProviderPresetRuntime | undefined,
): runtime is ProviderPresetRuntime {
  return runtime !== undefined && (agent !== 'pi' || runtime.wireProtocol !== undefined);
}

export function configuredPresetAgents(preset: ProviderPreset): AgentKind[] {
  const agents = (Object.keys(preset.runtimes) as AgentKind[]).filter((agent) =>
    isConfiguredPresetRuntime(agent, preset.runtimes[agent]),
  );
  // 目录里的预设都不带 omp runtime,但 OMP 能由同预设的 claude-code runtime 派生
  // (见 presetRuntimeForAgent)。把它一并算作「该预设已配置的 engine」,
  // 这样选用预设时 OMP 也会被自动带上,用户不必手填。
  if (!agents.includes('omp') && presetRuntimeForAgent(preset, 'omp') !== undefined) {
    agents.push('omp');
  }
  return agents;
}

/**
 * 预设给某个 runtime 的配置。
 *
 * 内置目录的预设**都不声明** omp runtime(27/27),因为这份数据是上游维护的。
 * OMP 与 claude-code 同属 Anthropic Messages 家族,因此 omp 缺省回落到同一预设的
 * claude-code runtime —— 对 OMP 而言真正起作用的是**模型清单**:host 侧会把 OMP 的
 * baseUrl/密钥重写为 loopback proxy(见 maker-host/omp-host.ts 的
 * buildOmpManagedModelsYaml),所以这里借用 claude-code 的端点只为顺带带上模型。
 *
 * 没有 claude-code 的预设(如 vllm / llamacpp 只有 codex/pi)不做猜测,返回 undefined。
 */
export function presetRuntimeForAgent(
  preset: ProviderPreset,
  agent: AgentKind,
): ProviderPresetRuntime | undefined {
  return preset.runtimes[agent] ?? (agent === 'omp' ? preset.runtimes['claude-code'] : undefined);
}

export function savedCustomProviderModelShape(
  model: ProviderRuntimeModelConfig,
  includePiApi: boolean,
): ProviderRuntimeModelConfig {
  const { piApi, ...portable } = structuredClone(model);
  return {
    ...portable,
    id: model.id.trim(),
    name: model.name.trim(),
    ...(!includePiApi && !model.api && piApi ? { api: piApi } : {}),
    ...(includePiApi && piApi ? { piApi } : {}),
  };
}

/** Copy reasoning metadata into a runtime's supported vocabulary without mutating the source. */
export function adaptCustomProviderModelEfforts(
  source: ProviderRuntimeModelConfig,
  agent: AgentKind,
): ProviderRuntimeModelConfig {
  const model = structuredClone(source);
  // Adapt every representation before persistence; canonical metadata otherwise
  // bypasses the legacy field validator. Keep Pi's shared endpoint record intact.
  if (agent !== 'pi') {
    const supported = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
    if (model.reasoningEfforts) {
      model.reasoningEfforts = model.reasoningEfforts.filter(effort => supported.has(effort));
    }
    if (model.reasoningDefaultEffort != null &&
        (!supported.has(model.reasoningDefaultEffort) ||
          (model.reasoningEfforts && !model.reasoningEfforts.includes(model.reasoningDefaultEffort)))) {
      delete model.reasoningDefaultEffort;
    }
    for (const metadata of [model, model.discoveredMetadata]) {
      if (!metadata) continue;
      if (metadata.efforts) metadata.efforts = metadata.efforts.filter(effort => supported.has(effort));
      if (metadata.defaultEffort != null &&
          (!supported.has(metadata.defaultEffort) ||
            (metadata.efforts && !metadata.efforts.includes(metadata.defaultEffort)))) {
        delete metadata.defaultEffort;
      }
    }
  }
  return model;
}
