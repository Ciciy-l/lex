import { markdownPreviewText } from '../../shared/markdownPreviewText';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Sent references only: composer labels and persisted message text stay unchanged. */
export function sentMessageReferenceLabel(text: string): string {
  // Keep complete Markdown lines so a cut cannot expose half an image destination.
  const end = text.length > 2000 ? text.indexOf('\n', 2000) : -1;
  const plain = markdownPreviewText(end < 0 ? text : text.slice(0, end))
    .replace(/\b(?:cindy-media|xdt-[a-z0-9-]+):\/\/\S*/gi, '')
    .replace(/\s+/g, ' ').trim();
  const characters: string[] = [];
  for (const { segment } of segmenter.segment(plain)) {
    if (characters.length === 240) return `${characters.slice(0, 239).join('').trimEnd()}…`;
    characters.push(segment);
  }
  return characters.join('');
}
