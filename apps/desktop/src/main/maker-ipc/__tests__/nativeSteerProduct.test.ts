import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8');
const start = source.indexOf('  const steerToAgentAccepted = async (');
const end = source.indexOf('  const trustedDesktopSteerText', start);
const code = ts.transpileModule(source.slice(start, end) + '; return steerToAgentAccepted;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture() {
  const controller = new AbortController();
  let turn = 'turn';
  const native = vi.fn(async (_input: unknown, _options: unknown) => {});
  const gui = vi.fn(async (_message: unknown, _options: unknown) => {});
  const session = { id: 'task', sdkSessionId: 'native', agentKind: 'codex',
    capabilities: { sameTurnSteer: { supported: true } }, isTurnRunning: () => true,
    getTurnGeneration: () => 1, getCurrentTurnId: () => turn, acceptNativeSteer: native, steer: gui };
  const message = { type: 'user', content: [{ type: 'image', path: '/managed/image',
    managedUrl: 'cindy-media://blobs/image.png', pathOrigin: 'desktop-host' }] };
  const input = { nativeSessionId: 'native', nativeTurnId: 'turn', nativeMessageId: 'row',
    message, signal: controller.signal, accept: vi.fn() };
  const deps = {
    maker: { getSession: () => session, getSessionMeta: async () => ({ title: 'fixture' }) },
    assertReviewExternalInputAllowed: vi.fn(async () => {}), assertNotRetiredCompanionSession: vi.fn(async () => {}),
    prepareUserMessageForAgent: vi.fn(async (_id: string, value: unknown) => value),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }, summarizeIpcUserMessage: () => ({}),
    restoreAutoReviewSteerIntent: vi.fn(async () => 'reviewed intent'), readAutoReviewHistory: vi.fn(),
    isMobileControllerInvoke: () => false, shouldPrependMobileClientPromptNote: () => false,
    buildMobileClientPromptNote: vi.fn(), prependNoteToWireUserMessage: vi.fn(),
    isDeviceLinkInvoke: () => false, assertRemoteInputClearNotInFlight: vi.fn(),
    readRemoteInputClearBoundaryPrecondition: () => ({ present: false }), assertCurrentInputClearBoundary: vi.fn(),
    assertCurrentInputGeneration: vi.fn(), readExpectedInputGeneration: () => 1,
    publishUiSessionIntervention: vi.fn(), throwIpcError: (_code: string, text: string) => { throw new Error(text); },
    MAIN_OWNED_SEND_CONTEXT: Symbol('context'), AUTO_REVIEW_SOURCE_CONTENT: Symbol('source'),
    AUTO_REVIEW_DELEGATED_CONTINUATION: Symbol('delegated'), AUTO_REVIEW_USER_INTENT: Symbol('intent'),
  };
  const run = new Function(...Object.keys(deps), code)(...Object.values(deps));
  const options = { messageUuid: 'row', expectedTurnSession: session, expectedTurnGeneration: 1, signal: controller.signal };
  return { deps, input, session, native, gui, options, controller, nextTurn: () => { turn = 'new'; },
    run: () => run('task', message, options, { session, input }), guiRun: () => run('task', message, options) };
}

describe('native and GUI steering share Main preparation', () => {
  it('retains already imported native media identity while restoring review intent and publishing intervention', async () => {
    const f = fixture(); await f.run();
    expect(f.deps.prepareUserMessageForAgent).not.toHaveBeenCalled();
    expect(f.deps.restoreAutoReviewSteerIntent).toHaveBeenCalledOnce();
    expect(f.deps.publishUiSessionIntervention).toHaveBeenCalledExactlyOnceWith('task');
    expect(f.native).toHaveBeenCalledWith(f.input, expect.objectContaining({ messageUuid: 'row',
      [f.deps.AUTO_REVIEW_USER_INTENT]: 'reviewed intent', signal: f.controller.signal }));
    expect(f.gui).not.toHaveBeenCalled();
  });
  it('keeps GUI normalization and dispatch unchanged', async () => {
    const f = fixture(); await f.guiRun();
    expect(f.deps.prepareUserMessageForAgent).toHaveBeenCalledOnce();
    expect(f.gui).toHaveBeenCalledOnce(); expect(f.native).not.toHaveBeenCalled();
  });
  it.each(['turn', 'cancel'])('rejects %s during review preparation before native dispatch', async boundary => {
    const f = fixture();
    f.deps.restoreAutoReviewSteerIntent.mockImplementation(async () => {
      if (boundary === 'turn') f.nextTurn(); else f.controller.abort();
      return 'reviewed intent';
    });
    await expect(f.run()).rejects.toThrow('STALE_TURN');
    expect(f.native).not.toHaveBeenCalled(); expect(f.deps.publishUiSessionIntervention).not.toHaveBeenCalled();
  });
});
