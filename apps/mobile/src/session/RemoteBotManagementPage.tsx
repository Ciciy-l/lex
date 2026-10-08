import { Alert, ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RemoteActionDescriptor, RemoteResource, RemoteResourceBlock } from '@cindy/device-link';
import { Text, TextInput } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { getRemoteResource, invokeRemoteResourceAction, type RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { formatRemoteError } from '@/device-link/remoteStatus';
import { SimpleStackHeader, simpleScreenSafeAreaEdges } from '@/platform/chrome';
import { goBackGuarded } from '@/utils/backGuard';
import { useRouter } from 'expo-router';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

type Value = string | boolean;
type Values = Record<string, Value>;
type Row = Record<string, unknown>;

function row(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}
function text(value: unknown, locale: string): string {
  if (typeof value === 'string') return value;
  return value && typeof value === 'object' && typeof row(value).fallback === 'string'
    ? String(row(value).fallback)
    : '';
}
function dataOf(block: RemoteResourceBlock): Row { return row(block.data); }
function blockAction(resource: RemoteResource, block: RemoteResourceBlock): RemoteActionDescriptor | undefined {
  const actionId = dataOf(block).actionId;
  return typeof actionId === 'string' ? resource.actions?.find((action) => action.id === actionId) : undefined;
}
/**
 * bindResource deliberately replaces public action ids with opaque grants.
 * The operationActions map is the only trusted display-to-operation mapping;
 * never infer creation from the opaque id itself.
 */
function blockOperation(resource: RemoteResource, block: RemoteResourceBlock, action: RemoteActionDescriptor): string | undefined {
  const operationActions = row(dataOf(block).operationActions);
  const operation = Object.entries(operationActions).find(([, actionId]) => actionId === action.id)?.[0];
  // A creation resource is itself the semantic scope; older hosts may not
  // expose operationActions, but must still never require the opaque grant id
  // to equal "create".
  return operation ?? (resource.ref.id === 'create' ? 'create' : undefined);
}

function createActionRequestId(): string {
  const cryptoLike = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (typeof cryptoLike?.randomUUID === 'function') return cryptoLike.randomUUID();
  return `remote-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}
function valuesOf(resource: RemoteResource, block: RemoteResourceBlock): Values {
  const values = row(dataOf(block).values);
  const action = blockAction(resource, block);
  const output: Values = {};
  for (const field of action?.fields ?? []) {
    const value = values[field.id];
    if (typeof value === 'string' || typeof value === 'boolean') output[field.id] = value;
  }
  return output;
}

export interface RemoteBotManagementPageProps {
  host: RemoteResourceHostTarget;
  resourceId: string;
  title?: string;
  onBack?: () => void;
}

/** Portable form/action renderer for hosts that advertise remote Bot management. */
export function RemoteBotManagementPage({ host, resourceId, title, onBack }: RemoteBotManagementPageProps) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const { invoke } = useDeviceLink();
  const [activeId, setActiveId] = useState(resourceId);
  const [resource, setResource] = useState<RemoteResource | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Values>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const activeIdRef = useRef(resourceId);
  const operationRef = useRef(0);
  const actionRequestIdsRef = useRef<Record<string, string>>({});
  const resourceRef = useRef<RemoteResource | null>(null);
  const mountedRef = useRef(true);
  const pendingConfirmationRef = useRef<number | null>(null);
  activeIdRef.current = activeId;
  resourceRef.current = resource;
  const baseId = resourceId;
  const draftKey = (id: string) => `${host.deviceId}:${id}`;
  const activeDraft = drafts[draftKey(activeId)] ?? {};
  const clearCreateIntent = (id: string): void => {
    if (id === 'create') delete actionRequestIdsRef.current[`${host.deviceId}:create:create`];
  };

  const load = useCallback(async (id: string) => {
    const generation = ++generationRef.current;
    const key = `${host.deviceId}:${id}`;
    setError(null);
    try {
      const next = await getRemoteResource(invoke, host, { collectionId: 'teammates', kind: 'bot', id }, i18n.language);
      if (generationRef.current !== generation || activeIdRef.current !== id) return;
      setResource(next);
      const form = next.blocks?.find((block) => block.primitive === 'form');
      setDrafts((current) => Object.prototype.hasOwnProperty.call(current, key)
        ? current
        : { ...current, [key]: form ? valuesOf(next, form) : {} });
    } catch (cause) {
      if (generationRef.current === generation && activeIdRef.current === id) setError(formatRemoteError(cause));
    }
  }, [host, i18n.language, invoke]);

  useEffect(() => {
    pendingConfirmationRef.current = null;
    operationRef.current += 1;
    setBusy(false);
    activeIdRef.current = resourceId;
    setActiveId(resourceId);
    setResource(null);
    void load(resourceId);
  }, [load, resourceId, host.deviceId]);

  useEffect(() => () => {
    mountedRef.current = false;
    pendingConfirmationRef.current = null;
    generationRef.current += 1;
    operationRef.current += 1;
  }, []);

  const updateDraft = (field: string, value: Value) => {
    const key = draftKey(activeIdRef.current);
    setDrafts((current) => ({ ...current, [key]: { ...(current[key] ?? {}), [field]: value } }));
  };

  const invokeAction = async (action: RemoteActionDescriptor, input: Values, operationKey?: string) => {
    if (busy || pendingConfirmationRef.current !== null) return;
    const capturedOperation = ++operationRef.current;
    const capturedResourceId = activeIdRef.current;
    const capturedGeneration = generationRef.current;
    const capturedResource = resourceRef.current;
    const capturedHost = host;
    const capturedHostId = host.deviceId;
    const capturedActionId = action.id;
    const capturedResourceRef = capturedResource?.ref;
    const capturedRevision = capturedResource?.revision;
    const capturedInput = { ...input };
    if (!capturedResource || !capturedResourceRef) return;
    const capturedOperationKey = operationKey ?? (capturedResource.ref.id === 'create' ? 'create' : action.id);
    const isCurrent = () => mountedRef.current
      && operationRef.current === capturedOperation
      && generationRef.current === capturedGeneration
      && activeIdRef.current === capturedResourceId
      && host === capturedHost
      && host.deviceId === capturedHostId
      && resourceRef.current === capturedResource
      && capturedResource.revision === capturedRevision;
    if (action.confirmation) {
      pendingConfirmationRef.current = capturedOperation;
      const confirmed = await new Promise<boolean>((resolve) => Alert.alert(
        text(action.confirmation?.title, i18n.language),
        action.confirmation?.body ? text(action.confirmation.body, i18n.language) : undefined,
        [
          { text: t('devices.common.cancel'), style: 'cancel', onPress: () => resolve(false) },
          { text: text(action.confirmation?.confirmLabel ?? action.label, i18n.language), style: action.tone === 'destructive' ? 'destructive' : 'default', onPress: () => resolve(true) },
        ],
      ));
      if (pendingConfirmationRef.current === capturedOperation) pendingConfirmationRef.current = null;
      if (!confirmed || !isCurrent()) return;
    }
    if (!isCurrent()) return;
    const requestKey = `${capturedHostId}:${capturedResourceId}:${capturedOperationKey}`;
    const requestId = capturedOperationKey === 'create' && capturedResource.ref.id === 'create'
      ? (actionRequestIdsRef.current[requestKey] ??= createActionRequestId())
      : undefined;
    setBusy(true);
    setError(null);
    try {
      const response = await invokeRemoteResourceAction(invoke, capturedHost, {
        collectionId: 'teammates',
        resourceRef: capturedResourceRef,
        actionId: capturedActionId,
        input: requestId ? { ...capturedInput, requestId } : capturedInput,
      }, i18n.language);
      if (!isCurrent()) return;
      if (requestId) delete actionRequestIdsRef.current[requestKey];
      const navigation = response.effects?.find((effect) => effect.kind === 'navigate');
      if (navigation?.kind === 'navigate' && navigation.target.kind === 'resource'
        && navigation.target.ref.collectionId === 'teammates' && navigation.target.ref.kind === 'bot') {
        operationRef.current += 1;
        setBusy(false);
        activeIdRef.current = navigation.target.ref.id;
        setActiveId(navigation.target.ref.id);
        setResource(null);
        setError(null);
        void load(navigation.target.ref.id);
        return;
      }
      setDrafts((current) => {
        const next = { ...current };
        delete next[draftKey(capturedResourceId)];
        return next;
      });
      await load(capturedResourceId);
    } catch (cause) {
      if (isCurrent()) setError(formatRemoteError(cause));
    } finally {
      if (operationRef.current === capturedOperation) setBusy(false);
    }
  };

  const blocks = resource?.blocks ?? [];
  const openEntry = (id: string) => {
    clearCreateIntent(activeIdRef.current);
    pendingConfirmationRef.current = null;
    operationRef.current += 1;
    setBusy(false);
    activeIdRef.current = id;
    setActiveId(id);
    setResource(null);
    void load(id);
  };
  const goBack = () => {
    clearCreateIntent(activeIdRef.current);
    pendingConfirmationRef.current = null;
    operationRef.current += 1;
    setBusy(false);
    if (activeId !== baseId) {
      activeIdRef.current = baseId;
      setActiveId(baseId);
      setResource(null);
      void load(baseId);
      return;
    }
    if (onBack) onBack(); else goBackGuarded(router);
  };

  return (
    <View style={styles.safeArea}>
      <SimpleStackHeader
        backTestID="remoteBotManagement.back"
        onBack={goBack}
        subtitle={host.deviceName}
        title={title ?? (text(resource?.display.title, i18n.language) || t('devices.resources.titleFallback'))}
        titleTestID="remoteBotManagement.title"
      />
      <ScrollView contentContainerStyle={styles.content}>
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {!resource && !error ? <ActivityIndicator color={colors.textSecondary} /> : null}
        {blocks.map((block) => {
          const data = dataOf(block);
          if (block.primitive === 'list') {
            const entries = Array.isArray(data.entries) ? data.entries.flatMap((item) => {
              const entry = row(item);
              return typeof entry.resourceId === 'string' && typeof entry.title !== 'undefined'
                ? [{ id: String(entry.id ?? entry.resourceId), resourceId: entry.resourceId, title: text(entry.title, i18n.language) }]
                : [];
            }) : [];
            return (
              <View key={block.id} style={styles.group}>
                <Text style={styles.groupTitle}>{text(block.title, i18n.language) || block.id}</Text>
                {entries.map((entry) => <Pressable key={entry.resourceId} onPress={() => openEntry(entry.resourceId)} style={styles.row}>
                  <Text style={styles.rowTitle}>{entry.title}</Text><Text style={styles.chevron}>›</Text>
                </Pressable>)}
              </View>
            );
          }
          if (block.primitive === 'form' || block.primitive === 'action') {
            const action = blockAction(resource!, block);
            if (!action) return <Text key={block.id} style={styles.note}>{block.fallbackMarkdown}</Text>;
            const fields = action.fields ?? [];
            return (
              <View key={block.id} style={styles.form}>
                <Text style={styles.groupTitle}>{text(block.title ?? action.label, i18n.language)}</Text>
                {fields.map((field) => {
                  const value = activeDraft[field.id];
                  if (field.kind === 'toggle') return <View key={field.id} style={styles.toggleRow}>
                    <Text style={styles.label}>{text(field.label, i18n.language)}</Text>
                    <Switch value={value === true} disabled={busy} onValueChange={(next) => updateDraft(field.id, next)} />
                  </View>;
                  if (field.kind === 'select') return <View key={field.id} style={styles.selectRow}>
                    <Text style={styles.label}>{text(field.label, i18n.language)}</Text>
                    <View style={styles.options}>{(field.options ?? []).map((option) => <Pressable key={option.value} disabled={busy} onPress={() => updateDraft(field.id, option.value)} style={[styles.option, value === option.value && styles.optionSelected]}><Text style={styles.optionText}>{text(option.label, i18n.language)}</Text></Pressable>)}</View>
                  </View>;
                  return <View key={field.id} style={styles.field}>
                    <Text style={styles.label}>{text(field.label, i18n.language)}</Text>
                    <TextInput editable={!busy} multiline={field.kind === 'multiline'} value={typeof value === 'string' ? value : ''} onChangeText={(next) => updateDraft(field.id, next)} placeholder={field.placeholder ? text(field.placeholder, i18n.language) : undefined} placeholderTextColor={colors.textTertiary} style={[styles.input, field.kind === 'multiline' && styles.multiline]} />
                  </View>;
                })}
                <MainWindowActionButton action={{ label: text(action.label, i18n.language), busy, disabled: busy, tone: action.tone === 'destructive' ? 'danger' : 'primary', onPress: () => void invokeAction(action, activeDraft, blockOperation(resource!, block, action)) }} />
              </View>
            );
          }
          if (block.primitive === 'markdown' || block.primitive === 'status') return <View key={block.id} style={styles.markdown}><Text style={styles.note}>{block.fallbackMarkdown}</Text></View>;
          return null;
        })}
      </ScrollView>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  safeArea: { backgroundColor: colors.surface, flex: 1 },
  content: { gap: spacing.lg, padding: spacing.lg },
  group: { backgroundColor: colors.surfaceElevated, borderRadius: radius.container, overflow: 'hidden' },
  form: { backgroundColor: colors.surfaceElevated, borderRadius: radius.container, gap: spacing.md, padding: spacing.md },
  groupTitle: { color: colors.textSecondary, fontSize: typeScale.footnote, fontWeight: fontWeight.medium },
  row: { alignItems: 'center', borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', justifyContent: 'space-between', padding: spacing.md },
  rowTitle: { color: colors.textPrimary, flex: 1, fontSize: typeScale.body },
  chevron: { color: colors.textTertiary, fontSize: typeScale.title },
  field: { gap: spacing.xs },
  label: { color: colors.textSecondary, fontSize: typeScale.footnote },
  input: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth, color: colors.textPrimary, fontSize: typeScale.body, minHeight: 42, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  multiline: { minHeight: 112, textAlignVertical: 'top' },
  toggleRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  selectRow: { gap: spacing.sm },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  option: { borderColor: colors.border, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  optionSelected: { backgroundColor: colors.surfaceChip, borderColor: colors.borderStrong },
  optionText: { color: colors.textPrimary, fontSize: typeScale.footnote },
  markdown: { paddingHorizontal: spacing.xs },
  note: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  error: { color: colors.errorText, fontSize: typeScale.footnote },
});
