import { getMobileAuthOwner, isMobileAuthOwnerCurrent, type MobileAuthOwnerGeneration } from '@/auth/authOwnerGeneration';

export interface AskUserDraft {
  answers: Record<string, string>;
  currentIndex: number;
  customInput: string;
  selectedLabels: string[];
  showCustomInput: boolean;
}

export interface PlanReviewDraft {
  feedback: string;
  feedbackOpen: boolean;
  planText: string;
}

const askUserDrafts = new Map<string, AskUserDraft>();
const planReviewDrafts = new Map<string, PlanReviewDraft>();

export function readAskUserDraft(requestId: string, owner = getMobileAuthOwner()): AskUserDraft | null {
  const draft = askUserDrafts.get(scopedRequest(requestId, owner));
  return draft ? cloneDraft(draft) : null;
}

export function saveAskUserDraft(requestId: string, draft: AskUserDraft, owner = getMobileAuthOwner()): void {
  if (!scopedRequest(requestId, owner)) return;
  askUserDrafts.set(scopedRequest(requestId, owner), cloneDraft(draft));
}

export function clearAskUserDraft(requestId: string, owner = getMobileAuthOwner()): void {
  askUserDrafts.delete(scopedRequest(requestId, owner));
}

export function readPlanReviewDraft(requestId: string, owner = getMobileAuthOwner()): PlanReviewDraft | null {
  const draft = planReviewDrafts.get(scopedRequest(requestId, owner));
  return draft ? clonePlanReviewDraft(draft) : null;
}

export function savePlanReviewDraft(requestId: string, draft: PlanReviewDraft, owner = getMobileAuthOwner()): void {
  if (!scopedRequest(requestId, owner)) return;
  planReviewDrafts.set(scopedRequest(requestId, owner), clonePlanReviewDraft(draft));
}

export function clearPlanReviewDraft(requestId: string, owner = getMobileAuthOwner()): void {
  planReviewDrafts.delete(scopedRequest(requestId, owner));
}

export function clearAllInteractionDrafts(): void {
  askUserDrafts.clear();
  planReviewDrafts.clear();
}

function cloneDraft(draft: AskUserDraft): AskUserDraft {
  return {
    answers: { ...draft.answers },
    currentIndex: Math.max(0, Math.floor(draft.currentIndex)),
    customInput: draft.customInput,
    selectedLabels: [...draft.selectedLabels],
    showCustomInput: draft.showCustomInput,
  };
}

function clonePlanReviewDraft(draft: PlanReviewDraft): PlanReviewDraft {
  return {
    feedback: draft.feedback,
    feedbackOpen: draft.feedbackOpen,
    planText: draft.planText,
  };
}

function scopedRequest(id: string, owner: MobileAuthOwnerGeneration): string { return id && owner.accountKey && isMobileAuthOwnerCurrent(owner) ? JSON.stringify([owner.accountKey, id]) : ''; }
