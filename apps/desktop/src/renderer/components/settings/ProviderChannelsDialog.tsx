import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PROVIDER_WIRE_PROTOCOLS,
  BUNDLED_CATALOG,
  planLegacyProviderChannels,
  presetDisplayName,
  sortPresetsForRegion,
  channelProtocolProviderId,
  type CustomProviderConfig,
  type CustomProviderRuntimeConfig,
  type ProviderChannel,
  type ProviderWireProtocol,
} from '@cindy/model-providers';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Check, Plus, Sparkles } from 'lucide-react';
import { ProviderSetupTabs } from './ProviderSetupTabs';
import { Textarea } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { SettingsTextInput } from './SettingsTextInput';
import { cn } from '@/lib/utils';
import { ProviderModelIdsField } from './ProviderModelIdsField';
import {
  appendDiscoveredCustomProviderModels,
  createCustomProvider,
  updateCustomProvider,
} from '@/lib/customProviders';
import { firstProviderChatModel } from '@/lib/providerModelFetch';
import type { ProviderChannelKeys } from '@/../shared/customProviderUpdate';
import { extractIpcError } from '@/utils/ipcError';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { useAuth } from '@/contexts/AuthContext';

const protocolLabelKeys: Record<ProviderWireProtocol, string> = {
  'anthropic-messages': 'models.channels.protocolNames.anthropicMessages',
  'openai-responses': 'models.channels.protocolNames.openaiResponses',
  'openai-chat': 'models.channels.protocolNames.openaiChat',
  'google-generative-ai': 'models.channels.protocolNames.googleGemini',
};
const newId = () => 'channel-' + crypto.randomUUID();

export interface ProviderChannelsDialogProps {
  initial?: CustomProviderConfig;
  existingIds?: string[];
  returnFocusRef?: RefObject<HTMLElement | null>;
  onSaved(): void;
  onClose(): void;
  onHarnessSetup?(): void;
  suspended?: boolean;
  focusSetupTab?: boolean;
}

