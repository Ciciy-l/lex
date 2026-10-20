import { CodexNativeApprovals } from './native-approvals.js';
import type { InteractionDecision } from '../../types/events.js';
import type { ToolRequestUserInputParams, ToolRequestUserInputQuestion } from './app-server/protocol.js';

type Answer = Extract<InteractionDecision, { kind: 'ask_user_question' }>;
export interface CodexNativeQuestionRequest { id: string | number; params: ToolRequestUserInputParams }
interface Entry {
  questions: readonly ToolRequestUserInputQuestion[];
  settled: boolean;
  prompts: Map<string | number, { close(): void }>;
  current(): boolean;
  finish(answer: Answer, native: boolean): boolean;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Convert by position only after the existing caller has established duplicate identity. */
export function nativeQuestionAnswer(response: unknown, questions: readonly ToolRequestUserInputQuestion[],
  ownerQuestions: readonly ToolRequestUserInputQuestion[]): Answer | undefined {
  if (!record(response) || Object.keys(response).length !== 1 || !record(response.answers)
    || questions.length !== ownerQuestions.length || questions.some(q => q.isSecret)) return undefined;
  const ids = new Set(questions.map(q => q.id));
  if (ids.size !== questions.length || Object.keys(response.answers).some(id => !ids.has(id))) return undefined;
  const entries: Array<[string, string]> = [];
  for (const [index, question] of questions.entries()) {
    const value = response.answers[question.id];
    if (value === undefined) continue;
    if (!record(value) || Object.keys(value).length !== 1 || !Array.isArray(value.answers)
      || value.answers.length > 100 || value.answers.some(a => typeof a !== 'string' || a.length > 100_000)) return undefined;
    const answer = JSON.stringify(value.answers);
    // Keep the same accepted representation as the durable host decision.
    if (answer.length > 1_000_000) return undefined;
    entries.push([ownerQuestions[index]!.question, answer]);
  }
  return { kind: 'ask_user_question', answers: Object.fromEntries(entries) };
}

/** Mirrors an existing GUI question; never opens a new question or policy decision. */
export class CodexNativeQuestions {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly broker: CodexNativeApprovals,
    private readonly answered: (requestId: string, answer: Answer) => void) {}

  open(requestId: string, questions: readonly ToolRequestUserInputQuestion[], current: () => boolean) {
    if (this.entries.has(requestId)) throw new Error('Native question already has an owner');
    let resolve!: (answer: Answer) => void;
    const decision = new Promise<Answer>(done => { resolve = done; });
    const entry: Entry = { questions: structuredClone(questions), settled: false, prompts: new Map(), current,
      finish: (answer, native) => {
        if (entry.settled) return false;
        entry.settled = true; this.entries.delete(requestId);
        for (const prompt of entry.prompts.values()) prompt.close();
        entry.prompts.clear(); resolve(structuredClone(answer));
        if (native) this.answered(requestId, structuredClone(answer));
        return true;
      },
    };
    this.entries.set(requestId, entry);
    return { decision,
      gui: (answer: InteractionDecision) => entry.finish(answer.kind === 'ask_user_question' ? answer
        : { kind: 'ask_user_question', answers: {}, dismissed: true }, false),
      close: () => entry.finish({ kind: 'ask_user_question', answers: {}, dismissed: true }, false),
    };
  }

  attach(ownerId: string, request: CodexNativeQuestionRequest): { close(): void } {
    const entry = this.entries.get(ownerId);
    // Protocol aliases share the owner's visible prompt and eventual answer.
    if (!entry || entry.settled || !entry.current() || entry.prompts.size > 0) return { close() {} };
    const prompt = this.broker.openInteraction({ id: request.id, method: 'item/tool/requestUserInput',
      params: { isBlocking: true, autoResolutionMs: null, ...structuredClone(request.params) } }, {
      normalize: value => entry.current() && !entry.settled
        ? nativeQuestionAnswer(value, request.params.questions, entry.questions) : undefined,
      accept: answer => { entry.finish(answer, true); },
    });
    entry.prompts.set(request.id, prompt);
    return { close() { entry.prompts.delete(request.id); prompt.close(); } };
  }

  /** The native tool can end while the existing GUI follow-up remains answerable. */
  retireNative(requestId: string | number): void {
    for (const entry of this.entries.values()) {
      const prompt = entry.prompts.get(requestId);
      entry.prompts.delete(requestId); prompt?.close();
    }
  }

  cancel(requestId: string): void {
    this.entries.get(requestId)?.finish({ kind: 'ask_user_question', answers: {}, dismissed: true }, false);
  }
}
