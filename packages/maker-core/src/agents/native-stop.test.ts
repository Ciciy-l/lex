import { describe, it, expect } from 'vitest';
import { AgentNativeStopBinding } from './native-stop.js';
const request = (turn = 'turn') => ({ nativeSessionId: 'native', nativeTurnId: turn, signal: new AbortController().signal });
function held() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
describe('native explicit Stop ownership', () => {
  it('rejects an old turn without stopping a new one and allows the stopped turn to disappear', async () => {
    let turn: string | null = 'turn', calls = 0;
    const binding = new AgentNativeStopBinding(() => 'native', () => true, () => turn);
    binding.bind(async () => { calls++; turn = null; });
    await expect(binding.resolve(request('old-turn'))).rejects.toThrow('turn changed');
    expect(calls).toBe(0); await binding.resolve(request()); expect(calls).toBe(1);
  });
  it('cancels retired requests and refuses duplicate concurrent Stop', async () => {
    const binding = new AgentNativeStopBinding(() => 'native', () => true, () => 'turn'), gate = held();
    let signal: AbortSignal | undefined;
    const dispose = binding.bind(async input => { signal = input.signal; await gate.promise; });
    const stopped = expect(binding.resolve(request())).rejects.toThrow('owner changed');
    await expect(binding.resolve(request())).rejects.toThrow('no available');
    dispose(); expect(signal?.aborted).toBe(true); gate.resolve(); await stopped;
    let calls = 0; binding.bind(async () => { calls++; }); dispose();
    await binding.resolve(request()); expect(calls).toBe(1);
  });
  it('does not acknowledge a failed interrupt or changed account/native session', async () => {
    let active = true, native = 'native';
    const binding = new AgentNativeStopBinding(() => native, () => active, () => 'turn');
    const release = binding.bind(async () => { throw new Error('transport failed'); });
    await expect(binding.resolve(request())).rejects.toThrow('transport failed'); release();
    binding.bind(async () => { active = false; });
    await expect(binding.resolve(request())).rejects.toThrow('owner changed');
    active = true; native = 'replaced';
    await expect(binding.resolve(request())).rejects.toThrow('owner changed');
  });
});
