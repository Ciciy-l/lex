/** Legacy layouts derive identity from the tab/pane pair; new panes store an ID. */
export function terminalPtyId(tabId: string, paneId: string): string {
  return `${tabId}:${paneId}`;
}
