import { readFileSync } from 'node:fs';
import { mobileClientBundleEnv } from '../../../../scripts/shared/client-endpoint-build-env.mjs';
import { withLocalMobileRegionConfig } from './mobile-dev-region.mjs';

export function extractMobileDevVariantArgs(args) {
  let lex = false;
  const passthrough = [];
  for (const arg of args) {
    if (arg === '--lex') {
      if (lex) throw new Error('--lex 只能传一次');
      lex = true;
    } else passthrough.push(arg);
  }
  return { lex, passthrough };
}

/** Same release identity/guards, with the checkout's version for a native debug app. */
export function mobileSimulatorBuildEnv(region, { lex = false, platform = process.platform } = {}) {
  const endpoints = mobileClientBundleEnv({ authRegion: region });
  if (!lex) return withLocalMobileRegionConfig(endpoints);
  if (!['win32', 'darwin'].includes(platform)) {
    throw new Error('--lex 开发包仅支持 Windows/Android 或 macOS/iOS Simulator');
  }
  const { version } = JSON.parse(readFileSync(new URL('../../../desktop/package.json', import.meta.url), 'utf8'));
  return { ...endpoints, LEX_MOBILE_BUILD: '1', LEX_MOBILE_VERSION: version };
}
