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
  const baseId = useMemo(() => resourceId.includes('/memory/') ? resourceId.slice(0, resourceId.indexOf('/memory/') + '/memory'.length) : resourceId, [resourceId]);
  const loadList = useCallback(async (filter = query) => {
    const token = ++generation.current;
    setError(null);
    try {
      const next = await getRemoteResource(invoke, host, { collectionId: 'teammates', kind: 'bot', id: baseId }, i18n.language, filter);
      if (generation.current === token) setResource(next);
    } catch (cause) { if (generation.current === token) setError(formatRemoteError(cause)); }
  }, [baseId, host, i18n.language, invoke, query]);
  const loadDetail = useCallback(async (id: string) => {
    const token = ++generation.current;
    setError(null);
    try { const next = await getRemoteResource(invoke, host, { collectionId: 'teammates', kind: 'bot', id }, i18n.language); if (generation.current === token) { setDetail(next); setDraft(formOf(next, i18n.language)); } }
    catch (cause) { if (generation.current === token) setError(formatRemoteError(cause)); }
  }, [host, i18n.language, invoke]);
  useEffect(() => () => { generation.current += 1; }, []);
  useEffect(() => { if (view === 'list') void loadList(query); }, [loadList, query, view]);
  useEffect(() => { if (view !== 'list') void loadDetail(resourceId); }, [loadDetail, resourceId, view]);
  const openEntry = (id: string) => { setView('detail'); setDetail(null); setConflict(null); void loadDetail(id); };
  const save = async () => {
    if (!detail || !draft || busy) return;
    setBusy(true); setError(null);
    try {
      const latest = await getRemoteResource(invoke, host, detail.ref, i18n.language);
      const latestForm = formOf(latest, i18n.language);
      if (!latestForm || latest.revision !== draft.expectedUpdatedAt) { setConflict(latest); return; }
      const input: Record<string, unknown> = { expectedUpdatedAt: latest.revision };
      if (draft.title !== latestForm.title) input.title = draft.title;
      if (draft.body !== latestForm.body) input.body = draft.body;
      if (Object.keys(input).length > 1) await invokeRemoteResourceAction(invoke, host, { collectionId: 'teammates', resourceRef: latest.ref, actionId: 'memory-update', input }, i18n.language);
      const next = await getRemoteResource(invoke, host, latest.ref, i18n.language); setDetail(next); setDraft(formOf(next, i18n.language)); setView('detail');
    } catch (cause) {
      try { const next = await getRemoteResource(invoke, host, detail.ref, i18n.language); if (next.revision !== draft.expectedUpdatedAt) setConflict(next); else setError(formatRemoteError(cause)); }
      catch { setError(formatRemoteError(cause)); }
    } finally { setBusy(false); }
  };
  const remove = () => {
    if (!detail || busy) return;
    Alert.alert(t('devices.companionProfile.memory.deleteConfirmTitle', { defaultValue: 'Delete this memory?' }), t('devices.companionProfile.memory.deleteConfirmBody', { defaultValue: 'This cannot be undone.' }), [
      { text: t('devices.common.cancel'), style: 'cancel' },
      { text: t('devices.companionProfile.memory.delete', { defaultValue: 'Delete' }), style: 'destructive', onPress: () => { void (async () => {
        setBusy(true); setError(null);
        try {
          const latest = await getRemoteResource(invoke, host, detail.ref, i18n.language);
          if (latest.revision !== detail.revision) { setConflict(latest); return; }
          await invokeRemoteResourceAction(invoke, host, { collectionId: 'teammates', resourceRef: latest.ref, actionId: 'memory-delete', input: { expectedUpdatedAt: latest.revision } }, i18n.language);
          setView('list'); setDetail(null); setDraft(null); await loadList('');
        } catch (cause) {
          try {
            const next = await getRemoteResource(invoke, host, detail.ref, i18n.language);
            if (next.revision !== detail.revision) setConflict(next);
            else setError(formatRemoteError(cause));
          } catch (readCause) {
            if (String(readCause).includes('NOT_FOUND') || String(readCause).includes('not found')) {
              setView('list'); setDetail(null); setDraft(null); await loadList('');
            } else setError(formatRemoteError(cause));
          }
        } finally { setBusy(false); }
      })() } },
    ]);
  };
  const groups = resource ? groupsOf(resource, i18n.language) : [];
  const goBack = onBack ?? (() => { if (view !== 'list') setView('list'); else goBackGuarded(router); });
  return <SafeAreaView edges={simpleScreenSafeAreaEdges()} style={styles.safeArea}>
    <SimpleStackHeader backTestID="remoteMemory.back" onBack={goBack} subtitle={host.deviceName} title={title || t('devices.companionProfile.memory.title', { defaultValue: 'Saved Memories' })} titleTestID="remoteMemory.title" />
    <ScrollView contentContainerStyle={styles.content}>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {view === 'list' ? <>
        <TextInput accessibilityLabel={t('devices.companionProfile.memory.search', { defaultValue: 'Search memories' })} value={query} onChangeText={setQuery} placeholder={t('devices.companionProfile.memory.search', { defaultValue: 'Search memories' })} placeholderTextColor={colors.textTertiary} style={styles.input} />
        {!resource && !error ? <ActivityIndicator color={colors.textSecondary} /> : null}
        {groups.length ? groups.map((group) => <View key={group.id} style={styles.group}><Text accessibilityRole="header" style={styles.groupTitle}>{group.title} <Text style={styles.count}>{group.count}</Text></Text>{group.entries.map((entry, index) => <Pressable key={entry.resourceId} onPress={() => openEntry(entry.resourceId)} style={[styles.row, index > 0 && styles.separator]}><View style={styles.rowMain}><Text style={styles.rowTitle}>{entry.title}</Text>{entry.subtitle ? <Text numberOfLines={2} style={styles.preview}>{entry.subtitle}</Text> : null}</View><Text style={styles.date}>{entry.timestamp ? new Date(entry.timestamp).toLocaleDateString(i18n.language) : ''}</Text></Pressable>)}</View>) : resource ? <Text style={styles.note}>{query.trim() ? t('devices.resources.emptyCopy') : t('devices.resources.emptyTitle')}</Text> : null}
      </> : detail && draft ? <>
        {conflict ? <View style={styles.notice}><Text style={styles.error}>{t('devices.companionProfile.memory.conflict', { defaultValue: 'This memory changed on the host.' })}</Text><MainWindowActionButton action={{ label: t('devices.companionProfile.memory.useLatest', { defaultValue: 'Use latest' }), onPress: () => { setDetail(conflict); setDraft(formOf(conflict, i18n.language)); setConflict(null); } }} /><MainWindowActionButton action={{ label: t('devices.companionProfile.memory.keepMine', { defaultValue: 'Keep my edits' }), onPress: () => { setConflict(null); } }} /></View> : null}
        {view === 'detail' ? <><Text accessibilityRole="header" style={styles.title}>{draft.title}</Text><Text selectable style={styles.body}>{draft.body}</Text></> : <><TextInput editable={!busy} value={draft.title} onChangeText={(value) => setDraft({ ...draft, title: value })} style={styles.input} /><TextInput editable={!busy} multiline value={draft.body} onChangeText={(value) => setDraft({ ...draft, body: value })} style={[styles.input, styles.multiline]} /></>}
        <View style={styles.actions}>{view === 'detail' ? <><MainWindowActionButton action={{ label: t('devices.companionProfile.memory.edit', { defaultValue: 'Edit' }), disabled: busy, onPress: () => setView('edit') }} /><MainWindowActionButton action={{ label: t('devices.companionProfile.memory.delete', { defaultValue: 'Delete' }), tone: 'danger', disabled: busy, onPress: remove }} /></> : <MainWindowActionButton action={{ label: t('devices.companionProfile.memory.done', { defaultValue: 'Save' }), tone: 'primary', busy, onPress: () => void save() }} />}</View>
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
  rowTitle: { color: colors.textPrimary, fontSize: typeScale.listBody, fontWeight: fontWeight.medium },
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
