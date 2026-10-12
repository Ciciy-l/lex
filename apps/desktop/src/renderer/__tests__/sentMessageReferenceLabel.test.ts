import { describe, expect, it } from 'vitest';
import { sentMessageReferenceLabel } from '@/lib/sentMessageReferenceLabel';

describe('sent message reference summaries', () => {
  it('keeps readable content without Markdown or image destinations', () => {
    expect(sentMessageReferenceLabel('**Result**\n\n![Preview](cindy-media://blobs/abc)')).toBe('Result Preview');
    expect(sentMessageReferenceLabel('**![](cindy-media://blobs/abc)**')).toBe('');
    expect(sentMessageReferenceLabel(`Before <img src='https://example.com/image.png'> tail`)).toBe('Before tail');
    expect(sentMessageReferenceLabel('cindy-media://blobs/abc')).toBe('');
    expect(sentMessageReferenceLabel('[Report](https://example.com/report)')).toBe('Report');
  });

  it('preserves a whole emoji cluster at the truncation boundary', () => {
    const family = '👨‍👩‍👧';
    expect(sentMessageReferenceLabel(`${'a'.repeat(238)}${family}bb`)).toBe(`${'a'.repeat(238)}${family}…`);
  });

  it('cuts long logs at complete lines and keeps long image syntax intact', () => {
    expect(sentMessageReferenceLabel(`**Result**\n${'log line\n'.repeat(20000)}`)).toMatch(/^Result log line/);
    expect(sentMessageReferenceLabel(`![](https://example.com/${'x'.repeat(3000)}.png)\nDone`)).toBe('');
  });
});
