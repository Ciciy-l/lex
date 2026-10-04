import { createHash } from 'node:crypto';
import type {
  RemoteActionInvokeResponse,
  RemoteLocalizedText,
  RemoteResource,
  RemoteResourceBlock,
} from '@cindy/device-link';
import {
  BOT_MEMORY_TYPES,
  type BotMemoryDeleteInput,
  type BotMemoryDetail,
  type BotMemorySummary,
  type BotMemoryUpdateInput,
} from '../../../shared/botMemory.js';
import type { BotMemoryOperationGuard } from '../../maker-ipc/botMemoryService.js';
import { RemoteResourceRegistryError } from '../../device-link/remoteResourceRegistry.js';
import type { RemoteResourceHostContext } from '../../device-link/remoteResourceRegistry.js';
import { throwIpcError } from '../../utils/ipcValidate.js';

export interface BotRemoteMemoryService {
  list(botId: string, query?: string, guard?: BotMemoryOperationGuard): Promise<BotMemorySummary[]>;
  read(botId: string, filename: string, guard?: BotMemoryOperationGuard): Promise<BotMemoryDetail>;
  update(input: BotMemoryUpdateInput, guard?: BotMemoryOperationGuard): Promise<BotMemoryDetail>;
  delete(input: BotMemoryDeleteInput, guard?: BotMemoryOperationGuard): Promise<void>;
}

export const BOT_MEMORY_COLLECTION_ID = 'teammates';
export const BOT_MEMORY_RESOURCE_PREFIX = 'settings:';

const text = (fallback: string, cn: string, tw: string, ja: string, ko: string): RemoteLocalizedText => ({
  fallback, translations: { 'zh-CN': cn, 'zh-TW': tw, ja, ko },
});

export const memoryCopy = {
  memories: text('Saved Memories', '已存记忆', '已存記憶', '保存した記憶', '저장된 기억'),
  search: text('Search memories', '搜索记忆', '搜尋記憶', '記憶を検索', '기억 검색'),
  types: {
    user: text('About you', '关于你', '關於你', 'あなたについて', '나에 대해'),
    feedback: text('Your preferences', '你的要求', '你的要求', 'あなたの要望', '요청 사항'),
    project: text('Projects', '项目', '專案', 'プロジェクト', '프로젝트'),
    reference: text('References', '参考', '參考', '参考', '참고'),
  } satisfies Record<(typeof BOT_MEMORY_TYPES)[number], RemoteLocalizedText>,
  edit: text('Edit', '编辑', '編輯', '編集', '편집'),
  title: text('Title', '标题', '標題', 'タイトル', '제목'),
  body: text('Content', '内容', '內容', '内容', '내용'),
  remove: text('Delete Memory', '删除记忆', '刪除記憶', '記憶を削除', '기억 삭제'),
  removeTitle: text('Delete this memory?', '删除这条记忆？', '刪除這條記憶？', 'この記憶を削除しますか？', '이 기억을 삭제할까요?'),
  delete: text('Delete', '删除', '刪除', '削除', '삭제'),
  saved: text('Memory saved', '记忆已保存', '記憶已儲存', '記憶を保存しました', '기억을 저장했습니다'),
  deleted: text('Memory deleted', '记忆已删除', '記憶を刪除しました', '記憶を削除しました', '기억을 삭제했습니다'),
};

// The suffix bound belongs to the filename contract (slug <= 64), so the
// complete entry id is longer than 64 for the user/feedback prefixes.
const entryPattern = /^(user|feedback|project|reference)_[a-z0-9_-]{1,64}$/;
const hashEntryPattern = /^h[a-f0-9]{12}$/;
const memoryPattern = /^settings:([A-Za-z0-9_-]{1,128})\/memory(?:\/([a-z0-9_-]{1,80}))?$/;
const idFor = (botId: string, entry?: string) => `settings:${botId}/memory${entry ? `/${entry}` : ''}`;
const refFor = (id: string) => ({ collectionId: BOT_MEMORY_COLLECTION_ID, kind: 'bot', id });
const digest = (filename: string) => createHash('sha256').update(filename).digest('hex').slice(0, 12);

export function botMemoryEntryResourceId(botId: string, filename: string): string {
  const entry = filename.replace(/\.md$/, '');
  const direct = idFor(botId, entry);
  return direct.length <= 160 ? direct : idFor(botId, `h${digest(filename)}`);
}

export function parseBotMemoryResourceId(id: string): { botId: string; entry?: string } | null {
  const match = memoryPattern.exec(id);
  if (!match) return null;
  const entry = match[2];
    if (entry && !entryPattern.test(entry) && !hashEntryPattern.test(entry)) return null;
  return { botId: match[1], ...(entry ? { entry } : {}) };
}

const timestamp = (iso: string) => {
  const value = Date.parse(iso);
  return Number.isFinite(value) ? { timestamp: value } : {};
};
const preview = (value: string) => {
  const chars = Array.from(value);
  return chars.length > 140 ? `${chars.slice(0, 140).join('').trimEnd()}…` : value;
};
const revisionFor = (query: string, summaries: readonly BotMemorySummary[]) => createHash('sha256')
  .update(JSON.stringify([query, summaries.map((item) => [item.filename, item.updatedAt, item.title])]))
  .digest('hex');
const notFound = (): never => {
  throw new RemoteResourceRegistryError('NOT_FOUND', 'Memory not found');
};
const invalid = (): never => throwIpcError('INVALID_PARAMS', 'Invalid memory input');

