import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { appendAutoReviewUserIntent, AUTO_REVIEW_DELEGATED_CONTINUATION, AUTO_REVIEW_SOURCE_CONTENT, AUTO_REVIEW_USER_INTENT, MAIN_OWNED_SEND_CONTEXT, type SendOptions } from '@cindy/maker-core';

const source = readFileSync(resolve(__dirname, '..', 'register.ts'), 'utf8');
const compile = (code: string) => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

it.each(['Do not publish.', '', undefined])('keeps live authority through both final delegated steer boundaries: %j', async previous => {
  const start = source.indexOf('const dispatch = native');
  expect(start).toBeGreaterThan(0);
  const end = source.indexOf('\n      });', start) + '\n      });'.length;
  const deliver = new Function('sess', 'native', 'steerPayload', 'so', 'meta', 'restoredSteerIntent',
    'MAIN_OWNED_SEND_CONTEXT', 'AUTO_REVIEW_SOURCE_CONTENT', 'AUTO_REVIEW_USER_INTENT', 'AUTO_REVIEW_DELEGATED_CONTINUATION',
    compile('return (async () => { ' + source.slice(start, end) + ' })();'));
  const invoke = async (delegated: boolean, isNative: boolean) => {
    let result;
    const record = (content: string, options: SendOptions) => {
      result = appendAutoReviewUserIntent(previous, content, options);
    };
    const steer = vi.fn(async function (this: unknown, content: string, options: SendOptions) {
      expect(this).toBe(session);
      record(content, options);
    });
    const acceptNativeSteer = vi.fn(async (input: { message: string }, options: SendOptions) => record(input.message, options));
    const session = { steer, acceptNativeSteer };
    const signal = new AbortController().signal;
    const context = { origin: { kind: 'desktop' }, rawChannelText: 'Human instruction' };
    const nativeInput = { message: 'Original native message', nativeSessionId: 'thread', nativeTurnId: 'turn', inputId: 'native-id', signal };
    const options = { messageUuid: 'receipt', userName: 'User', signal, [MAIN_OWNED_SEND_CONTEXT]: context,
      [AUTO_REVIEW_SOURCE_CONTENT]: '', ...(delegated ? { [AUTO_REVIEW_DELEGATED_CONTINUATION]: true } : {}) };
    await deliver(session, isNative ? { input: nativeInput } : undefined, 'Publish now', options, { title: 'Task' }, 'Old persisted permission',
      MAIN_OWNED_SEND_CONTEXT, AUTO_REVIEW_SOURCE_CONTENT, AUTO_REVIEW_USER_INTENT, AUTO_REVIEW_DELEGATED_CONTINUATION);
    const expectedOptions = { logTitle: 'Task', messageUuid: 'receipt', userName: 'User', signal,
      [MAIN_OWNED_SEND_CONTEXT]: context, [AUTO_REVIEW_SOURCE_CONTENT]: '',
      [AUTO_REVIEW_DELEGATED_CONTINUATION]: delegated ? true : undefined,
      [AUTO_REVIEW_USER_INTENT]: 'Old persisted permission' };
    const checkFields = (actual: object, expected: object) => {
      expect(Reflect.ownKeys(actual)).toHaveLength(Reflect.ownKeys(expected).length);
      for (const key of Reflect.ownKeys(expected)) {
        expect(Object.hasOwn(actual, key)).toBe(true);
        expect(Reflect.get(actual, key), String(key)).toBe(Reflect.get(expected, key));
      }
    };
    if (isNative) {
      expect(acceptNativeSteer).toHaveBeenCalledOnce();
      const [input, actualOptions] = acceptNativeSteer.mock.calls[0]!;
      checkFields(input, { ...nativeInput, message: 'Publish now' });
      checkFields(actualOptions, expectedOptions);
      expect(steer).not.toHaveBeenCalled();
      expect(nativeInput.message).toBe('Original native message');
    } else {
      expect(steer).toHaveBeenCalledOnce();
      const [message, actualOptions] = steer.mock.calls[0]!;
      expect(message).toBe('Publish now');
      checkFields(actualOptions, expectedOptions);
      expect(acceptNativeSteer).not.toHaveBeenCalled();
    }
    return result;
  };
  for (const isNative of [false, true]) {
    expect(await invoke(true, isNative)).toEqual(previous ?? 'Old persisted permission');
    expect(await invoke(false, isNative)).toEqual('Old persisted permission');
  }
});

