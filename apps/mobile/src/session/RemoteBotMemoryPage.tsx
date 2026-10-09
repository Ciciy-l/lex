import { Alert, ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveRemoteText, type RemoteResource, type RemoteResourceBlock } from '@cindy/device-link';
import { Text, TextInput } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { getRemoteResource, invokeRemoteResourceAction, type RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { formatRemoteError } from '@/device-link/remoteStatus';
import { SimpleStackHeader, simpleScreenSafeAreaEdges } from '@/platform/chrome';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { goBackGuarded } from '@/utils/backGuard';
import { useRouter } from 'expo-router';

interface Entry { id: string; title: string; subtitle?: string; timestamp?: number; resourceId: string }
interface Group { id: string; title: string; count: number; entries: Entry[] }
interface FormValue { title: string; body: string; expectedUpdatedAt: string }
interface RequestToken { generation: number; identity: string; resourceId: string }
type DraftStore = Map<string, FormValue>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown, locale: string): string {
  if (typeof value === 'string') return value;
  return value && typeof value === 'object' ? resolveRemoteText(value as never, locale) : '';
}
function dataOf(block: RemoteResourceBlock): Record<string, unknown> { return record(block.data); }
function groupsOf(resource: RemoteResource, locale: string): Group[] {
  return (resource.blocks ?? []).filter((block) => block.primitive === 'list').flatMap((block) => {
    const data = dataOf(block);
    const entries = Array.isArray(data.entries) ? data.entries.flatMap((item) => {
      const row = record(item);
      const id = typeof row.id === 'string' ? row.id : '';
      const resourceId = typeof row.resourceId === 'string' ? row.resourceId : '';
      const title = text(row.title, locale);
      if (!id || !resourceId || !title) return [];
      return [{ id, resourceId, title, subtitle: text(row.subtitle, locale) || undefined, timestamp: typeof row.timestamp === 'number' ? row.timestamp : undefined }];
    }) : [];
    if (!entries.length) return [];
    return [{ id: block.id, title: text(block.title, locale) || block.id, count: typeof data.count === 'number' ? data.count : entries.length, entries }];
  });
}
function formOf(resource: RemoteResource, locale: string): FormValue | null {
  const block = resource.blocks?.find((candidate) => candidate.primitive === 'form');
  if (!block) return null;
  const values = record(dataOf(block).values);
  return {
    title: typeof values.title === 'string' ? values.title : text(resource.display.title, locale),
    body: typeof values.body === 'string' ? values.body : block.fallbackMarkdown,
    expectedUpdatedAt: typeof values.expectedUpdatedAt === 'string' ? values.expectedUpdatedAt : resource.revision,
  };
}
const sameDraft = (form: FormValue | null, draft: FormValue): boolean =>
  Boolean(form && form.title === draft.title && form.body === draft.body);
function currentRequest(
  token: RequestToken,
  generation: { current: number },
  identity: { current: string },
  resource: { current: string },
): boolean {
  return token.generation === generation.current
    && token.identity === identity.current
    && token.resourceId === resource.current;
}
const draftKeyFor = (identity: string, resourceId: string): string => identity + '\u0000' + resourceId;

export interface RemoteBotMemoryPageProps {
  host: RemoteResourceHostTarget;
  resourceId: string;
  title?: string;
  onBack?: () => void;
}

