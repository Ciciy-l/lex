import { describe, expect, it, vi } from 'vitest';
import type { Maker } from '@cindy/maker-core';

import { createDynamicMaker } from '../dynamic-maker.js';



describe('createDynamicMaker', () => {
  it('routes an already captured method to the current Maker instance', () => {
    const first = { listAvailableAgents: vi.fn(() => ['first']) };
    const second = { listAvailableAgents: vi.fn(() => ['second']) };
    let current = first;
    const facade = createDynamicMaker(() => current as unknown as Maker);
    const captured = facade.listAvailableAgents;

    expect(captured()).toEqual(['first']);
    current = second;
    expect(captured()).toEqual(['second']);
    expect(first.listAvailableAgents).toHaveBeenCalledTimes(1);
    expect(second.listAvailableAgents).toHaveBeenCalledTimes(1);
  });

  it('reads non-function properties from the current Maker instance', () => {
    const first = { makerMemory: { owner: 'first' } };
    const second = { makerMemory: { owner: 'second' } };
    let current = first;
    const facade = createDynamicMaker(() => current as unknown as Maker);

    expect((facade.makerMemory as unknown as { owner: string }).owner).toBe('first');
    current = second;
    expect((facade.makerMemory as unknown as { owner: string }).owner).toBe('second');
  });
});
