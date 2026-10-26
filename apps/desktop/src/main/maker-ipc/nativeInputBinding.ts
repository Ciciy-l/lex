import type { AgentNativeInputConsumptionState } from '@cindy/maker-core';
import type { AgentNativeInputRequest, AgentNativeMediaResolver, Session, UserMessage, UserContentBlock } from '@cindy/maker-core';
import type { AgentInputCreateOpts, AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';
import type { AgentInputCoordinator } from './agent-input-coordinator.js';
import type { createMakerSendTransaction } from './makerSendTransaction.js';
import type { SendOptions } from '@cindy/maker-core';
import { throwIpcError } from '../utils/ipcValidate.js';

/** Product owner of the current Session's native composer; never an IPC surface. */
export interface NativeInputBindingDeps {
  isCurrent(session: Session): boolean;
  assertAllowed(sessionId: string): Promise<void>;
  readCreateOpts(session: Session): Promise<AgentInputCreateOpts>;
  coordinator: Pick<AgentInputCoordinator, 'acceptNativeInput' | 'isExecutionPaused'> & Partial<Pick<AgentInputCoordinator, 'acceptNativeSteer'>>;
  accept: ReturnType<typeof createMakerSendTransaction>['acceptNativeInput'];
  importMedia?: AgentNativeMediaResolver;
  captureConsumption?(session: Session, input: AgentNativeInputRequest):
    (state: AgentNativeInputConsumptionState, clearBoundaryMs: number | null) => Promise<boolean>;

  steer?(session: Session, input: AgentNativeInputRequest, options: SendOptions): Promise<void>;
  /** Refuse contention rather than wait behind a GUI submission to the native process. */
  withIdleSendLock<T>(sessionId: string, run: () => Promise<T>): Promise<T>;
}

function nativeText(message: UserMessage): string {
  return typeof message.content === 'string' ? message.content
    : message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
}

/** Preserve block order/identities unless a host hook explicitly rewrites text. */
export function preparedNativeMessage(message: UserMessage, text: string): UserMessage {
  if (text === nativeText(message)) return structuredClone(message);
  if (typeof message.content === 'string') return { type: 'user', content: text };
  let inserted = false;
  const content = message.content.flatMap<UserContentBlock>(block => {
    if (block.type !== 'text') return [block];
    if (inserted) return [];
    inserted = true;
    return [{ type: 'text', text }];
  });
  if (!inserted) content.unshift({ type: 'text', text });
  return { type: 'user', content: structuredClone(content) };
}

/** Native images must already carry an imported identity for durable/remote history. */
export function nativeInputQueueItem(input: AgentNativeInputRequest, createOpts: AgentInputCreateOpts): AgentInputQueuedMessage {
  const text = nativeText(input.message), clientId = input.nativeMessageId ?? input.submissionId;
  const images: Array<{ url: string; mimeType: string; originalName: string }> = [];
  const files: Array<{ name: string; path: string }> = [];
  if (Array.isArray(input.message.content)) for (const block of input.message.content) {
    if (block.type === 'image') {
      if (!block.managedUrl || !block.managedUrl.startsWith('cindy-media://blobs/')) {
        throwIpcError('PRECONDITION_FAILED', 'Native image has not been imported into task media');
      }
      images.push({ url: block.managedUrl, mimeType: block.mimeType ?? 'application/octet-stream', originalName: 'image' });
    } else if (block.type === 'file' || block.type === 'mention') {
      files.push({ name: block.type === 'mention' ? block.name : block.path.split(/[\\/]/).pop() ?? 'file', path: block.path });
    }
  }
  return {
    clientId, text, autoReviewUserText: input.source?.origin.kind === 'plugin' ? '' : text,
    persistedContent: images.length || files.length ? JSON.stringify({ text, images, files }) : text,
    model: createOpts.model, effort: createOpts.effort ?? '',
    permissionMode: createOpts.permissionMode ?? 'ask', workingDir: createOpts.workingDir,
    createOpts, chatMessage: { clientId, role: 'user', content: text,
      ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) },
  };
}

export function bindNativeSessionInput(session: Session, deps: NativeInputBindingDeps): () => void {
  return session.onNativeInput(async input => {
    const assertCurrent = () => {
      if (input.signal.aborted || !deps.isCurrent(session) || deps.coordinator.isExecutionPaused(session.id)) {
        throwIpcError('PRECONDITION_FAILED', 'Native input no longer belongs to an active task');
      }
    };
    assertCurrent();
    await deps.assertAllowed(session.id);
    assertCurrent();
    const createOpts = await deps.readCreateOpts(session);
    assertCurrent();
    const item = nativeInputQueueItem(input, createOpts);
    if (input.nativeTurnId) {
      if (!input.nativeMessageId && !(input.submissionId && session.agentKind === 'omp' && input.consumption))
        throwIpcError('PRECONDITION_FAILED', 'Native steering has no recorded message identity');
      const generation = session.getTurnGeneration();
      const checkTurn = () => {
        assertCurrent();
        if (session.getCurrentTurnId() !== input.nativeTurnId || session.getTurnGeneration() !== generation) {
          throwIpcError('PRECONDITION_FAILED', 'Native steering turn changed');
        }
      };
      checkTurn();
      if (!deps.steer || !deps.coordinator.acceptNativeSteer) throwIpcError('PRECONDITION_FAILED', 'Native steering owner unavailable');
      await deps.coordinator.acceptNativeSteer(session.id, item, {
        session, turnGeneration: generation, messageId: item.clientId, signal: input.signal,
        ...(input.source ? { source: input.source } : {}),
        ...(input.consumption ? { consumption: input.consumption,
          persistConsumption: deps.captureConsumption?.(session, input) } : {}),
        buildMessage: head => preparedNativeMessage(input.message, head.text),
        dispatch: async (_id, message, options) => {
          checkTurn(); await deps.assertAllowed(session.id); checkTurn();
          await deps.steer!(session, { ...input, message: message as UserMessage }, options);
        },
      });
      return;
    }
    await deps.coordinator.acceptNativeInput(session.id, item, {
      session, messageId: item.clientId, signal: input.signal,
      buildMessage: head => preparedNativeMessage(input.message, head.text),
      dispatch: async (_id, message, _create, options) => deps.withIdleSendLock(session.id, async () => {
        assertCurrent();
        await deps.assertAllowed(session.id);
        assertCurrent();
        const result = await deps.accept(session, { ...input, message: message as UserMessage }, options, input.source);
        return result.outcome;
      }),
    });
  }, deps.importMedia);
}
