import type { CodexNativeApprovalRequest, CodexNativeApprovalResponse, CodexNativeInteractionRequest } from './native-approvals.js';

export interface CodexNativeFileApprovalCopy {
  header: string; confirmation: string; once: string; onceDescription: string; cancel: string; cancelDescription: string;
}
const defaultCopy: CodexNativeFileApprovalCopy = {
  header: 'File changes', confirmation: 'Lex requires confirmation for these changes.',
  once: 'Apply these changes once', onceDescription: 'Apply only these changes without granting future access.',
  cancel: 'Cancel these changes', cancelDescription: 'Do not apply these changes.',
};
const questionId = 'lex-file-change';
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Upstream's patch overlay cannot hide its fixed session grant option. */
export function projectNativeFileApproval(request: CodexNativeApprovalRequest, localizedCopy = defaultCopy): {
  request: CodexNativeInteractionRequest;
  decode(value: unknown): CodexNativeApprovalResponse | undefined;
} {
  if (request.method !== 'item/fileChange/requestApproval') throw new Error('Native file approval required');
  const copy = structuredClone(localizedCopy), params = structuredClone(request.params);
  if (!copy.once || !copy.cancel || copy.once === copy.cancel) throw new Error('Native file choices must be distinct');
  return {
    request: { id: request.id, method: 'item/tool/requestUserInput', params: {
      threadId: params.threadId, turnId: params.turnId, itemId: params.itemId,
      isBlocking: true, autoResolutionMs: null, questions: [{
        id: questionId, header: copy.header, isOther: false, isSecret: false,
        question: [copy.confirmation, typeof params.reason === 'string' ? params.reason : '',
          JSON.stringify({ changes: params.changes, grantRoot: params.grantRoot }, null, 2)].filter(Boolean).join('\n\n'),
        options: [{ label: copy.once, description: copy.onceDescription },
          { label: copy.cancel, description: copy.cancelDescription }],
      }],
    } },
    decode: value => {
      if (!record(value) || Object.keys(value).length !== 1 || !record(value.answers)
        || Object.keys(value.answers).some(key => key !== questionId)) return undefined;
      const answer = value.answers[questionId];
      if (answer === undefined && Object.keys(value.answers).length === 0) return { decision: 'cancel' };
      if (!record(answer) || Object.keys(answer).length !== 1 || !Array.isArray(answer.answers)
        || answer.answers.length > 1) return undefined;
      const choice = answer.answers[0];
      if (choice === copy.once) return { decision: 'accept' };
      if (choice === undefined || choice === copy.cancel) return { decision: 'cancel' };
      return undefined;
    },
  };
}
