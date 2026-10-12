// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { getUserPrompt, setUserPromptOwner, setUserPrompt, getEffectiveUserPrompt, userPromptFits } from '@/lib/userPromptStore';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  setUserPromptOwner(null);
});

describe('Harness prompt composition', () => {
  it('appends only the selected engine prompt after the common prompt', () => {
    setUserPromptOwner('owner-a');
    setUserPrompt('common'); setUserPrompt('omp only', 'omp'); setUserPrompt('codex only', 'codex');
    expect(getEffectiveUserPrompt('omp')).toBe('common\n\nomp only');
    expect(getEffectiveUserPrompt('codex')).toBe('common\n\ncodex only');
    expect(getEffectiveUserPrompt('pi')).toBe('common');
    expect(getUserPrompt('omp')).toBe('omp only');
  });
  it('keeps per-engine prompts isolated and rejects a stale owner editor', () => {
    setUserPromptOwner('owner-a'); setUserPrompt('private', 'omp');
    setUserPromptOwner('owner-b');
    expect(getEffectiveUserPrompt('omp')).toBe('');
    expect(() => setUserPrompt('stale', 'omp', 'owner-a')).toThrow('OWNER_CHANGED');
    setUserPromptOwner('owner-a'); expect(getEffectiveUserPrompt('omp')).toBe('private');
  });
  it('enforces the composed budget in both editing directions without modifying stored data', () => {
    setUserPrompt('x'.repeat(7990));
    expect(userPromptFits('omp', '12345678')).toBe(true);
    expect(() => setUserPrompt('123456789', 'omp')).toThrow('TOO_LONG');
    setUserPrompt('12345678', 'omp');
    expect(() => setUserPrompt('x'.repeat(7991))).toThrow('TOO_LONG');
    expect(getUserPrompt().length).toBe(7990);
  });
  it('reports a failed write instead of pretending to save', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(() => setUserPrompt('new')).toThrow('quota');
    expect(getUserPrompt()).toBe('');
  });
});

describe('userPromptStore legacy migration', () => {
  it('imports the legacy prompt into the first owner namespace', () => {
    localStorage.setItem('userPrompt.value', 'legacy prompt');

    setUserPromptOwner('owner-a');

    expect(getUserPrompt()).toBe('legacy prompt');
    expect(localStorage.getItem('userPrompt.value.owner-a')).toBe('legacy prompt');
    expect(localStorage.getItem('userPrompt.value')).toBeNull();
  });

  it('does not overwrite an existing owner prompt', () => {
    localStorage.setItem('userPrompt.value', 'legacy prompt');
    localStorage.setItem('userPrompt.value.owner-a', 'owner prompt');

    setUserPromptOwner('owner-a');

    expect(getUserPrompt()).toBe('owner prompt');
    expect(localStorage.getItem('userPrompt.value')).toBe('legacy prompt');
  });
});
