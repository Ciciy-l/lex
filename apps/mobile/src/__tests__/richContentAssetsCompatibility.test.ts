import { parse } from 'acorn';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

import { MOBILE_MERMAID_JS } from '@/session/richContentAssets.generated';

function legacyWebView() {
  const context = createContext({ setTimeout, clearTimeout });
  context.window = context;
  runInContext(`
    delete Object.hasOwn;
    delete Array.prototype.at;
    delete String.prototype.at;
    delete String.prototype.replaceAll;
    delete globalThis.structuredClone;
  `, context);
  runInContext(MOBILE_MERMAID_JS, context, { timeout: 10_000 });
  return context;
}

describe('Mobile Mermaid legacy WebView compatibility', () => {
  it('keeps the shipped resource parseable as ES2019', () => {
    expect(() => parse(MOBILE_MERMAID_JS, { ecmaVersion: 2019 })).not.toThrow();
  });

  it('loads Mermaid when modern runtime APIs are missing', () => {
    const context = legacyWebView();
    expect(runInContext('typeof window.mermaid.parse', context)).toBe('function');
    expect(runInContext('typeof window.mermaid.render', context)).toBe('function');
    expect(runInContext(`
      var object = Object.create(null); object.present = undefined;
      Object.hasOwn(object, 'present') && !Object.hasOwn(object, 'toString');
    `, context)).toBe(true);
    expect(runInContext('[1,2,3].at(-1)', context)).toBe(3);
    expect(runInContext('[1,2,3].at(-4)', context)).toBeUndefined();
    expect(runInContext('[1,2,3].at(Infinity)', context)).toBeUndefined();
    expect(runInContext(`String.prototype.at.call(123, -1)`, context)).toBe('3');
    expect(runInContext(`'abc'.at(NaN)`, context)).toBe('a');
  });

  it('preserves literal, empty, regex and functional replacements', () => {
    const context = legacyWebView();
    expect(runInContext(`'a.*a'.replaceAll('.', '!')`, context)).toBe('a!*a');
    expect(runInContext(`'[]{}()$^+?|'.replaceAll('$', '$&$&')`, context)).toBe('[]{}()$$^+?|');
    expect(runInContext(`'ab'.replaceAll('', '-')`, context)).toBe('-a-b-');
    expect(runInContext(`'aba'.replaceAll(/a/g, 'x')`, context)).toBe('xbx');
    expect(runInContext(`'aba'.replaceAll('a', (match, index) => String(index))`, context)).toBe('0b2');
    expect(() => runInContext(`'aba'.replaceAll(/a/, 'x')`, context)).toThrow();
    expect(() => runInContext('String.prototype.replaceAll.call(null, "a", "b")', context)).toThrow();
  });

  it('clones graph data with cycles, dates and collections', () => {
    const context = legacyWebView();
    expect(runInContext(`
      var source = { date: new Date(0), map: new Map([['x', { value: 1 }]]), set: new Set([2]) };
      source.self = source;
      var copy = structuredClone(source);
      copy !== source && copy.self === copy && copy.date instanceof Date
        && copy.date.getTime() === 0 && copy.map.get('x') !== source.map.get('x')
        && copy.map.get('x').value === 1 && copy.set.has(2);
    `, context)).toBe(true);
    expect(() => runInContext('structuredClone({ callback: function () {} })', context)).toThrow();
  });

  it('retains available native APIs', () => {
    const context = createContext({ setTimeout, clearTimeout, structuredClone });
    context.window = context;
    runInContext(`var originals = [Object.hasOwn, Array.prototype.at, String.prototype.at, String.prototype.replaceAll, structuredClone];`, context);
    runInContext(MOBILE_MERMAID_JS, context, { timeout: 10_000 });
    expect(runInContext(`originals.every((value, index) => value === [Object.hasOwn, Array.prototype.at, String.prototype.at, String.prototype.replaceAll, structuredClone][index])`, context)).toBe(true);
  });
});
