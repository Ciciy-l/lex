export interface FileContentTabState {
  preview?: boolean;
  reveal?: { line: number; column?: number; requestId: string } | null;
  path: string;
  workdir: string;
  external: boolean;
  remoteHostId?: string | null;
  deviceId?: string | null;
}

/** Explicit local (null) and unresolved (omitted) endpoints are not interchangeable. */
export function fileContentIdentity(file: FileContentTabState): string {
  const deviceId = file.external ? null : file.deviceId;
  const remoteHostId = file.external || deviceId ? null : file.remoteHostId;
  return JSON.stringify([file.workdir, file.path, file.external, { remoteHostId, deviceId }]);
}

export function hydrateFileContentTab(raw: unknown): FileContentTabState {
  const state = raw && typeof raw === 'object' ? (raw as Partial<FileContentTabState>) : {};
  const reveal = state.reveal;
  return {
    preview: state.preview === true,
    reveal: reveal && Number.isSafeInteger(reveal.line) && reveal.line > 0 && typeof reveal.requestId === 'string'
      ? { line: reveal.line, column: Number.isSafeInteger(reveal.column) && reveal.column! > 0 ? reveal.column : 1, requestId: reveal.requestId } : null,
    path: typeof state.path === 'string' ? state.path : '',
    workdir: typeof state.workdir === 'string' ? state.workdir : '',
    external: state.external === true,
    ...(state.remoteHostId === null || typeof state.remoteHostId === 'string'
      ? { remoteHostId: state.remoteHostId }
      : {}),
    ...(state.deviceId === null || typeof state.deviceId === 'string'
      ? { deviceId: state.deviceId }
      : {}),
  };
}