it('restores human authorization for both live and cold internal delegated sends', () => {
  for(const target of ['live','session']) {
    const start=source.lastIndexOf(`sendUserMessageWithAwaitedGitBaseline(${target}, message, clientId, {`);
    expect(start).toBeGreaterThan(0);
    const options=source.slice(start,source.indexOf('onAccepted: persistUserMessage',start));
    expect(options).toContain('params.autoReviewUserText');
    expect(options).toContain('[AUTO_REVIEW_SOURCE_CONTENT]:');
    expect(options).toContain('restoreAutoReviewUserIntent(await readAutoReviewHistory(targetSessionId))');
  }
});

it('marks plugin dispatch and every queue fallback with the host-only receipt', () => {
  const start = source.indexOf('async function sendToSessionInternal(params: {');
  const end = source.indexOf('const startOrcaTeamForCaller', start);
  const dispatch = source.slice(start, end);
  expect(dispatch).toContain("message: text, autoReviewUserText: { kind: 'delegated-continuation' }, forceQueue: true");
  const queues = [...dispatch.matchAll(/await enqueueSendToSessionMessage\(\{([\s\S]*?)\}\);/g)];
  expect(queues).toHaveLength(4);
  for (const call of queues) expect(call[1]).toContain('autoReviewUserText: params.autoReviewUserText');
  // Both newly created and resumed direct tasks persist the same authored metadata.
  expect(dispatch.match(/agentMeta: inputAgentMeta/g)).toHaveLength(2);
});

it('keeps empty receipts distinct from missing authorship on direct persistence', () => {
  const start = source.indexOf('const inputAgentMeta: AgentMeta');
  const end = source.indexOf('    if (!message)', start);
  expect(start).toBeGreaterThan(0);
  const build = new Function('params', 'queuedOrigin', compile(source.slice(start, end) + '\nreturn inputAgentMeta;'));
  expect(build({ autoReviewUserText: { kind: 'delegated-continuation' } }, undefined)).toEqual({ autoReviewUserText: { kind: 'delegated-continuation' }, delivery: 'turn' });
  expect(build({}, undefined)).toBeUndefined();
  expect(build({ autoReviewUserText: { kind: 'delegated-continuation' } }, { kind: 'orca' })).toMatchObject({ origin: { kind: 'orca' }, autoReviewUserText: { kind: 'delegated-continuation' } });
});

it('builds a durable queued plugin input without promoting plugin text to user intent', async () => {
  const start = source.indexOf('  async function buildSessionControlInputItem(params: {');
  const end = source.indexOf('  const orcaInterAgentDispatcher:', start);
  expect(start).toBeGreaterThan(0);
  const createOpts = { model: 'm', effort: 'high', permissionMode: 'auto', workingDir: '/answer' };
  const build = new Function('buildCreateOptsForQueuedSession', 'permissionModeOrAsk',
    compile(source.slice(start, end) + '\nreturn buildSessionControlInputItem;'))(
      vi.fn(async () => createOpts), (mode: string) => mode,
    );
  const base = { targetSessionId: 'lead', clientId: 'plugin-input', message: 'Plugin instructions', persistedContent: 'Plugin instructions', meta: {} };
  const queued = JSON.parse(JSON.stringify(await build({ ...base, autoReviewUserText: { kind: 'delegated-continuation' } })));
  expect(queued).toMatchObject({ text: base.message, persistedContent: base.persistedContent, autoReviewUserText: { kind: 'delegated-continuation' }, permissionMode: 'auto' });
  expect(await build(base)).not.toHaveProperty('autoReviewUserText');
});

