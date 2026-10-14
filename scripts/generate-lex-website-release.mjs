import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

// GitHub lists releases newest first. The website's default downloads must stay
// on a published stable release even when a newer RC or draft is present.
export function selectStableWebsiteRelease(releases) {
  const release = releases.find((candidate) =>
    candidate.draft === false && candidate.prerelease === false && candidate.published_at,
  );
  if (!release) return null;
  return {
    version: release.tag_name.replace(/^v/, ''),
    tag: release.tag_name,
    prerelease: false,
    publishedAt: release.published_at,
    releaseUrl: release.html_url,
    assets: release.assets.map((asset) => ({
      name: asset.name, url: asset.browser_download_url, size: asset.size,
    })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  const metadata = selectStableWebsiteRelease(JSON.parse(fs.readFileSync(input, 'utf8')));
  // Keep the previous deployment rather than publishing RC downloads or an
  // empty placeholder if the stable release is absent from the API response.
  if (!metadata) throw new Error('No published stable release available for the Lex website');
  fs.writeFileSync(output, JSON.stringify(metadata, null, 2) + '\n');
}
