import { describe, expect, it } from 'vitest';
import hostSystemPrompt from '../host-system-prompt.md?raw';

describe('Lex host identity', () => {
  it('identifies as Lex while retaining Cindy attribution and services', () => {
    expect(hostSystemPrompt).toMatch(/^You are Lex,/);
    expect(hostSystemPrompt).toContain('based on Cindy');
    expect(hostSystemPrompt).toContain('https://github.com/Ciciy-l/lex');
    expect(hostSystemPrompt).toContain('https://github.com/makecindy/cindy');
    expect(hostSystemPrompt).toContain('Cindy accounts, subscriptions, and remote services');
    expect(hostSystemPrompt).not.toContain('You are Cindy');
  });
});
