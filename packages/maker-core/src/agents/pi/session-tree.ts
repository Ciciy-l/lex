/** Shared upstream journal envelope; callers preserve the actual engine identity. */
export {
  normalizeNativeJournalTree as normalizePiSessionTree,
  activeNativeJournalHistory as activePiHistoryFromTree,
  nativeJournalContextTokens as piContextTokensFromTree,
  findNativeJournalEntry as findPiTreeEntry,
  nativeJournalDraftText as userDraftTextFromPiEntry,
} from '../shared/native-session-tree.js';
