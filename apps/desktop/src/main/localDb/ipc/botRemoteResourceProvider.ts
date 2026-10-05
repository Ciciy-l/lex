import { createHash } from 'node:crypto';
import {
  getBotRemoteResourceSource,
  getBotMemoryService,
  listBotRemoteResourceSources,
} from './bots.js';
import {
  createBotRemoteMemoryResource,
  invokeBotRemoteMemory,
  parseBotMemoryResourceId,
} from './botRemoteMemory.js';
import { RemoteResourceRegistryError, remoteResourceRegistry } from '../../device-link/remoteResourceRegistry.js';
import {
  BOT_REMOTE_RESOURCE_KIND,
  TEAMMATES_REMOTE_COLLECTION_ID,
  TEAMMATES_TITLE,
  botRemoteCreateCollectionItem,
  botRemoteCollectionItemFromSource,
  botRemoteResourceFromSource,
  visibleBotRemoteResourceSources,
} from './botRemoteResourceProjection.js';
import { botRemoteManagement } from './botRemoteManagement.js';
import { editorCopy } from './botRemoteEditors.js';

let registered = false;

function isBotMemoryResourceId(id: string | undefined): boolean {
  if (typeof id !== 'string') return false;
  const marker = id.indexOf('/memory');
  if (marker <= 'settings:'.length) return false;
  const suffix = id.slice(marker + '/memory'.length);
  return suffix === '' || suffix.startsWith('/');
}

