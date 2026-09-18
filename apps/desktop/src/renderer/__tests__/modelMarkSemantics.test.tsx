// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AnthropicMark } from '@/components/icons/AnthropicMark';
import { ClaudeMark } from '@/components/icons/ClaudeMark';
import { CodexMark } from '@/components/icons/CodexMark';
import { OmpMark } from '@/components/icons/OmpMark';
import { OpenAIMark } from '@/components/icons/OpenAIMark';
import { ProviderLogoMark } from '@/components/icons/ProviderLogoMark';
import { ModelIconMark, ProviderMark } from '@/components/new-chat/ModelSelector';

function firstPath(ui: React.ReactNode): string | null {
  return render(ui).container.querySelector('path')?.getAttribute('d') ?? null;
}

describe('model mark semantics', () => {
  it('keeps the model-vendor marks monochrome and preserves the size/className API', () => {
    const anthropic = render(<AnthropicMark size={18} className="brand-mark" />);
    const anthropicSvg = anthropic.container.querySelector('svg');
    expect(anthropicSvg?.getAttribute('width')).toBe('18');
    expect(anthropicSvg?.getAttribute('height')).toBe('18');
    expect(anthropicSvg?.getAttribute('class')).toBe('brand-mark');
    expect(anthropic.container.querySelector('path')?.getAttribute('fill')).toBe('currentColor');

    const openai = render(<OpenAIMark size={16} className="brand-mark" />);
    expect(openai.container.querySelector('svg')?.getAttribute('width')).toBe('16');
    expect(openai.container.querySelector('path')?.getAttribute('fill')).toBe('currentColor');
  });

  it('uses vendor marks for provider/model metadata and keeps Agent glyphs distinct', () => {
    const anthropicPath = firstPath(<AnthropicMark />);
    const openaiPath = firstPath(<OpenAIMark />);

    expect(firstPath(<ProviderMark providerId="anthropic" />)).toBe(anthropicPath);
    expect(firstPath(<ProviderMark providerId="openai" />)).toBe(openaiPath);
    expect(firstPath(<ProviderMark providerId="xai" />)).toBe(
      firstPath(<ProviderLogoMark providerId="xai" />),
    );
    expect(
      firstPath(<ProviderMark providerId="renamed-kimi" name="My Kimi" logoKind="moonshot" />),
    ).toBe(firstPath(<ProviderLogoMark providerId="renamed-kimi" logoKind="moonshot" />));
    const unknownLogo = render(
      <ProviderMark
        providerId="future-provider"
        name="My Provider"
        logoKind={'future-brand' as never}
      />,
    );
    expect(unknownLogo.container.querySelector('svg')).toBeNull();
    expect(unknownLogo.container.textContent).toBe('M');
    expect(firstPath(<ModelIconMark icon="claude" providerId="xd" />)).toBe(anthropicPath);
    expect(firstPath(<ModelIconMark icon="openai" providerId="xd" />)).toBe(openaiPath);

    expect(firstPath(<ClaudeMark />)).not.toBe(anthropicPath);
    expect(firstPath(<CodexMark />)).not.toBe(openaiPath);
  });

  it('optically strengthens the mono Codex glyph and adapts its sidebar stroke weight', () => {
    const small = render(<CodexMark size={12} />);
    const smallGroup = small.container.querySelector('g');
    const smallPaths = small.container.querySelectorAll('path');
    expect(smallGroup?.getAttribute('transform')).toBe(
      'translate(12 12) scale(1.1) translate(-12 -12)',
    );
    expect(smallPaths[0]?.getAttribute('stroke-width')).toBe('2');
    expect(smallPaths[1]?.getAttribute('fill')).toBe('currentColor');
    expect(smallPaths[1]?.getAttribute('stroke')).toBe('currentColor');
    expect(smallPaths[1]?.getAttribute('stroke-width')).toBe('0.5');

    const large = render(<CodexMark size={16} />);
    expect(large.container.querySelector('path')?.getAttribute('stroke-width')).toBe('1.6');

    const brand = render(<CodexMark size={12} variant="brand" />);
    expect(brand.container.querySelector('g')).toBeNull();
    expect(brand.container.querySelector('path')?.hasAttribute('stroke')).toBe(false);
  });

  it('keeps OMPs official mark themeable and isolates its optional brand gradient', () => {
    const mono = render(<OmpMark size={12} className="omp-mark" />);
    const monoSvg = mono.container.querySelector('svg');
    const monoPath = mono.container.querySelector('path');
    expect(monoSvg?.getAttribute('width')).toBe('12');
    expect(monoSvg?.getAttribute('height')).toBe('12');
    expect(monoSvg?.getAttribute('class')).toBe('omp-mark');
    expect(monoSvg?.getAttribute('viewBox')).toBe('0 0 64 64');
    expect(monoPath?.getAttribute('d')).toBe('M10 14h44v9H43v33h-9V23h-9v22h-9V23H10z');
    expect(monoPath?.getAttribute('fill')).toBe('currentColor');
    expect(mono.container.querySelector('defs')).toBeNull();

    const firstBrand = render(<OmpMark variant="brand" />);
    const secondBrand = render(<OmpMark variant="brand" />);
    const firstGradient = firstBrand.container.querySelector('linearGradient');
    const secondGradient = secondBrand.container.querySelector('linearGradient');
    const firstId = firstGradient?.getAttribute('id');
    const secondId = secondGradient?.getAttribute('id');

    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    expect(firstId).not.toBe(secondId);
    expect(firstBrand.container.querySelector('path')?.getAttribute('fill')).toBe(`url(#${firstId})`);
    expect(
      [...firstBrand.container.querySelectorAll('stop')].map((stop) => stop.getAttribute('stop-color')),
    ).toEqual([
      'oklch(0.7 0.24 340)',
      'oklch(0.62 0.21 295)',
      'oklch(0.81 0.14 200)',
    ]);
  });
});