function assertContext(context: RemoteResourceHostContext): BotMemoryOperationGuard {
  return () => context.assertCurrent?.();
}

function removeBody(botName: string, title: string): RemoteLocalizedText {
  return text(`${botName} will no longer refer to “${title}”.`, `${botName}之后不会再参考「${title}」。`, `${botName}之後不會再參考「${title}」。`, `${botName}は今後「${title}」を参照しません。`, `${botName}은(는) 앞으로 “${title}”을(를) 참고하지 않습니다.`);
}

export function createBotRemoteMemoryResource(
  service: BotRemoteMemoryService,
  context: RemoteResourceHostContext,
  botId: string,
  botName: string,
  query?: string,
  entry?: string,
): Promise<RemoteResource> {
  const guard = assertContext(context);
  return (async () => {
    guard();
    const base = idFor(botId);
    if (!entry) {
      const normalizedQuery = query?.trim().slice(0, 200) ?? '';
      const summaries = await service.list(botId, normalizedQuery || undefined, guard);
      guard();
      const groups = BOT_MEMORY_TYPES.flatMap((type) => {
        const items = summaries.filter((item) => item.type === type);
        if (!items.length) return [];
        const entries = items.slice(0, 2000).map((item) => ({
          id: item.filename.replace(/\.md$/, ''),
          title: item.title,
          subtitle: preview(item.preview),
          ...timestamp(item.updatedAt),
          resourceId: botMemoryEntryResourceId(botId, item.filename),
        }));
        return [{
          id: `memory-${type}`, primitive: 'list' as const, title: memoryCopy.types[type],
          fallbackMarkdown: items.map((item) => `- ${item.title}`).join('\n'),
          data: { count: items.length, entries },
        } satisfies RemoteResourceBlock];
      });
      const blocks: RemoteResourceBlock[] = [{
        id: 'search', primitive: 'search', fallbackMarkdown: '',
        data: { query: normalizedQuery, placeholder: memoryCopy.search },
      }, ...groups];
      return {
        ref: refFor(base), revision: revisionFor(normalizedQuery, summaries),
        display: { title: memoryCopy.memories, subtitle: botName }, links: [], blocks,
      };
    }
    if (!entryPattern.test(entry) && !hashEntryPattern.test(entry)) return notFound();
    let filename = `${entry}.md`;
    if (entry.startsWith('h')) {
      const all = await service.list(botId, undefined, guard);
      const match = all.find((item) => digest(item.filename) === entry.slice(1));
      filename = match?.filename ?? notFound();
    }
    const detail = await service.read(botId, filename, guard);
    guard();
    const id = idFor(botId, entry);
    const expectedUpdatedAt = detail.updatedAt;
    return {
      ref: refFor(id), revision: detail.updatedAt,
      display: { title: detail.title, subtitle: memoryCopy.types[detail.type], ...timestamp(detail.updatedAt) },
      links: [{ rel: 'parent', target: { kind: 'resource', ref: refFor(base) }, label: memoryCopy.memories }],
      blocks: [
        { id: 'entry', primitive: 'form', title: memoryCopy.edit, fallbackMarkdown: detail.body, data: { actionId: 'memory-update', values: { title: detail.title, body: detail.body, expectedUpdatedAt } } },
        { id: 'remove', primitive: 'action', fallbackMarkdown: memoryCopy.remove.fallback, data: { actionId: 'memory-delete', expectedUpdatedAt } },
      ],
      actions: [
        { id: 'memory-update', label: memoryCopy.edit, fields: [
          { id: 'title', label: memoryCopy.title, kind: 'text' as const, required: true },
          { id: 'body', label: memoryCopy.body, kind: 'multiline' as const, required: true },
        ] },
        { id: 'memory-delete', label: memoryCopy.remove, tone: 'destructive',
          confirmation: { title: memoryCopy.removeTitle, body: removeBody(botName, detail.title), confirmLabel: memoryCopy.delete } },
      ],
    };
  })();
}

export async function invokeBotRemoteMemory(
  service: BotRemoteMemoryService,
  context: RemoteResourceHostContext,
  botId: string,
  filename: string,
  actionId: string,
  input: Record<string, unknown>,
): Promise<RemoteActionInvokeResponse> {
  const guard = assertContext(context);
  if (typeof input.expectedUpdatedAt !== 'string' || input.expectedUpdatedAt.length > 64) invalid();
  const expectedUpdatedAt = input.expectedUpdatedAt as string;
  if (actionId === 'memory-delete') {
    if (Object.keys(input).some((key) => key !== 'expectedUpdatedAt')) invalid();
    await service.delete({ botId, filename, expectedUpdatedAt }, guard);
    guard();
    return { effects: [{ kind: 'navigate', target: { kind: 'resource', ref: refFor(idFor(botId)) } }, { kind: 'toast', message: memoryCopy.deleted }] };
  }
  if (actionId !== 'memory-update' || Object.keys(input).some((key) => !['title', 'body', 'expectedUpdatedAt'].includes(key))
    || (typeof input.title !== 'string' && typeof input.body !== 'string')) invalid();
  const detail = await service.read(botId, filename, guard);
  const title = input.title === undefined ? detail.title : typeof input.title === 'string' ? input.title : invalid();
  const body = input.body === undefined ? detail.body : typeof input.body === 'string' ? input.body : invalid();
  await service.update({ botId, filename, title, body, expectedUpdatedAt }, guard);
  guard();
  return { effects: [{ kind: 'refresh-resource', ref: refFor(idFor(botId)) }, { kind: 'toast', message: memoryCopy.saved }] };
}