it.each(['empty', 'user', 'worker', 'reserved', 'started', 'ended', 'unavailable'])('seals initial plans against persisted activity: %s', async state => {
  const start = source.indexOf('assertTeamPlanUnstarted: async taskId => {');
  const end = source.indexOf('\n      createSession:', start);
  const property = source.slice(start, end).trim().replace(/,$/, '');
  const tables = ['messages', 'sessions', 'orcaWorkers', 'orcaTeams', 'orcaWorkerCreationReservations'];
  const records = Object.fromEntries(tables.map(name => [name, { name }]));
  let drained = false;
  const snapshot = { client: { drizzle: { select: () => {
    let table: {name: string};
    const query = {
      from(value: {name: string}) { table = value; return query; },
      innerJoin() { return query; }, where() { return query; },
      async limit() {
        expect(drained).toBe(true);
        if (state === 'unavailable') throw new Error('unavailable');
        if (table.name === 'sessions') {
          if (state === 'started') return [{ startedAt: 1, endedAt: null }];
          if (state === 'ended') return [{ startedAt: null, endedAt: 1 }];
          return [{ startedAt: null, endedAt: null }];
        }
        const populated = { user: 'messages', worker: 'orcaWorkers', reserved: 'orcaWorkerCreationReservations' }[state];
        return table.name === populated ? [{ id: 'existing' }] : [];
      },
    };
    return query;
  } } } };
  class PlanError extends Error { constructor(code: string) { super(code); } }
  const check = new Function('snapshot', 'assertCurrent', 'drainPersistQueue', 'PluginTaskError', 'eq', 'and', 'gte', ...tables,
    compile(`return ({${property}}).assertTeamPlanUnstarted;`))(
    snapshot, vi.fn(), async () => { drained = true; }, PlanError, vi.fn(), vi.fn(), vi.fn(), ...tables.map(t => records[t]),
  );
  if (state === 'empty') await expect(check('task')).resolves.toBeUndefined();
  else await expect(check('task')).rejects.toThrow(state === 'unavailable' ? 'unavailable' : 'TASK_BUSY');
});

it('aborts both internal delegated entry points when authorization history cannot be read', async () => {
  for (const target of ['live', 'session']) {
    const start = source.lastIndexOf(`sendUserMessageWithAwaitedGitBaseline(${target}, message, clientId, {`);
    const options = source.slice(start, source.indexOf('onAccepted: persistUserMessage', start));
    const expression = options.slice(options.indexOf('restoreAutoReviewUserIntent('), options.indexOf('),', options.indexOf('restoreAutoReviewUserIntent(')) + 1);
    const evaluate = new Function('readAutoReviewHistory', 'restoreAutoReviewUserIntent', 'targetSessionId', `return (async () => ${expression})();`);
    const restore = vi.fn();
    await expect(evaluate(async () => { throw new Error('unavailable'); }, restore, 'task')).rejects.toThrow('unavailable');
    expect(restore).not.toHaveBeenCalled();
  }
});

it('shares the Lead send lock across whole plan registration and final Worker admission', () => {
  const registration = source.slice(source.indexOf("case 'setTeamPlan':"), source.indexOf("case 'releaseWorker':"));
  expect(registration).toContain('return withSendToSessionLock(request.taskId, async () => {');
  expect(registration.indexOf('await resolvePluginWorkerDirectory(')).toBeGreaterThan(registration.indexOf('withSendToSessionLock('));
  expect(registration.indexOf('return service.setTeamPlan(')).toBeGreaterThan(registration.indexOf('await resolvePluginWorkerDirectory('));
  expect(registration.trimEnd().endsWith('});')).toBe(true);
  const start=source.indexOf('const orcaWorkerCreationService = createOrcaWorkerCreationService({');
  const block=source.slice(start, source.indexOf('getLeadSessionRow:',start));
  expect(block).toContain('withLeadSendLock: withSendToSessionLock');
  expect(block.lastIndexOf('createPluginTaskStore(epoch.client).get')).toBeGreaterThan(block.indexOf('pluginTaskServiceForCurrentOwner!().get'));
});