/** Credentials are write-only form input. Saved values never return to this view. */
export function ProviderChannelsDialog(p: ProviderChannelsDialogProps) {
  const { t, i18n } = useTranslation();
  const { serviceRealm } = useAuth();
  const [catalogPresets, setCatalogPresets] = useState(BUNDLED_CATALOG.presets ?? []);
  const formId = useId();
  const panelId = formId + '-panel';
  const [appliedPreset, setAppliedPreset] = useState('');
  const nameInput = useRef<HTMLInputElement>(null);
  const requestPending = useRef(false);
  const transferringFocus = useRef(false);
  const opener = useRef(document.activeElement as HTMLElement | null);
  const owner = useRef(getDataOwnerGeneration());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const isCurrent = () => alive.current && isDataOwnerGenerationCurrent(owner.current);
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.maker
      .listProviderPresets()
      .then((result) => {
        if (!cancelled && alive.current && isDataOwnerGenerationCurrent(owner.current))
          setCatalogPresets(result.presets);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const [config, setConfig] = useState<CustomProviderConfig>(() =>
    p.initial
      ? structuredClone(p.initial)
      : {
          id: 'supplier-' + crypto.randomUUID().replaceAll('-', '').slice(0, 30),
          name: '',
          runtimes: {},
          channels: {
            version: 1,
            channels: [
              {
                id: newId(),
                name: t('models.channels.defaultName'),
                protocols: {
                  'openai-responses': { baseUrl: '', wireProtocol: 'openai-responses', models: [] },
                },
              },
            ],
          },
        },
  );
  const [protocol, setProtocol] = useState<ProviderWireProtocol>(
    () =>
      (Object.keys(config.channels!.channels[0]?.protocols ?? {})[0] as ProviderWireProtocol) ||
      'openai-responses',
  );
  const [selectedId, setSelectedId] = useState(config.channels!.channels[0]?.id ?? '');
  const [keys, setKeys] = useState<ProviderChannelKeys>({});
  /** Rows, not a joined string: an empty array is zero rows, [""] is one blank row. */
  const [modelDrafts, setModelDrafts] = useState<Record<string, string[]>>({});
  const [modelEntryDrafts, setModelEntryDrafts] = useState<Record<string, string>>({});
  const [headerDrafts, setHeaderDrafts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState(false);
  const [pendingAction, setPendingAction] = useState<
    { kind: 'close' } | { kind: 'preset'; id: string } | null
  >(null);
  const channelButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const initialSnapshot = useRef(JSON.stringify(config));
  const dirty =
    JSON.stringify(config) !== initialSnapshot.current ||
    Object.keys(keys).length > 0 ||
    Object.keys(modelDrafts).length > 0 ||
    Object.values(modelEntryDrafts).some((value) => value.trim().length > 0) ||
    Object.keys(headerDrafts).length > 0;
  const hasPendingModelEntry = Object.values(modelEntryDrafts)
    .some((value) => value.trim().length > 0);
  const invalidate = () => {
    setError(null);
    setMessage(null);
    setConfirmation(false);
  };
  const close = () => {
    if (requestPending.current) return;
    if (dirty) setPendingAction({ kind: 'close' });
    else p.onClose();
  };
  const selectRoute = (wire: ProviderWireProtocol, id?: string) => {
    invalidate();
    setProtocol(wire);
    setSelectedId(id ?? '');
  };
  const presets = sortPresetsForRegion(catalogPresets, serviceRealm).filter(
    (preset) =>
      Object.values(preset.runtimes).every((runtime) => runtime && !/[{}]/.test(runtime.baseUrl)) &&
      planLegacyProviderChannels(
        { id: 'template', name: preset.name, runtimes: preset.runtimes },
        {},
      ) !== null,
  );
  const applyPreset = (id: string) => {
    const preset = presets.find((item) => item.id === id);
    if (!preset || p.initial) return;
    const runtimes: CustomProviderConfig['runtimes'] = structuredClone(preset.runtimes);
    for (const runtime of Object.values(runtimes)) {
      if (!runtime) continue;
      runtime.catalogPresetId = preset.id;
      runtime.models = runtime.models.map((model) => ({
        ...model,
        defaultEnabled: model.defaultEnabled ?? true,
      }));
    }
    const prepared: CustomProviderConfig = {
      id: config.id,
      name: presetDisplayName(preset, i18n.language),
      runtimes,
      ...(preset.authMethod === 'none' ? { auth: { method: 'none' } } : {}),
    };
    const plan = planLegacyProviderChannels(
      prepared,
      Object.fromEntries(
        Object.entries(runtimes).map(([agent, runtime]) => [
          agent,
          JSON.stringify(runtime?.headers ?? {}),
        ]),
      ),
    );
    if (!plan) return;
    for (const copy of plan.credentials) {
      const headers = prepared.runtimes[copy.agent]?.headers;
      if (headers)
        plan.configuration.channels.find((channel) => channel.id === copy.channelId)!.protocols[
          copy.protocol
        ]!.headers = structuredClone(headers);
    }
    // New presets have no historical engine bindings. Their named connections
    // can be combined explicitly; unrelated preset endpoints stay separate.
    delete plan.configuration.legacyBindings;
    for (const channel of plan.configuration.channels)
      channel.name = t('models.channels.numberedName', {
        number: plan.configuration.channels.indexOf(channel) + 1,
      });
    setConfig({ ...prepared, channels: plan.configuration });
    setAppliedPreset(id);
    setKeys({});
    setModelDrafts({});
    setModelEntryDrafts({});
    setHeaderDrafts({});
    setConfirmation(false);
    setSelectedId(plan.configuration.channels[0].id);
    setProtocol(Object.keys(plan.configuration.channels[0].protocols)[0] as ProviderWireProtocol);
  };
  const channels = config.channels!.channels;
  /** Same visible names are still distinct channels; expose a stable instance ordinal. */
  const nameInstance = (entry: ProviderChannel) => {
    const sameName = channels.filter((item) => item.name === entry.name);
    return { position: sameName.indexOf(entry) + 1, total: sameName.length };
  };
  const available = channels.filter((channel) => channel.protocols[protocol]);
  const channel = available.find((entry) => entry.id === selectedId) ?? available[0];
  const connection = channel?.protocols[protocol];
  const draftId = channel ? channelProtocolProviderId(channel.id, protocol) : '';
  const availableForProtocol = (wire: ProviderWireProtocol) =>
    channels.filter((entry) => entry.protocols[wire]);
  const selectProtocol = (wire: ProviderWireProtocol) => {
    const retainedChannel = channel?.protocols[wire] ? channel.id : undefined;
    selectRoute(wire, retainedChannel ?? availableForProtocol(wire)[0]?.id);
  };
  const protocolName = (wire: ProviderWireProtocol) => t(protocolLabelKeys[wire]);
  /** Saves trim, drop blanks and de-duplicate exactly; rows keep the user's edit state. */
  const normalizeModelIds = (rows: readonly string[]): string[] => {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const row of rows) {
      const id = row.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return ids;
  };
  const modelIdRows = (id: string, models: readonly { id: string }[]): string[] =>
    modelDrafts[id] ?? models.map((model) => model.id);
  const draftModelsFor = (entry: ProviderChannel, wire: ProviderWireProtocol): string[] => {
    const route = entry.protocols[wire];
    if (!route) return [];
    return normalizeModelIds(
      modelIdRows(channelProtocolProviderId(entry.id, wire), route.models),
    );
  };
  const currentModelIds = connection ? modelIdRows(draftId, connection.models) : [];
  const updateCurrentModelIds = (ids: readonly string[]) => {
    if (!draftId) return;
    invalidate();
    setModelDrafts((previous) => ({ ...previous, [draftId]: [...ids] }));
  };
  const prepareConfig = (onlyRoute?: string): CustomProviderConfig => {
    const next = structuredClone(config);
    for (const item of next.channels!.channels) {
      for (const [wire, route] of Object.entries(item.protocols)) {
        const id = channelProtocolProviderId(item.id, wire as ProviderWireProtocol);
        if (onlyRoute && onlyRoute !== id) continue;
        const rows = modelDrafts[id];
        if (rows !== undefined) {
          const existing = new Map(route.models.map((model) => [model.id, model]));
          route.models = normalizeModelIds(rows).map(
            (id) => existing.get(id) ?? { id, name: id, defaultEnabled: true },
          );
        }
        const headers = headerDrafts[id];
        if (headers !== undefined) {
          try {
            const parsed: unknown = headers.trim() ? JSON.parse(headers) : {};
            if (
              !parsed ||
              typeof parsed !== 'object' ||
              Array.isArray(parsed) ||
              Object.values(parsed).some((value) => typeof value !== 'string')
            )
              throw new Error();
            route.headers = parsed as Record<string, string>;
          } catch {
            selectRoute(wire as ProviderWireProtocol, item.id);
            throw new Error(t('models.channels.invalidHeaders'));
          }
        }
        try {
          const url = new URL(route.baseUrl);
          if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
            throw new Error();
        } catch {
          selectRoute(wire as ProviderWireProtocol, item.id);
          throw new Error(t('models.channels.invalidUrl'));
        }
      }
    }
    return next;
  };
  const updateChannel = (id: string, edit: (channel: ProviderChannel) => ProviderChannel) => {
    setConfig((previous) => ({
      ...previous,
      channels: {
        ...previous.channels!,
        channels: previous.channels!.channels.map((channel) =>
          channel.id === id ? edit(channel) : channel,
        ),
      },
    }));
    setError(null);
    setMessage(null);
    setConfirmation(false);
  };
  const updateConnection = (patch: Partial<CustomProviderRuntimeConfig>) => {
    if (!channel || !connection) return;
    const routeChanged =
      (patch.baseUrl !== undefined && patch.baseUrl !== connection.baseUrl) ||
      ('requestPath' in patch && patch.requestPath !== connection.requestPath);
    const models = routeChanged
      ? connection.models.map((model) => {
          const metadata = { ...model };
          delete metadata.route;
          delete metadata.discoveredCost;
          return metadata;
        })
      : connection.models;
    updateChannel(channel.id, (current) => ({
      ...current,
      protocols: { ...current.protocols, [protocol]: { ...connection, models, ...patch } },
    }));
  };
  const add = (existingId?: string) => {
    invalidate();
    const next = { baseUrl: '', wireProtocol: protocol, models: [] };
    if (existingId) {
      updateChannel(existingId, (current) => ({
        ...current,
        protocols: { ...current.protocols, [protocol]: next },
      }));
      setSelectedId(existingId);
    } else {
      const id = newId();
      setConfig((previous) => ({
        ...previous,
        channels: {
          ...previous.channels!,
          channels: [
            ...previous.channels!.channels,
            {
              id,
              name: t('models.channels.numberedName', {
                number: previous.channels!.channels.length + 1,
              }),
              protocols: { [protocol]: next },
            },
          ],
        },
      }));
      setSelectedId(id);
    }
  };
  const remove = () => {
    if (!channel) return;
    invalidate();
    setModelDrafts((previous) => {
      const next = { ...previous };
      delete next[draftId];
      return next;
    });
    setModelEntryDrafts((previous) => {
      const next = { ...previous };
      delete next[draftId];
      return next;
    });
    setHeaderDrafts((previous) => {
      const next = { ...previous };
      delete next[draftId];
      return next;
    });
    setConfig((previous) => {
      const next = previous.channels!.channels.flatMap((entry) => {
        if (entry.id !== channel.id) return [entry];
        const protocols = { ...entry.protocols };
        delete protocols[protocol];
        return Object.keys(protocols).length ? [{ ...entry, protocols }] : [];
      });
      const legacyBindings = Object.fromEntries(
        Object.entries(previous.channels!.legacyBindings ?? {}).filter(([, id]) =>
          next.some((entry) => entry.id === id),
        ),
      );
      return {
        ...previous,
        channels: {
          ...previous.channels!,
          channels: next,
          ...(previous.channels!.legacyBindings ? { legacyBindings } : {}),
        },
      };
    });
    setKeys((previous) => {
      const next = { ...previous, [channel.id]: { ...previous[channel.id] } };
      delete next[channel.id][protocol];
      if (!Object.keys(next[channel.id]).length) delete next[channel.id];
      return next;
    });
  };
  const save = async (interrupt = false) => {
    if (requestPending.current || !isCurrent()) return;
    if (hasPendingModelEntry) {
      setError(t('models.channels.pendingModelId'));
      return;
    }
    requestPending.current = true;
    setBusy(true);
    setError(null);
    let prepared: CustomProviderConfig;
    try {
      prepared = prepareConfig();
    } catch (error) {
      setError((error as Error).message);
      requestPending.current = false;
      setBusy(false);
      return;
    }
    try {
      const options = {
        source: 'manual-settings' as const,
        channelKeys: keys,
        ...(interrupt ? { codexImageGenerationRestartPolicy: 'interrupt' as const } : {}),
      };
      const result = await (p.initial ? updateCustomProvider : createCustomProvider)(
        prepared,
        {},
        options,
      );
      if (!isCurrent()) return;
      if (!result.ok) {
        setConfirmation(true);
        return;
      }
      setKeys({});
      p.onSaved();
    } catch (error) {
      if (isCurrent())
        setError(extractIpcError(error)?.message ?? t('models.channels.requestFailed'));
    } finally {
      requestPending.current = false;
      if (isCurrent()) setBusy(false);
    }
  };
  const request = async (discover: boolean) => {
    if (requestPending.current || !channel || !connection || !isCurrent()) return;
    if (modelEntryDrafts[draftId]?.trim()) {
      setError(t('models.channels.pendingModelId'));
      return;
    }
    requestPending.current = true;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const route = prepareConfig(draftId).channels!.channels.find(
        (item) => item.id === channel.id,
      )!.protocols[protocol]!;
      const saved = p.initial?.channels?.channels.find((item) => item.id === channel.id)?.protocols[
        protocol
      ];
      const authMethod = config.auth?.method === 'none' ? ('none' as const) : ('apiKey' as const);
      // Probes send chat-shaped requests; a media model at index 0 must not
      // become the probe target just because the user reordered the list.
      const probeModel = firstProviderChatModel(route.models);
      const credentialsUntouched =
        keys[channel.id]?.[protocol] === undefined &&
        headerDrafts[draftId] === undefined &&
        p.initial?.auth?.method === config.auth?.method;
      const useSaved =
        !!saved &&
        saved.baseUrl === route.baseUrl &&
        saved.modelsUrl === route.modelsUrl &&
        saved.requestPath === route.requestPath &&
        credentialsUntouched;
      const draftCredentials =
        keys[channel.id]?.[protocol] !== undefined || headerDrafts[draftId] !== undefined;
      if (!discover && !useSaved && authMethod !== 'none' && !draftCredentials) {
        // Never send an unauthenticated probe for an edited model or endpoint:
        // stored credentials stay Main-only and must not follow a new endpoint.
        setError(t('models.channels.testNeedsCredentials'));
        return;
      }
      const common = {
        agent: 'pi' as const,
        baseUrl: route.baseUrl,
        wireProtocol: protocol,
        authMethod,
        modelsUrl: route.modelsUrl ?? null,
        apiKey: keys[channel.id]?.[protocol] ?? null,
        headers: route.headers,
      };
      if (discover) {
        const result = await window.electronAPI.maker.fetchProviderModels({
          ...common,
          ...(useSaved ? { savedProviderId: draftId } : {}),
        });
        if (!isCurrent()) return;
        if (!result.ok || !result.models) {
          setError(
            result.code ? t(`providerError.${result.code}`) : t('models.channels.requestFailed'),
          );
          return;
        }
        const merged = appendDiscoveredCustomProviderModels(
          route.models,
          result.models,
          route.modelsUrl,
        );
        const known = new Set(route.models.map((model) => model.id));
        updateConnection({
          models: merged.models.map((model) =>
            known.has(model.id) ? model : { ...model, defaultEnabled: true },
          ),
        });
        setModelDrafts((previous) => ({
          ...previous,
          [draftId]: merged.models.map((model) => model.id),
        }));
        setModelEntryDrafts((previous) => {
          const next = { ...previous };
          delete next[draftId];
          return next;
        });
      } else {
        // A model may override the channel route; the probe must target the
        // exact route the real session would use for this model.
        const probeRoute = probeModel?.route;
        const probeBaseUrl = probeRoute?.baseUrl ?? route.baseUrl;
        const probeWireProtocol = probeRoute?.wireProtocol ?? protocol;
        const probeRequestPath = probeRoute?.requestPath ?? route.requestPath;
        const probeApi = probeModel?.api ?? probeModel?.piApi;
        const result = await window.electronAPI.maker.testProviderConnection(
          useSaved
            ? {
                kind: 'saved',
                providerId: draftId,
                agent: 'pi',
                ...(probeModel?.id ? { modelId: probeModel.id } : {}),
                // Main verifies this against the saved route before reading the
                // stored key; it never probes the endpoint claimed here.
                endpoint: {
                  baseUrl: probeBaseUrl,
                  wireProtocol: probeWireProtocol,
                  modelsUrl: route.modelsUrl ?? null,
                  ...(probeRequestPath ? { requestPath: probeRequestPath } : {}),
                },
              }
            : {
                kind: 'adhoc',
                spec: {
                  ...common,
                  baseUrl: probeBaseUrl,
                  wireProtocol: probeWireProtocol,
                  modelId: probeModel?.id ?? '',
                  ...(probeRequestPath ? { requestPath: probeRequestPath } : {}),
                  ...(probeApi ? { api: probeApi } : {}),
                  ...(route.catalogPresetId ? { catalogPresetId: route.catalogPresetId } : {}),
                },
              },
        );
        if (!isCurrent()) return;
        if (!result.ok) {
          setError(
            result.code ? t(`providerError.${result.code}`) : t('models.channels.requestFailed'),
          );
          return;
        }
        setMessage(t('models.channels.connected'));
      }
    } catch (error) {
      if (isCurrent())
        setError(
          error instanceof Error &&
            [t('models.channels.invalidHeaders'), t('models.channels.invalidUrl')].includes(
              error.message,
            )
            ? error.message
            : t('models.channels.requestFailed'),
        );
    } finally {
      requestPending.current = false;
      if (isCurrent()) setBusy(false);
    }
  };
  return (
    <Dialog.Root
      open={!p.suspended}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[10000] bg-[var(--overlay-modal)]" />
        <Dialog.Content
          onPointerDownOutside={(event) => {
            event.preventDefault();
            close();
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            transferringFocus.current = false;
            if (p.focusSetupTab) document.getElementById(panelId + '-protocol')?.focus();
            else nameInput.current?.focus();
          }}
          aria-describedby={formId + '-description'}
          onEscapeKeyDown={(event) => {
            if (requestPending.current || event.isComposing || event.keyCode === 229)
              event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // A form transition hands focus to the next layer, not the outer trigger.
            if (transferringFocus.current) return;
            const target = p.returnFocusRef?.current ?? opener.current;
            if (target?.isConnected) target.focus();
          }}
          className="fixed left-1/2 top-1/2 z-[10001] flex max-h-[88vh] w-[min(600px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--confirm-bg)] text-[var(--text-primary)] shadow-[var(--confirm-shadow)] [-webkit-app-region:no-drag]"
        >
          <header className="flex shrink-0 flex-col items-start gap-3 px-4 py-3">
            <Dialog.Title className="flex items-center gap-2.5 text-18 font-semibold">
              <Sparkles size={20} />
              {t(
                p.initial
                  ? 'settings.providers.custom.dialog.editTitle'
                  : 'settings.providers.custom.dialog.createTitle',
              )}
            </Dialog.Title>
            {p.onHarnessSetup && (
              <ProviderSetupTabs
                mode="protocol"
                panelId={panelId}
                disabled={busy}
                onChange={() => {
                  if (requestPending.current) return;
                  transferringFocus.current = true;
                  p.onHarnessSetup?.();
                }}
              />
            )}
            <div className="flex w-full flex-col gap-2">
              <span className="text-13 text-[var(--text-primary)]">
                {t('models.channels.protocol')}
              </span>
              <SegmentedControl
                role="tablist"
                aria-label={t('models.channels.protocol')}
                value={protocol}
                disabled={busy}
                fullWidth
                height={38}
                optionHeight={30}
                optionClassName="text-12 px-2"
                options={PROVIDER_WIRE_PROTOCOLS.map((wire) => {
                  const count = availableForProtocol(wire).length;
                  return {
                    value: wire,
                    id: `${panelId}-protocol-tab-${wire}`,
                    label: (
                      <>
                        <span>{protocolName(wire)}</span>
                        <span
                          aria-hidden="true"
                          className="rounded-full bg-[var(--surface-chip)] px-1.5 py-0.5 text-11 tabular-nums text-[var(--text-secondary)]"
                        >
                          {count}
                        </span>
                      </>
                    ),
                    'aria-label': t('models.channels.protocolTabLabel', {
                      protocol: protocolName(wire),
                      count,
                    }),
                    'aria-controls': panelId + '-protocol-panel',
                  };
                })}
                onValueChange={(wire) => selectProtocol(wire)}
              />
            </div>
          </header>
          <div className="min-h-0 overflow-y-auto">
            <fieldset
              id={panelId}
              role={p.onHarnessSetup ? 'tabpanel' : undefined}
              aria-labelledby={p.onHarnessSetup ? panelId + '-protocol' : undefined}
              disabled={busy}
              className="flex min-w-0 flex-col gap-4 px-4 pb-4 pt-1"
            >
              <Dialog.Description
                id={formId + '-description'}
                className="text-13 leading-[1.55] text-[var(--text-secondary)]"
              >
                {t('models.channels.settingsDescription')}
              </Dialog.Description>
              {!p.initial && (
                <label className="flex flex-col gap-1 text-13">
                  {t('settings.providers.custom.presets.label')}
                  <Select
                    label={t('settings.providers.custom.presets.label')}
                    value={appliedPreset}
                    disabled={busy}
                    options={presets.map((preset) => ({
                      value: preset.id,
                      label: presetDisplayName(preset, i18n.language),
                    }))}
                    onValueChange={(id) =>
                      dirty ? setPendingAction({ kind: 'preset', id }) : applyPreset(id)
                    }
                  />
                </label>
              )}
              <label className="flex flex-col gap-1 text-13">
                {t('models.channels.supplierName')}
                <SettingsTextInput
                  inputRef={nameInput}
                  size="md"
                  value={config.name}
                  maxLength={60}
                  onChange={(value) => {
                    invalidate();
                    setConfig((previous) => ({ ...previous, name: value }));
                  }}
                />
              </label>
              <div
                id={panelId + '-protocol-panel'}
                role="tabpanel"
                aria-labelledby={`${panelId}-protocol-tab-${protocol}`}
                tabIndex={-1}
                className="flex min-w-0 flex-col gap-4 outline-none"
              >
              <div
                id={panelId + '-route'}
                className="grid grid-cols-1 gap-2 sm:grid-cols-2"
              >
                <div
                  role="radiogroup"
                  aria-label={t('models.channels.chooseChannel')}
                  className="contents"
                >
                {available.map((entry, index) => {
                  const selected = entry.id === channel?.id;
                  const associatedProtocols = PROVIDER_WIRE_PROTOCOLS
                    .filter((wire) => entry.protocols[wire]);
                  const instance = nameInstance(entry);
                  const duplicatedName = instance.total > 1;
                  return (
                    <button
                      key={entry.id}
                      ref={(node) => {
                        if (node) channelButtonRefs.current.set(entry.id, node);
                        else channelButtonRefs.current.delete(entry.id);
                      }}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-label={t(
                        duplicatedName
                          ? 'models.channels.channelOptionLabelWithInstance'
                          : 'models.channels.channelOptionLabel',
                        {
                          name: entry.name,
                          protocol: protocolName(protocol),
                          models: draftModelsFor(entry, protocol).length,
                          position: instance.position,
                          total: instance.total,
                        },
                      )}
                      tabIndex={selected ? 0 : -1}
                      data-channel-id={entry.id}
                      className={cn(
                        'flex min-h-16 min-w-0 flex-col gap-1 rounded-xl border px-3 py-2 text-left outline-none transition-colors',
                        'focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                        selected
                          ? 'border-[var(--settings-input-border-focus)] bg-[var(--surface-elevated)]'
                          : 'border-[var(--border-default)] bg-transparent hover:bg-[var(--surface-hover)]',
                      )}
                      onClick={() => selectRoute(protocol, entry.id)}
                      onKeyDown={(event) => {
                        const rtl =
                          getComputedStyle(event.currentTarget).direction === 'rtl';
                        let nextIndex: number;
                        switch (event.key) {
                          case 'ArrowRight': nextIndex = index + (rtl ? -1 : 1); break;
                          case 'ArrowDown': nextIndex = index + 1; break;
                          case 'ArrowLeft': nextIndex = index + (rtl ? 1 : -1); break;
                          case 'ArrowUp': nextIndex = index - 1; break;
                          case 'Home': nextIndex = 0; break;
                          case 'End': nextIndex = available.length - 1; break;
                          default: return;
                        }
                        event.preventDefault();
                        const wrapped = (nextIndex + available.length) % available.length;
                        const next = available[wrapped];
                        selectRoute(protocol, next.id);
                        requestAnimationFrame(() => channelButtonRefs.current.get(next.id)?.focus());
                      }}
                    >
                      <span className="flex w-full items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-13 font-medium text-[var(--text-primary)]">
                          {entry.name}
                        </span>
                        {duplicatedName && (
                          <span
                            aria-hidden="true"
                            className="shrink-0 rounded-full bg-[var(--surface-chip)] px-1.5 py-0.5 text-11 tabular-nums text-[var(--text-secondary)]"
                          >
                            {t('models.channels.channelInstanceSuffix', {
                              position: instance.position,
                              total: instance.total,
                            })}
                          </span>
                        )}
                        {selected && <Check size={15} aria-hidden="true" />}
                      </span>
                      <span className="text-12 text-[var(--text-secondary)]">
                        {t('models.channels.channelSummary', {
                          protocols: associatedProtocols.length,
                          models: draftModelsFor(entry, protocol).length,
                        })}
                      </span>
                      <span className="text-11 leading-snug text-[var(--text-tertiary)] [overflow-wrap:anywhere]">
                        {associatedProtocols.map((wire) => protocolName(wire)).join(' · ')}
                      </span>
                    </button>
                  );
                })}
                </div>
                <button
                  type="button"
                  onClick={() => add()}
                  className="flex min-h-16 items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--border-default)] px-3 text-13 font-medium text-[var(--text-secondary)] outline-none transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                >
                  <Plus size={15} aria-hidden="true" />
                  {t('models.channels.add')}
                </button>
              </div>
              {channels.some((entry) => !entry.protocols[protocol]) && (
                <div className="flex flex-col gap-2">
                  <span className="text-13 text-[var(--text-primary)]">{t('models.channels.attach')}</span>
                  <div className="flex flex-wrap gap-2">
                    {channels
                      .filter((entry) => !entry.protocols[protocol])
                      .map((entry) => {
                        const instance = nameInstance(entry);
                        return (
                          <Button
                            key={entry.id}
                            type="button"
                            variant="secondary"
                            size="sm"
                            aria-label={
                              instance.total > 1
                                ? `${entry.name} ${t('models.channels.channelInstanceSuffix', {
                                    position: instance.position,
                                    total: instance.total,
                                  })}`
                                : undefined
                            }
                            onClick={() => add(entry.id)}
                          >
                            <Plus size={13} aria-hidden="true" />
                            {entry.name}
                            {instance.total > 1 && (
                              <span className="tabular-nums text-[var(--text-tertiary)]">
                                {t('models.channels.channelInstanceSuffix', {
                                  position: instance.position,
                                  total: instance.total,
                                })}
                              </span>
                            )}
                          </Button>
                        );
                      })}
                  </div>
                </div>
              )}
              {channel && connection && (
                <>
                  <label className="flex flex-col gap-1 text-13">
                    {t('models.channels.channelName')}
                    <SettingsTextInput
                      size="md"
                      value={channel.name}
                      maxLength={60}
                      onChange={(value) =>
                        updateChannel(channel.id, (entry) => ({ ...entry, name: value }))
                      }
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-13">
                    Base URL
                    <SettingsTextInput
                      size="md"
                      value={connection.baseUrl}
                      spellCheck={false}
                      onChange={(value) => updateConnection({ baseUrl: value })}
                    />
                  </label>
                  {config.auth?.method !== 'none' && (
                    <label className="flex flex-col gap-1 text-13">
                      API Key
                      <SettingsTextInput
                        size="md"
                        secret
                        secretTipContentClassName="z-[10002]"
                        autoComplete="new-password"
                        value={keys[channel.id]?.[protocol] ?? ''}
                        placeholder={p.initial ? t('models.channels.keepKey') : ''}
                        onChange={(value) => {
                          invalidate();
                          setKeys((previous) => ({
                            ...previous,
                            [channel.id]: { ...previous[channel.id], [protocol]: value },
                          }));
                        }}
                      />
                    </label>
                  )}
                  {/* Main drops stored credentials for exactly these changes. */}
                  {p.initial?.channels?.channels.some(
                    (entry) =>
                      entry.id === channel.id &&
                      entry.protocols[protocol] &&
                      (entry.protocols[protocol]!.baseUrl !== connection.baseUrl ||
                        entry.protocols[protocol]!.modelsUrl !== connection.modelsUrl),
                  ) && (
                    <p className="text-12 text-[var(--text-secondary)]">
                      {t('models.channels.endpointChanged')}
                    </p>
                  )}
                  <ProviderModelIdsField
                    ids={currentModelIds}
                    draft={modelEntryDrafts[draftId] ?? ''}
                    onDraftChange={(value) => {
                      invalidate();
                      setModelEntryDrafts((previous) => ({ ...previous, [draftId]: value }));
                    }}
                    onChange={updateCurrentModelIds}
                    disabled={busy}
                    label={t('models.channels.modelIds')}
                    addLabel={t('models.channels.addModelId')}
                    placeholder={t('models.channels.modelIdPlaceholder')}
                    removeLabel={(index) => t('models.channels.removeModelIdRowLabel', { index })}
                    rowLabel={(index) => t('models.channels.modelIdRowLabel', { index })}
                    emptyLabel={t('models.channels.noModels')}
                  />
                  <div className="flex gap-2">
                    <Button variant="secondary" onClick={() => void request(true)}>
                      {t('models.channels.discover')}
                    </Button>
                    <Button variant="secondary" onClick={() => void request(false)}>
                      {t('models.channels.test')}
                    </Button>
                  </div>
                  <details>
                    <summary className="min-h-6 cursor-pointer text-13 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]">
                      {t('models.channels.advanced')}
                    </summary>
                    <div className="mt-3 flex flex-col gap-3">
                      <label className="text-13">
                        {t('models.channels.requestPath')}
                        <SettingsTextInput
                          size="md"
                          value={connection.requestPath ?? ''}
                          onChange={(value) =>
                            updateConnection({ requestPath: value || undefined })
                          }
                        />
                      </label>
                      <label className="text-13">
                        {t('models.channels.modelsUrl')}
                        <SettingsTextInput
                          size="md"
                          value={connection.modelsUrl ?? ''}
                          onChange={(value) => updateConnection({ modelsUrl: value || undefined })}
                        />
                      </label>
                      <label className="text-13">
                        {t('models.channels.headers')}
                        <Textarea
                          aria-label={t('models.channels.headers')}
                          surface="ivory"
                          rows={3}
                          value={headerDrafts[draftId] ?? ''}
                          onChange={(value) => {
                            invalidate();
                            setHeaderDrafts((previous) => ({
                              ...previous,
                              [draftId]: value,
                            }));
                          }}
                        />
                      </label>
                      {protocol === 'openai-responses' && (
                        <label className="flex min-h-8 items-center gap-2 text-13">
                          <input
                            type="checkbox"
                            checked={connection.supportsImageGeneration === true}
                            onChange={(event) =>
                              updateConnection({ supportsImageGeneration: event.target.checked })
                            }
                          />
                          {t('models.channels.imageGeneration')}
                        </label>
                      )}
                      <label className="flex min-h-8 items-center gap-2 text-13">
                        <input
                          type="checkbox"
                          checked={config.auth?.method === 'none'}
                          onChange={(event) => {
                            invalidate();
                            setConfig((previous) => ({
                              ...previous,
                              auth: event.target.checked ? { method: 'none' } : undefined,
                            }));
                          }}
                        />
                        {t('models.channels.noAuthSupplier')}
                      </label>
                      <Button variant="secondary" onClick={remove}>
                        {t('models.channels.removeProtocol')}
                      </Button>
                    </div>
                  </details>
                </>
              )}
              </div>
            </fieldset>
          </div>
          <footer className="shrink-0 space-y-2 border-t border-[var(--border-default)] p-4">
            {error && (
              <p role="alert" className="text-13 text-[var(--text-primary)]">
                {error}
              </p>
            )}
            {message && (
              <p role="status" className="text-13 text-[var(--text-secondary)]">
                {message}
              </p>
            )}
            {hasPendingModelEntry && (
              <p role="status" className="text-13 text-[var(--text-secondary)]">
                {t('models.channels.pendingModelId')}
              </p>
            )}
            {confirmation && (
              <p role="alert" className="text-13">
                {t('models.channels.restartRequired')}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  close();
                }}
              >
                {t('settings.providers.custom.cancel')}
              </Button>
              <Button
                disabled={busy || hasPendingModelEntry || !config.name.trim() || !channels.length}
                onClick={() => void save(confirmation)}
              >
                {t(
                  confirmation
                    ? 'models.channels.interruptAndSave'
                    : 'settings.providers.custom.save',
                )}
              </Button>
            </div>
          </footer>
          <ConfirmDialog
            open={pendingAction !== null}
            zIndex={10020}
            title={t('models.channels.discardTitle')}
            description={t('models.channels.discardDescription')}
            confirmText={t('models.channels.discard')}
            cancelText={t('models.channels.keepEditing')}
            onOpenChange={(open) => {
              if (!open) setPendingAction(null);
            }}
            onConfirm={() => {
              const action = pendingAction;
              setPendingAction(null);
              if (action?.kind === 'preset') applyPreset(action.id);
              else if (action) p.onClose();
            }}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
