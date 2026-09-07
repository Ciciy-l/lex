import type { Terminal, ILink } from '@xterm/xterm';

export interface TerminalFileLink { path: string; line?: number; column?: number; start: number; end: number }
/** Bounded tokenization keeps long ConPTY space padding out of backtracking patterns. */
export function terminalFileLinks(text: string): TerminalFileLink[] {
  const results: TerminalFileLink[] = [];
  const tokens = /"[^"\r\n]+"(?::\d+(?::\d+)?)?|'[^'\r\n]+'(?::\d+(?::\d+)?)?|[^\s<>"']+/g;
  for (const match of text.slice(0, 16384).matchAll(tokens)) {
    let token = match[0];
    if (token.includes('://')) continue;
    const leading = token.startsWith('(') ? 1 : 0;
    token = token.slice(leading).replace(/[),;]+$/, '');
    const location = /:(\d+)(?::(\d+))?:?$/.exec(token);
    let file = location ? token.slice(0, location.index) : token.replace(/:$/, '');
    file = file.replace(/^["']|["']$/g, '');
    if (!file || (!/[\\/]/.test(file) && !/\.[\w-]+$/.test(file))) continue;
    results.push({ path: file, line: location ? Number(location[1]) : undefined, column: location?.[2] ? Number(location[2]) : undefined, start: match.index! + leading, end: match.index! + leading + token.length });
    if (results.length >= 32) break;
  }
  return results;
}

/** Orca-style logical-line reconstruction and cell ranges, including wide characters. */
export function registerTerminalFileLinks(terminal: Terminal, activate: (link: TerminalFileLink) => void, hint: string) {
  if (typeof (terminal as Terminal & { registerLinkProvider?: unknown }).registerLinkProvider !== 'function') {
    return { dispose: () => undefined };
  }
  return terminal.registerLinkProvider({ provideLinks(lineNumber, callback) {
    const buffer = terminal.buffer.active;
    let start = lineNumber - 1;
    while (start > 0 && buffer.getLine(start)?.isWrapped && lineNumber - start < 32) start--;
    let text = '';
    const cells: Array<{ x: number; y: number }> = [];
    for (let row = start; row < buffer.length && row < start + 32; row++) {
      if (row > start && !buffer.getLine(row)?.isWrapped) break;
      const line = buffer.getLine(row);
      if (!line) break;
      for (let col = 0; col < line.length; col++) {
        const cell = line.getCell(col);
        if (!cell || cell.getWidth() === 0) continue;
        const chars = cell.getChars() || ' ';
        for (let i = 0; i < chars.length; i++) cells.push({ x: col + 1, y: row + 1 });
        text += chars;
      }
    }
    const links: ILink[] = terminalFileLinks(text).flatMap(link => {
      const first = cells[link.start], last = cells[link.end - 1];
      if (!first || !last || lineNumber < first.y || lineNumber > last.y) return [];
      return [{ text: link.path, range: { start: first, end: last },
        hover: () => { if (terminal.element) terminal.element.title = hint; },
        leave: () => { if (terminal.element) terminal.element.title = ''; },
        activate: (event: MouseEvent) => {
          const mac = /Mac/.test(navigator.platform);
          if (!(mac ? event.metaKey : event.ctrlKey) || event.button !== 0 || terminal.hasSelection()) return;
          event.preventDefault(); activate(link);
        } }];
    });
    callback(links);
  } });
}
