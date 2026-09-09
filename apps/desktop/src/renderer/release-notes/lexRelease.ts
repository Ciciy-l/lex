export function lexReleaseUrl(version: string): string {
  return `https://github.com/Ciciy-l/lex/releases/tag/v${encodeURIComponent(version.replace(/^v/, ''))}`;
}
