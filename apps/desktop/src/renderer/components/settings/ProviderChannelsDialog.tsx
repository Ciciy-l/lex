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
import { Plus, Sparkles } from 'lucide-react';
import { ProviderSetupTabs } from './ProviderSetupTabs';
import { Textarea } from '@/components/ui/input';
import { SettingsTextInput } from './SettingsTextInput';
import {
  appendDiscoveredCustomProviderModels,
  createCustomProvider,
  updateCustomProvider,
} from '@/lib/customProviders';
import type { ProviderChannelKeys } from '@/../shared/customProviderUpdate';
import { extractIpcError } from '@/utils/ipcError';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { useAuth } from '@/contexts/AuthContext';

const protocolNames: Record<ProviderWireProtocol, string> = {
  'anthropic-messages': 'Anthropic Messages',
  'openai-responses': 'OpenAI Responses',
  'openai-chat': 'OpenAI Chat Completions',
  'google-generative-ai': 'Google Gemini',
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
  const [modelDrafts, setModelDrafts] = useState<Record<string, string>>({});
  const [headerDrafts, setHeaderDrafts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState(false);
  const [pendingAction, setPendingAction] = useState<
    { kind: 'close' } | { kind: 'preset'; id: string } | null
  >(null);
  const initialSnapshot = useRef(JSON.stringify(config));
  const dirty =
    JSON.stringify(config) !== initialSnapshot.current ||
    Object.keys(keys).length > 0 ||
    Object.keys(modelDrafts).length > 0 ||
    Object.keys(headerDrafts).length > 0;
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
    setHeaderDrafts({});
    setConfirmation(false);
    setSelectedId(plan.configuration.channels[0].id);
    setProtocol(Object.keys(plan.configuration.channels[0].protocols)[0] as ProviderWireProtocol);
  };
  const channels = config.channels!.channels;
  const available = channels.filter((channel) => channel.protocols[protocol]);
  const channel = available.find((entry) => entry.id === selectedId) ?? available[0];
  const connection = channel?.protocols[protocol];
  const draftId = channel ? channelProtocolProviderId(channel.id, protocol) : '';
  const prepareConfig = (onlyRoute?: string): CustomProviderConfig => {
    const next = structuredClone(config);
    for (const item of next.channels!.channels) {
      for (const [wire, route] of Object.entries(item.protocols)) {
        const id = channelProtocolProviderId(item.id, wire as ProviderWireProtocol);
        if (onlyRoute && onlyRoute !== id) continue;
        const raw = modelDrafts[id];
        if (raw !== undefined) {
          const existing = new Map(route.models.map((model) => [model.id, model]));
          route.models = [
            ...new Set(
              raw
                .split('\n')
                .map((value) => value.trim())
                .filter(Boolean),
            ),
          ].map((id) => existing.get(id) ?? { id, name: id, defaultEnabled: true });
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
          const { route: _oldRoute, discoveredCost: _oldCost, ...metadata } = model;
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
      const useSaved =
        !!saved &&
        saved.baseUrl === route.baseUrl &&
        saved.modelsUrl === route.modelsUrl &&
        saved.requestPath === route.requestPath &&
        keys[channel.id]?.[protocol] === undefined &&
        headerDrafts[draftId] === undefined &&
        p.initial?.auth?.method === config.auth?.method;
      const authMethod = config.auth?.method === 'none' ? ('none' as const) : ('apiKey' as const);
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
          [draftId]: merged.models.map((model) => model.id).join('\n'),
        }));
      } else {
        const result = await window.electronAPI.maker.testProviderConnection(
          useSaved
            ? { kind: 'saved', providerId: draftId, agent: 'pi' }
            : {
                kind: 'adhoc',
                spec: {
                  ...common,
                  modelId: route.models[0]?.id ?? '',
                  ...(route.requestPath ? { requestPath: route.requestPath } : {}),
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
              <label className="flex flex-col gap-1 text-13">
                {t('models.channels.protocol')}
                <Select
                  label={t('models.channels.protocol')}
                  value={protocol}
                  disabled={busy}
                  options={PROVIDER_WIRE_PROTOCOLS.map((wire) => ({
                    value: wire,
                    label: protocolNames[wire],
                  }))}
                  onValueChange={(value) => {
                    const wire = value as ProviderWireProtocol;
                    selectRoute(wire, channels.find((entry) => entry.protocols[wire])?.id);
                  }}
                />
              </label>
              <div className="flex min-w-0 items-end gap-2">
                <label className="flex min-w-0 flex-1 flex-col gap-1 text-13">
                  {t('models.channels.chooseChannel')}
                  <Select
                    label={t('models.channels.chooseChannel')}
                    value={channel?.id ?? ''}
                    disabled={busy}
                    options={channels
                      .filter((entry) => entry.protocols[protocol])
                      .map((entry) => ({ value: entry.id, label: entry.name }))}
                    onValueChange={(id) => selectRoute(protocol, id)}
                  />
                </label>
                <Button variant="secondary" onClick={() => add()}>
                  <Plus size={14} />
                  {t('models.channels.add')}
                </Button>
              </div>
              {channels.some((entry) => !entry.protocols[protocol]) && (
                <label className="flex flex-col gap-1 text-13">
                  {t('models.channels.attach')}
                  <Select
                    label={t('models.channels.chooseChannel')}
                    value=""
                    disabled={busy}
                    options={channels
                      .filter((entry) => !entry.protocols[protocol])
                      .map((entry) => ({ value: entry.id, label: entry.name }))}
                    onValueChange={(id) => add(id)}
                  />
                </label>
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
                  {p.initial?.channels?.channels.some(
                    (entry) =>
                      entry.id === channel.id &&
                      entry.protocols[protocol] &&
                      (entry.protocols[protocol]!.baseUrl !== connection.baseUrl ||
                        entry.protocols[protocol]!.requestPath !== connection.requestPath),
                  ) && (
                    <p className="text-12 text-[var(--text-secondary)]">
                      {t('models.channels.endpointChanged')}
                    </p>
                  )}
                  <label className="flex flex-col gap-1 text-13">
                    {t('models.channels.modelIds')}
                    <Textarea
                      aria-label={t('models.channels.modelIds')}
                      surface="ivory"
                      rows={5}
                      value={
                        modelDrafts[draftId] ??
                        connection.models.map((model) => model.id).join('\n')
                      }
                      onChange={(value) => {
                        setConfirmation(false);
                        setModelDrafts((previous) => ({
                          ...previous,
                          [draftId]: value,
                        }));
                      }}
                    />
                  </label>
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
                disabled={busy || !config.name.trim() || !channels.length}
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
