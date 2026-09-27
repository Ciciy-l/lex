import type { RemoteAgentKind } from '@cindy/maker-remote-ssh';
import { throwIpcError } from '../utils/ipcValidate.js';

interface CodexHostActivity {
  installationInProgress: boolean;
  sessionAdmissions: number;
}

const codexHostActivity = new Map<string, CodexHostActivity>();

function getCodexHostActivity(hostId: string): CodexHostActivity {
  let activity = codexHostActivity.get(hostId);
  if (!activity) {
    activity = { installationInProgress: false, sessionAdmissions: 0 };
    codexHostActivity.set(hostId, activity);
  }
  return activity;
}

export function acquireRemoteCodexActivityAdmission(hostId: string): () => void {
  const activity = getCodexHostActivity(hostId);
  if (activity.installationInProgress) {
    throwIpcError('SSH_INSTALL_FAILED', 'Codex installation is in progress; retry after it finishes');
  }
  activity.sessionAdmissions += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activity.sessionAdmissions = Math.max(0, activity.sessionAdmissions - 1);
    if (!activity.installationInProgress && activity.sessionAdmissions === 0) {
      codexHostActivity.delete(hostId);
    }
  };
}

export function acquireRemoteCodexInstallation(hostId: string): () => void {
  const activity = getCodexHostActivity(hostId);
  if (activity.installationInProgress) {
    throwIpcError('SSH_INSTALL_FAILED', 'A Codex installation is already in progress');
  }
  if (activity.sessionAdmissions > 0) {
    throwIpcError('SSH_INSTALL_FAILED', 'Codex session startup is in progress; retry the installation');
  }
  activity.installationInProgress = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activity.installationInProgress = false;
    if (activity.sessionAdmissions === 0) codexHostActivity.delete(hostId);
  };
}

export async function withRemoteCodexInstallation<T>(
  hostId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const release = acquireRemoteCodexInstallation(hostId);
  try {
    return await operation();
  } finally {
    release();
  }
}

export async function prepareRemoteAgentInstall(
  agentKind: RemoteAgentKind,
  deps: {
    isInstalled: () => Promise<boolean>;
    hasLiveTurn: () => boolean;
    stopDaemon: () => Promise<{ ok: boolean }>;
  },
): Promise<void> {
  if (agentKind !== 'codex') return;
  const isInstalled = await deps.isInstalled();
  if (deps.hasLiveTurn()) {
    throwIpcError(
      'SSH_INSTALL_FAILED',
      'Codex upgrade deferred while a remote task is running; retry after it finishes',
    );
  }
  if (isInstalled) return;
  if (!(await deps.stopDaemon()).ok) {
    throwIpcError(
      'SSH_INSTALL_FAILED',
      'Unable to stop the old Codex daemon; reconnect and retry the upgrade',
    );
  }
}
