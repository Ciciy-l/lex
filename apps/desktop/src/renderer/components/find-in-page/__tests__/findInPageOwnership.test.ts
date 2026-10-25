import { describe, expect, it } from 'vitest';
import { acquireFindInPage, isFindInPageClaimed } from '../findInPageOwnership';

describe('find ownership', () => {
  it('keeps independent unconditional owners compatible with idempotent cleanup', () => {
    const first = acquireFindInPage(), second = acquireFindInPage();
    try {
      first(); first();
      expect(isFindInPageClaimed()).toBe(true);
      second();
      expect(isFindInPageClaimed()).toBe(false);
    } finally { first(); second(); }
  });

  it('checks live scope without relying on focus or DOM mutation events', () => {
    let focused = true;
    const release = acquireFindInPage(() => focused);
    try {
      expect(isFindInPageClaimed()).toBe(true);
      focused = false;
      expect(isFindInPageClaimed()).toBe(false);
      focused = true;
      expect(isFindInPageClaimed()).toBe(true);
      release();
      expect(isFindInPageClaimed()).toBe(false);
    } finally { release(); }
  });

  it('does not let an inactive scope release a different owner', () => {
    const scoped = acquireFindInPage(() => false), other = acquireFindInPage();
    try {
      expect(isFindInPageClaimed()).toBe(true);
      scoped(); scoped();
      expect(isFindInPageClaimed()).toBe(true);
      other();
      expect(isFindInPageClaimed()).toBe(false);
    } finally { scoped(); other(); }
  });
});