export function RemoteBotMemoryPage({ host, resourceId, title, onBack }: RemoteBotMemoryPageProps) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const { invoke } = useDeviceLink();
  const [resource, setResource] = useState<RemoteResource | null>(null);
  const [detail, setDetail] = useState<RemoteResource | null>(null);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<FormValue | null>(null);
  const [view, setView] = useState<'list' | 'detail' | 'edit'>((resourceId.endsWith('/memory') ? 'list' : 'detail'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<RemoteResource | null>(null);
  const generation = useRef(0);
  const drafts = useRef<DraftStore>(new Map());
  const operationSequence = useRef(0);
  const activeOperation = useRef<number | null>(null);
  const baseId = useMemo(() => resourceId.includes('/memory/') ? resourceId.slice(0, resourceId.indexOf('/memory/') + '/memory'.length) : resourceId, [resourceId]);
  const [selectedResourceId, setSelectedResourceId] = useState<string | null>(() => resourceId.includes('/memory/') ? resourceId : null);
  const identityKey = host.deviceId + ':' + baseId;
  const activeIdentity = useRef(identityKey);
  const activeResource = useRef(baseId);
  if (activeIdentity.current !== identityKey) {
    activeIdentity.current = identityKey;
    activeResource.current = baseId;
    generation.current += 1;
    activeOperation.current = null;
  }
  const draftKey = (id: string) => draftKeyFor(identityKey, id);
  const beginOperation = () => {
    const operation = ++operationSequence.current;
    activeOperation.current = operation;
    setBusy(true);
    return operation;
  };
  const finishOperation = (operation: number) => {
    if (activeOperation.current !== operation) return;
    activeOperation.current = null;
    setBusy(false);
  };
  const invalidateRequests = () => {
    generation.current += 1;
    activeResource.current = baseId;
    activeOperation.current = null;
    setBusy(false);
  };
  const updateDraft = (update: (current: FormValue) => FormValue) => {
    setDraft((current) => {
      if (!current) return current;
      const next = update(current);
      drafts.current.set(draftKey(activeResource.current), next);
      return next;
    });
  };
  const tokenFor = (id: string): RequestToken => ({ generation: generation.current, identity: identityKey, resourceId: id });
  const loadList = useCallback(async (filter = query) => {
    activeResource.current = baseId;
    const token = { ...tokenFor(baseId), generation: ++generation.current };
    setError(null);
    try {
      const next = await getRemoteResource(invoke, host, { collectionId: 'teammates', kind: 'bot', id: baseId }, i18n.language, filter);
      if (currentRequest(token, generation, activeIdentity, activeResource)) setResource(next);
    } catch (cause) { if (currentRequest(token, generation, activeIdentity, activeResource)) setError(formatRemoteError(cause)); }
  }, [baseId, host, i18n.language, identityKey, invoke, query]);
  const loadDetail = useCallback(async (id: string) => {
    activeResource.current = id;
    const token = { ...tokenFor(id), generation: ++generation.current };
    setError(null);
    try {
      const next = await getRemoteResource(invoke, host, { collectionId: 'teammates', kind: 'bot', id }, i18n.language);
      if (currentRequest(token, generation, activeIdentity, activeResource)) {
        setDetail(next);
        const loaded = formOf(next, i18n.language);
        const saved = drafts.current.get(draftKeyFor(identityKey, id));
        if (saved) setDraft(saved);
        else {
          if (loaded) drafts.current.set(draftKeyFor(identityKey, id), loaded);
          setDraft(loaded);
        }
      }
    }
    catch (cause) { if (currentRequest(token, generation, activeIdentity, activeResource)) setError(formatRemoteError(cause)); }
  }, [host, i18n.language, invoke, identityKey]);
  useEffect(() => () => { generation.current += 1; activeOperation.current = null; }, []);
  useEffect(() => {
    if (activeIdentity.current !== identityKey) return;
    activeOperation.current = null;
    setBusy(false);
    setSelectedResourceId(resourceId.includes('/memory/') ? resourceId : null);
    setView(resourceId.includes('/memory/') ? 'detail' : 'list');
    setDetail(null);
    setDraft(resourceId.includes('/memory/') ? drafts.current.get(draftKeyFor(identityKey, resourceId)) ?? null : null);
    setConflict(null);
  }, [identityKey, resourceId]);
  useEffect(() => { if (view === 'list') void loadList(query); }, [loadList, query, view]);
  useEffect(() => { if (view !== 'list') void loadDetail(selectedResourceId ?? resourceId); }, [loadDetail, resourceId, selectedResourceId, view]);
  const openEntry = (id: string) => {
    setSelectedResourceId(id);
    setView('detail');
    setDetail(null);
    setDraft(drafts.current.get(draftKey(id)) ?? null);
    setConflict(null);
  };
  const save = async () => {
    if (!detail || !draft || busy) return;
    const currentDetail = detail;
    const currentDraft = draft;
    const token = tokenFor(currentDetail.ref.id);
    const operation = beginOperation();
    setError(null);
    try {
      const latest = await getRemoteResource(invoke, host, currentDetail.ref, i18n.language);
      const latestForm = formOf(latest, i18n.language);
      if (!currentRequest(token, generation, activeIdentity, activeResource)) return;
      if (!latestForm || latest.revision !== currentDraft.expectedUpdatedAt) { setConflict(latest); return; }
      const input: Record<string, unknown> = { expectedUpdatedAt: latest.revision };
      if (currentDraft.title !== latestForm.title) input.title = currentDraft.title;
      if (currentDraft.body !== latestForm.body) input.body = currentDraft.body;
      if (Object.keys(input).length > 1) await invokeRemoteResourceAction(invoke, host, { collectionId: 'teammates', resourceRef: latest.ref, actionId: 'memory-update', input }, i18n.language);
      if (!currentRequest(token, generation, activeIdentity, activeResource)) return;
      const next = await getRemoteResource(invoke, host, latest.ref, i18n.language);
      if (!currentRequest(token, generation, activeIdentity, activeResource)) return;
      const nextDraft = formOf(next, i18n.language);
      if (nextDraft) drafts.current.set(draftKey(currentDetail.ref.id), nextDraft);
      setDetail(next); setDraft(nextDraft); setConflict(null); setView('detail');
    } catch (cause) {
      if (!currentRequest(token, generation, activeIdentity, activeResource)) return;
      try {
        const next = await getRemoteResource(invoke, host, currentDetail.ref, i18n.language);
        if (!currentRequest(token, generation, activeIdentity, activeResource)) return;
        const nextForm = formOf(next, i18n.language);
        if (sameDraft(nextForm, currentDraft)) {
          if (nextForm) drafts.current.set(draftKey(currentDetail.ref.id), nextForm);
          setDetail(next); setDraft(nextForm); setConflict(null); setView('detail');
        } else if (next.revision !== currentDraft.expectedUpdatedAt) setConflict(next);
        else setError(formatRemoteError(cause));
      } catch { if (currentRequest(token, generation, activeIdentity, activeResource)) setError(formatRemoteError(cause)); }
    } finally { finishOperation(operation); }
  };
  const remove = () => {
    if (!detail || !draft || busy) return;
    const currentDetail = detail;
    const currentDraft = draft;
    Alert.alert(t('devices.companionProfile.memory.deleteConfirmTitle'), t('devices.companionProfile.memory.deleteConfirmBody'), [
      { text: t('devices.common.cancel'), style: 'cancel' },
      { text: t('devices.companionProfile.memory.delete'), style: 'destructive', onPress: () => { void (async () => {
        const token = tokenFor(currentDetail.ref.id);
        if (!currentRequest(token, generation, activeIdentity, activeResource)) return;
        const operation = beginOperation();
        setError(null);
        try {
          const latest = await getRemoteResource(invoke, host, currentDetail.ref, i18n.language);
          if (!currentRequest(token, generation, activeIdentity, activeResource)) return;
          if (latest.revision !== currentDraft.expectedUpdatedAt) { setConflict(latest); return; }
          await invokeRemoteResourceAction(invoke, host, { collectionId: 'teammates', resourceRef: latest.ref, actionId: 'memory-delete', input: { expectedUpdatedAt: latest.revision } }, i18n.language);
          if (!currentRequest(token, generation, activeIdentity, activeResource)) return;
          drafts.current.delete(draftKey(currentDetail.ref.id));
          activeResource.current = baseId;
          generation.current += 1;
          activeOperation.current = null;
          setBusy(false);
          setSelectedResourceId(null); setView('list'); setDetail(null); setDraft(null); setConflict(null); await loadList('');
        } catch (cause) {
          try {
            if (!currentRequest(token, generation, activeIdentity, activeResource)) return;
            const next = await getRemoteResource(invoke, host, currentDetail.ref, i18n.language);
            if (!currentRequest(token, generation, activeIdentity, activeResource)) return;
            if (next.revision !== currentDraft.expectedUpdatedAt) setConflict(next);
            else setError(formatRemoteError(cause));
          } catch { if (currentRequest(token, generation, activeIdentity, activeResource)) setError(formatRemoteError(cause)); }
        } finally { finishOperation(operation); }
      })() } },
    ]);
  };
  const groups = resource ? groupsOf(resource, i18n.language) : [];
  const goBack = () => {
    invalidateRequests();
    if (onBack) onBack();
    else if (view !== 'list') { setSelectedResourceId(null); setView('list'); setDetail(null); setDraft(null); setConflict(null); }
    else goBackGuarded(router);
  };
  return <SafeAreaView edges={simpleScreenSafeAreaEdges()} style={styles.safeArea}>
    <SimpleStackHeader backTestID="remoteMemory.back" onBack={goBack} subtitle={host.deviceName} title={title || t('devices.companionProfile.memory.title')} titleTestID="remoteMemory.title" />
    <ScrollView contentContainerStyle={styles.content}>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {view === 'list' ? <>
        <TextInput accessibilityLabel={t('devices.companionProfile.memory.search')} value={query} onChangeText={setQuery} placeholder={t('devices.companionProfile.memory.search')} placeholderTextColor={colors.textTertiary} style={styles.input} />
        {!resource && !error ? <ActivityIndicator color={colors.textSecondary} /> : null}
        {groups.length ? groups.map((group) => <View key={group.id} style={styles.group}><Text accessibilityRole="header" style={styles.groupTitle}>{group.title} <Text style={styles.count}>{group.count}</Text></Text>{group.entries.map((entry, index) => <Pressable key={entry.resourceId} onPress={() => openEntry(entry.resourceId)} style={[styles.row, index > 0 && styles.separator]}><View style={styles.rowMain}><Text style={styles.rowTitle}>{entry.title}</Text>{entry.subtitle ? <Text numberOfLines={2} style={styles.preview}>{entry.subtitle}</Text> : null}</View><Text style={styles.date}>{entry.timestamp ? new Date(entry.timestamp).toLocaleDateString(i18n.language) : ''}</Text></Pressable>)}</View>) : resource ? <Text style={styles.note}>{query.trim() ? t('devices.resources.emptyCopy') : t('devices.resources.emptyTitle')}</Text> : null}
      </> : detail && draft ? <>
        {conflict ? <View style={styles.notice}><Text style={styles.error}>{t('devices.companionProfile.memory.conflict')}</Text><MainWindowActionButton action={{ label: t('devices.companionProfile.memory.useLatest'), onPress: () => { const next = formOf(conflict, i18n.language); if (next) drafts.current.set(draftKey(detail.ref.id), next); setDetail(conflict); setDraft(next); setConflict(null); } }} /><MainWindowActionButton action={{ label: t('devices.companionProfile.memory.keepMine'), onPress: () => { if (conflict) updateDraft((current) => ({ ...current, expectedUpdatedAt: conflict.revision })); setConflict(null); } }} /></View> : null}
        {view === 'detail' ? <><Text accessibilityRole="header" style={styles.title}>{draft.title}</Text><Text selectable style={styles.body}>{draft.body}</Text></> : <><TextInput editable={!busy} value={draft.title} onChangeText={(value) => updateDraft((current) => ({ ...current, title: value }))} style={styles.input} /><TextInput editable={!busy} multiline value={draft.body} onChangeText={(value) => updateDraft((current) => ({ ...current, body: value }))} style={[styles.input, styles.multiline]} /></>}
        <View style={styles.actions}>{view === 'detail' ? <><MainWindowActionButton action={{ label: t('devices.companionProfile.memory.edit'), disabled: busy, onPress: () => setView('edit') }} /><MainWindowActionButton action={{ label: t('devices.companionProfile.memory.delete'), tone: 'danger', disabled: busy, onPress: remove }} /></> : <MainWindowActionButton action={{ label: t('devices.companionProfile.memory.done'), tone: 'primary', busy, onPress: () => void save() }} />}</View>
      </> : null}
    </ScrollView>
  </SafeAreaView>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  safeArea: { backgroundColor: colors.surface, flex: 1 },
  content: { gap: spacing.lg, padding: spacing.lg },
  group: { backgroundColor: colors.surfaceElevated, borderRadius: radius.container, overflow: 'hidden' },
  groupTitle: { color: colors.textSecondary, fontSize: typeScale.footnote, fontWeight: fontWeight.medium, padding: spacing.md },
  count: { color: colors.textTertiary, fontWeight: fontWeight.regular },
  row: { alignItems: 'flex-start', flexDirection: 'row', gap: spacing.md, padding: spacing.md },
  separator: { borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth },
  rowMain: { flex: 1, gap: spacing.xs },
  rowTitle: { color: colors.textPrimary, fontSize: typeScale.bodySmall, fontWeight: fontWeight.medium },
  preview: { color: colors.textSecondary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  date: { color: colors.textTertiary, fontSize: typeScale.micro },
  title: { color: colors.textPrimary, fontSize: typeScale.subtitle, fontWeight: fontWeight.medium },
  body: { color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.bodyRelaxed },
  note: { color: colors.textSecondary, fontSize: typeScale.footnote },
  error: { color: colors.errorText, fontSize: typeScale.footnote },
  notice: { backgroundColor: colors.surfaceElevated, borderRadius: radius.container, gap: spacing.sm, padding: spacing.md },
  actions: { gap: spacing.sm },
  input: { backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderRadius: radius.pill, borderWidth: 1, color: colors.textPrimary, minHeight: 44, padding: spacing.md },
  multiline: { borderRadius: radius.control, minHeight: 220, textAlignVertical: 'top' },
});
