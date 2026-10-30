/** Local Desktop import only; IDs are opaque handles held by Main. */
export interface CindyImportSource { id: string; label: string; location: string; accountIndex: number }
export interface CindyImportCandidate {
  id: string; title: string; agentKind: 'cc' | 'codex' | 'pi' | 'omp';
  workingDir: string | null; workspaceKind: 'project' | 'dialogue';
  archived: boolean; updatedAt: number; imported: boolean;
}
export interface CindyImportScan { scanId: string; candidates: CindyImportCandidate[]; excluded: number }
export interface CindyImportPreview {
  id: string; title: string; issues: string[]; missingFiles: string[]; error?: string; historyIncomplete: boolean;
  needsDirectory: boolean; workingDir: string | null;
}
export interface CindyImportResult { id: string; status: 'imported' | 'skipped' | 'failed' | 'canceled'; sessionId?: string; code?: string }
export interface CindyImportPreferences {
  model?: string; providerId?: string | null; effort?: string; permissionMode?: string;
  planMode?: boolean; fastMode?: boolean;
}
export interface CindyImportCommit {
  previewId: string; allowIncomplete: boolean;
  preferences: Partial<Record<'cc' | 'codex' | 'pi' | 'omp', CindyImportPreferences>>;
}
export interface CindyImportApi {
  discover(): Promise<CindyImportSource[]>;
  chooseSource(): Promise<CindyImportSource[]>;
  scan(sourceId: string): Promise<CindyImportScan>;
  preview(scanId: string, ids: string[]): Promise<{ previewId: string; items: CindyImportPreview[] }>;
  chooseProject(previewId: string, id: string): Promise<string | null>;
  commit(input: CindyImportCommit): Promise<CindyImportResult[]>;
  cancel(): Promise<void>;
}
