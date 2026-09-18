import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const sessionViewSource = readFileSync(
  fileURLToPath(new URL('../features/cc-agent/CCAgentSessionView.tsx', import.meta.url)),
  'utf8',
).replace(/\r\n?/g, '\n');

describe('pending session-agent switch auth gate', () => {
  it('checks the pending OMP target against OMP credentials before sending', () => {
    const gateStart = sessionViewSource.indexOf('// ① 本机会话维持既有 readiness gate');
    const gateEnd = sessionViewSource.indexOf('// Popover open → prevent re-entry', gateStart);
    expect(gateStart).toBeGreaterThanOrEqual(0);
    expect(gateEnd).toBeGreaterThan(gateStart);

    const gate = sessionViewSource.slice(gateStart, gateEnd);
    expect(gate).toContain('const authVendor = makerToDbAgentKind(displayAgentKind);');
    expect(gate).toContain('vendorAuthGate.checkAndConfirm(authVendor,');
  });
});
