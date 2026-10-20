/**
 * Preserve only an unfinished VT sequence for snapshot replay. xterm still owns
 * every terminal operation. Its serializer restores the screen/modes, but not
 * a parser halfway through a split CSI/OSC/DCS sequence.
 */
export class TerminalEscapeTail {
  private mode: 'text' | 'escape' | 'csi' | 'string' | 'string-escape' = 'text';
  private osc = false;
  private tail = '';
  private overflow = false;
  private surrogate = '';

  accept(data: string): void {
    this.surrogate = '';
    for (const char of data) {
      const code = char.charCodeAt(0);
      if (code === 0x18 || code === 0x1a) { this.clear(); continue; }
      if (this.mode === 'text') {
        if (code === 0x1b) { this.mode = 'escape'; this.tail = char; }
        else if (code === 0x9b) { this.mode = 'csi'; this.tail = char; }
        else if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) { this.mode = 'string'; this.osc = code === 0x9d; this.tail = char; }
        continue;
      }
      // C0 controls inside ESC/CSI have already affected the serialized screen.
      // Replaying them with the unfinished parser suffix would move it twice.
      if ((this.mode === 'escape' || this.mode === 'csi')
        && ((code < 0x20 && code !== 0x1b) || code === 0x7f)) continue;
      if (this.tail.length < 65_536) this.tail += char; else this.overflow = true;
      if (this.mode === 'string' || this.mode === 'string-escape') {
        if (code === 0x9c || (this.osc && code === 7) || (this.mode === 'string-escape' && code === 0x5c)) this.clear();
        else this.mode = code === 0x1b ? 'string-escape' : 'string';
      } else if (code === 0x1b) { this.mode = 'escape'; this.tail = char; this.overflow = false; }
      else if (this.mode === 'escape') {
        if (char === '[') this.mode = 'csi';
        else if (['P', 'X', ']', '^', '_'].includes(char)) { this.mode = 'string'; this.osc = char === ']'; }
        else if (code >= 0x30 && code <= 0x7e) this.clear();
      } else if (code >= 0x40 && code <= 0x7e) this.clear();
    }
    const last = data.charCodeAt(data.length - 1);
    if (this.mode === 'text' && last >= 0xd800 && last <= 0xdbff) this.surrogate = data.slice(-1);
  }
  pending(): string {
    if (this.overflow) throw new Error('Native terminal control sequence is not yet complete');
    return this.tail + this.surrogate;
  }
  private clear(): void { this.mode = 'text'; this.tail = ''; this.overflow = false; this.osc = false; }
}
