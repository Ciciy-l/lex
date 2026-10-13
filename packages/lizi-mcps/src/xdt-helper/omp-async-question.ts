import { z } from 'zod';
import type { OmpHostToolDefinition } from '@cindy/maker-core';
import type { XdtHelperMcpDeps } from '../lizi_xdtHelperMcpServer.js';
import type { LiziMcpSessionContext } from '../types.js';
import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { registerAsyncQuestionTool } from './ask_user_question_async.js';
import { errorPayload } from './_payload.js';

/** A bounded native OMP host tool, separate from the approval UI bridge. */
export function createOmpAsyncQuestionTools(
  deps: XdtHelperMcpDeps,
  context: LiziMcpSessionContext,
): readonly OmpHostToolDefinition[] {
  if (!deps.askUserQuestionAsync || context.agentKind !== 'omp') return [];
  const frozenContext = { ...context };
  const registry = new XdtHelperToolRegistry();
  registerAsyncQuestionTool(registry, () => frozenContext, deps.askUserQuestionAsync);
  const definition = registry.get('ask_user_question_async')!;
  return [{
    name: 'mcp__cindy_helper__ask_user_question_async',
    description: definition.description,
    parameters: z.toJSONSchema(z.strictObject(definition.inputShape)) as Record<string, unknown>,
    execute: async (args, { signal }) => {
      const surface = frozenContext.sessionId && deps.resolveSurface
        ? await deps.resolveSurface({ sessionId: frozenContext.sessionId }).catch(() => 'restricted' as const)
        : undefined;
      if (signal.aborted || surface === 'restricted') {
        return errorPayload('QUESTION_UNAVAILABLE', 'Question UI is unavailable for this task.');
      }
      // The common handler validates root provenance, and the host callback
      // rechecks the live Session instance/account after the surface lookup.
      const result = await registry.call(definition.name, args);
      return { content: result.content.filter((part) => part.type === 'text'),
        ...(result.isError ? { isError: true } : {}) };
    },
  }];
}
