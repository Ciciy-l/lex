/**
 * Build-pinned agent runtime transport metadata.
 *
 * Lex app updates have release/beta/canary channels, while managed CLI
 * runtimes are version-pinned build dependencies. Keeping this snapshot in
 * the package lets a clean install download audited Cindy CDN assets without
 * first resolving a Lex app-update manifest.
 */
import runtimeAssets from '../../../../../config/lex-agent-runtime-assets.json';

import type { Manifest } from '../manifestService.js';

type RuntimeAssetFields = Omit<Manifest, 'app'>;

interface RuntimeAssetSnapshot {
  schemaVersion: number;
  cdnBaseUrl: string;
  platforms: Record<string, RuntimeAssetFields | undefined>;
}

const snapshot = runtimeAssets as RuntimeAssetSnapshot;

function cloneRuntimeAssets(assets: RuntimeAssetFields): RuntimeAssetFields {
  return JSON.parse(JSON.stringify(assets)) as RuntimeAssetFields;
}

/** Return a detached manifest-shaped view for the active packaged platform. */
export function getRuntimeManifest(platformKey = `${process.platform}-${process.arch}`): Manifest | null {
  const assets = snapshot.platforms[platformKey];
  if (!assets) return null;
  return { app: { version: '0.0.0-runtime-assets' }, ...cloneRuntimeAssets(assets) };
}

/** Runtime files stay on Cindy's mirrored CDN, independently of Lex channels. */
export function getRuntimeAssetBaseUrl(): string {
  return snapshot.cdnBaseUrl.replace(/\/+$/, '');
}