/** Register the Bot module through the same API future host modules use. */
export function registerBotRemoteResourceProvider(): void {
  if (registered) return;
  remoteResourceRegistry.register({
    collection: {
      id: TEAMMATES_REMOTE_COLLECTION_ID,
      resourceKind: BOT_REMOTE_RESOURCE_KIND,
      title: TEAMMATES_TITLE,
      placement: 'home-scope',
      icon: { name: 'users', fallbackText: '••' },
    },
    async list(context, request) {
      context.assertCurrent?.();
      const rawQuery = request.query?.trim().toLocaleLowerCase() ?? '';
      const sources = visibleBotRemoteResourceSources(await listBotRemoteResourceSources());
      context.assertCurrent?.();
      const filtered = rawQuery
        ? sources.filter((source) =>
            [source.name, source.description]
              .some((value) => value.toLocaleLowerCase().includes(rawQuery)))
        : sources;
      const limit = Math.max(0, request.limit ?? 200);
      const includeCreate = request.client.primitives.includes('form') && !rawQuery && limit > 0;
      const items = [
        ...(includeCreate ? [botRemoteCreateCollectionItem()] : []),
        ...filtered
          .slice(0, Math.max(0, limit - (includeCreate ? 1 : 0)))
          .map(botRemoteCollectionItemFromSource),
      ];
      return {
        collectionId: TEAMMATES_REMOTE_COLLECTION_ID,
        revision: items.map((item) => item.revision).join('|'),
        items,
      };
    },
    async get(context, request) {
      context.assertCurrent?.();
      if (request.ref.id === 'create') {
        return botRemoteManagement.getEditor(context, request.ref.id, request.client.locale);
      }
      if (request.ref.id.startsWith('settings:') && !isBotMemoryResourceId(request.ref.id)) {
        const settingsId = request.ref.id.slice('settings:'.length);
        if (!settingsId.includes('/')) {
          const [source] = visibleBotRemoteResourceSources([await getBotRemoteResourceSource(settingsId)]);
          context.assertCurrent?.();
          if (!source) throw new RemoteResourceRegistryError('NOT_FOUND', 'remote resource does not exist');
          // `botRemoteManagement.get` is also used for the desktop-owned Bot
          // projection and therefore returns the canonical Bot id.  Settings
          // are a separate resource namespace on the wire; preserve the
          // requested ref so the registry cannot mistake a valid settings
          // payload for a provider scope violation.
          const resource = await botRemoteManagement.get(context, settingsId);
          const settingsResource = { ...resource, ref: request.ref };
          for (const page of ['avatar', 'skills', 'connections'] as const) {
            const data = {
              entries: [{ id: page, title: editorCopy[page], resourceId: 'settings:' + settingsId + '/' + page }],
            };
            settingsResource.blocks?.push({ id: page, primitive: 'list', fallbackMarkdown: '', data });
          }
          return settingsResource;
        }
        const resource = await botRemoteManagement.getEditor(context, request.ref.id, request.client.locale);
        context.assertCurrent?.();
        return resource;
      }
      const memory = parseBotMemoryResourceId(request.ref.id);
      if (memory) {
        const [source] = visibleBotRemoteResourceSources([
          await getBotRemoteResourceSource(memory.botId),
        ]);
        if (!source) throw new RemoteResourceRegistryError('NOT_FOUND', 'remote resource does not exist');
        context.assertCurrent?.();
        return createBotRemoteMemoryResource(
          getBotMemoryService(), context, memory.botId, source.name, request.query, memory.entry,
        );
      }
      const [source] = visibleBotRemoteResourceSources([
        await getBotRemoteResourceSource(request.ref.id),
      ]);
      context.assertCurrent?.();
      if (!source) {
        throw new RemoteResourceRegistryError('NOT_FOUND', 'remote resource does not exist');
      }
      const resource = request.client.primitives.includes('form')
        ? await botRemoteManagement.get(context, source.id)
        : source.invitation?.stage === 'failed'
          ? await botRemoteManagement.getInvitation(context, source.id)
          : botRemoteResourceFromSource(source, request.client.primitives.includes('search'));
      // Settings are a second-level resource on controllers that understand
      // portable forms. Older hosts still get a truthful basic Bot resource;
      // they never receive an apparently successful empty editor.
      if (request.client.primitives.includes('form')) {
        for (const page of ['avatar', 'skills', 'connections'] as const) {
          const block = resource.blocks?.find((candidate) => candidate.id === page);
          const data = {
            entries: [{
              id: page,
              title: editorCopy[page],
              resourceId: 'settings:' + source.id + '/' + page,
            }],
          };
          if (block) block.data = data;
          else resource.blocks?.push({ id: page, primitive: 'list', fallbackMarkdown: '', data });
        }
      }
      context.assertCurrent?.();
      return resource;
    },
    async invoke(context, request) {
      context.assertCurrent?.();
      // Settings forms are available both under the explicit `settings:<id>`
      // resource and, for a form-capable client, the canonical Bot resource.
      // Invitation retry also comes from the canonical resource with an opaque
      // action id, so routing only by a literal action prefix would make the
      // retry unreachable.  Memory remains the sole Bot subresource owned by
      // the memory provider below.
      const resourceId = request.resourceRef?.id;
      const settingsAction = resourceId === 'create'
        || request.actionId.startsWith('retry-invitation')
        || (typeof resourceId === 'string' && !isBotMemoryResourceId(resourceId));
      if (settingsAction) return botRemoteManagement.invoke(context, request);
      const memory = parseBotMemoryResourceId(request.resourceRef?.id ?? '');
      if (!memory?.entry || !request.resourceRef || !request.input) {
        throw new RemoteResourceRegistryError('UNSUPPORTED_CAPABILITY', 'remote action is not available');
      }
      let filename = `${memory.entry}.md`;
      if (memory.entry.startsWith('h')) {
        const summaries = await getBotMemoryService().list(memory.botId, undefined, context.assertCurrent);
        const match = summaries.find((item) => createHash('sha256').update(item.filename).digest('hex').slice(0, 12) === memory.entry!.slice(1));
        if (!match) throw new RemoteResourceRegistryError('NOT_FOUND', 'Memory not found');
        filename = match.filename;
      }
      const response = await invokeBotRemoteMemory(
        getBotMemoryService(), context, memory.botId, filename, request.actionId, request.input,
      );
      context.assertCurrent?.();
      return response;
    },
  });
  registered = true;
}
