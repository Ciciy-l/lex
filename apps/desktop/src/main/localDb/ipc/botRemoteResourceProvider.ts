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
  botRemoteCollectionItemFromSource,
  botRemoteResourceFromSource,
  visibleBotRemoteResourceSources,
} from './botRemoteResourceProjection.js';

let registered = false;

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
    async list(_context, request) {
      const rawQuery = request.query?.trim().toLocaleLowerCase() ?? '';
      const sources = visibleBotRemoteResourceSources(await listBotRemoteResourceSources());
      const filtered = rawQuery
        ? sources.filter((source) =>
            [source.name, source.description]
              .some((value) => value.toLocaleLowerCase().includes(rawQuery)))
        : sources;
      const items = filtered
        .slice(0, request.limit ?? 200)
        .map(botRemoteCollectionItemFromSource);
      return {
        collectionId: TEAMMATES_REMOTE_COLLECTION_ID,
        revision: items.map((item) => item.revision).join('|'),
        items,
      };
    },
    async get(context, request) {
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
      if (!source) {
        throw new RemoteResourceRegistryError('NOT_FOUND', 'remote resource does not exist');
      }
      return botRemoteResourceFromSource(source, request.client.primitives.includes('search'));
    },
    async invoke(context, request) {
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
      return invokeBotRemoteMemory(
        getBotMemoryService(), context, memory.botId, filename, request.actionId, request.input,
      );
    },
  });
  registered = true;
}
