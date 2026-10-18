/** Linear, incremental ANSI filtering for diagnostic text, not a screen model. */
export function observeTerminal(state, data) {
  let output = '';
  for (const char of data) {
    const code = char.charCodeAt(0);
    if (state.mode === 'string') {
      if (code === 7 || (state.escape && code === 0x5c)) state.mode = 'text';
      state.escape = code === 27;
    } else if (state.mode === 'csi') {
      if (code >= 0x40 && code <= 0x7e) state.mode = 'text';
    } else if (state.mode === 'escape') {
      state.mode = char === '[' ? 'csi' : [']', 'P', '^', '_'].includes(char) ? 'string' : 'text';
      state.escape = false;
    } else if (code === 27) state.mode = 'escape';
    else if (code >= 32 || char === '\n' || char === '\r' || char === '\t') output += char;
  }
  return output;
}
