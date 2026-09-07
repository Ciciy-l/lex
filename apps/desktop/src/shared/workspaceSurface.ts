/** Presentation identity, independent of the global pane's screen position. */
export type WorkspaceSurface = 'tool' | 'content';
export const WORKSPACE_TOOL_KINDS = ['file-browser', 'background-tasks'] as const;

export function workspaceSurface(kind: string): WorkspaceSurface {
  return (WORKSPACE_TOOL_KINDS as readonly string[]).includes(kind) ? 'tool' : 'content';
}

export function isHiddenTerminal(tab: { kind: string; state: unknown }): boolean {
  return (
    tab.kind === 'terminal' &&
    !!tab.state &&
    typeof tab.state === 'object' &&
    (tab.state as { viewHidden?: unknown }).viewHidden === true
  );
}
