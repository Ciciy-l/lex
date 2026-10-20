import type { AgentEvent, InteractionDecision, InteractionRequest } from '@cindy/maker-core';

/** Only the owning Codex adapter can settle a pending GUI question this way. */
export function nativeQuestionDecision(event: AgentEvent, request: InteractionRequest): Extract<InteractionDecision, { kind: 'ask_user_question' }> | undefined {
  if (event.source !== 'codex' || event.type !== 'interaction_dismissed' || request.kind !== 'ask_user_question') return undefined;
  const data = event.data as { requestId?: unknown; reason?: unknown; nativeQuestionAnswers?: unknown };
  if (!data || data.reason !== 'native_answered' || data.requestId !== request.requestId) return undefined;
  const answers = data.nativeQuestionAnswers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return undefined;
  const keys = new Set(request.questions.map(question => question.question));
  const entries = Object.entries(answers);
  if (entries.some(([key, value]) => !keys.has(key) || typeof value !== 'string' || value.length > 1_000_000)) return undefined;
  return { kind: 'ask_user_question', answers: Object.fromEntries(entries) };
}
