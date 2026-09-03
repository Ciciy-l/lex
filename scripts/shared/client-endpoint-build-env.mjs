/**
 * 客户端构建期端点自举配置。
 *
 * 运行期业务端点的唯一事实源是 region 对应的 config/endpoint*.json；构建期烘焙
 * region 与 CN/Global 两份 Cindy 服务清单的 CDN 基址。Lex 应用更新清单从
 * config/lex-product.json 独立读取，账号服务区切换绝不能改变更新通道。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLIENT_BUILD_REGIONS = Object.freeze(['cn', 'global', 'dev']);

const LEX_PRODUCT_URL_FIELDS = Object.freeze([
  'homepageUrl',
  'downloadPageUrl',
  'supportUrl',
  'updateManifestBaseUrl',
]);

/**
 * Lex 产品级公开地址。它们属于 Lex 自己的发行与支持面，不得从 Cindy 账号
 * 服务区清单推导；否则用户切换 CN / Global 账号会连带切错应用更新或下载入口。
 */
export function loadLexProductConfig(repoRoot = REPO_ROOT) {
  const configPath = path.join(repoRoot, 'config', 'lex-product.json');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(`缺少 Lex 产品配置: ${configPath}`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Lex 产品配置不是合法 JSON: ${configPath}`);
    }
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Lex 产品配置必须是 JSON object: ${configPath}`);
  }
  if (!Number.isInteger(parsed.schemaVersion) || parsed.schemaVersion < 1) {
    throw new Error(`Lex 产品配置 schemaVersion 非法: ${configPath}`);
  }

  const result = { schemaVersion: parsed.schemaVersion };
  for (const field of LEX_PRODUCT_URL_FIELDS) {
    const raw = parsed[field];
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new Error(`Lex 产品配置缺少非空字段 ${field}: ${configPath}`);
    }
    const normalized = raw.trim();
    let url;
    try {
      url = new URL(normalized);
    } catch {
      throw new Error(`Lex 产品配置字段 ${field} 不是合法绝对 URL: ${configPath}`);
    }
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new Error(`Lex 产品配置字段 ${field} 必须是无凭据 HTTPS URL: ${configPath}`);
    }
    result[field] =
      field === 'updateManifestBaseUrl' ? normalized.replace(/\/+$/, '') : normalized;
  }
  return Object.freeze(result);
}

/** Lex owns one update channel, independent from the Cindy account service realm. */
export function loadLexUpdateManifestBaseUrl(repoRoot = REPO_ROOT) {
  return loadLexProductConfig(repoRoot).updateManifestBaseUrl;
}

/** 规范化并校验构建 region。 */
export function resolveClientBuildRegion(authRegion) {
  const region = authRegion?.trim() || 'global';
  if (!CLIENT_BUILD_REGIONS.includes(region)) {
    throw new Error(`Invalid Cindy auth region: ${region}; expected cn, global or dev`);
  }
  return region;
}

/** 返回 region 对应的仓内端点清单正本路径。 */
export function clientEndpointManifestPath(authRegion, repoRoot = REPO_ROOT) {
  const region = resolveClientBuildRegion(authRegion);
  const fileByRegion = { cn: 'endpoint.json', global: 'endpoint.global.json', dev: 'endpoint.dev.json' };
  return path.join(repoRoot, 'config', fileByRegion[region]);
}

/**
 * 从仓内端点清单读取不可自引用覆盖的 CDN 自举基址。
 * @param {{ authRegion?: string, repoRoot?: string }} [options]
 */
export function loadEndpointManifestBaseUrl(options = {}) {
  const region = resolveClientBuildRegion(options.authRegion);
  const manifestPath = clientEndpointManifestPath(region, options.repoRoot);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(`缺少 ${region} 客户端端点清单: ${manifestPath}`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`客户端端点清单不是合法 JSON: ${manifestPath}`);
    }
    throw error;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`客户端端点清单必须是 JSON object: ${manifestPath}`);
  }
  if (!Number.isInteger(parsed.schemaVersion) || parsed.schemaVersion < 1) {
    throw new Error(`客户端端点清单 schemaVersion 非法: ${manifestPath}`);
  }

  const raw = parsed.cdnBaseUrl;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(`客户端端点清单缺少非空字段 cdnBaseUrl: ${manifestPath}`);
  }
  const normalized = raw.trim().replace(/\/+$/, '');
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`客户端端点清单字段 cdnBaseUrl 不是合法绝对 URL: ${manifestPath}`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`客户端端点清单字段 cdnBaseUrl 必须是无凭据 HTTPS URL: ${manifestPath}`);
  }
  return normalized;
}

/**
 * 返回当前构建区域之外的另一份受信任清单基址。CN/Global 互为对端；
 * dev 以 CN 身份运行，仍只把 Global 作为对端。
 */
export function loadPeerEndpointManifestBaseUrl(options = {}) {
  const region = resolveClientBuildRegion(options.authRegion);
  return loadEndpointManifestBaseUrl({
    authRegion: region === 'global' ? 'cn' : 'global',
    repoRoot: options.repoRoot,
  });
}

/** Desktop 正式构建所需的公开 Vite 变量。 */
export function desktopClientBuildEnv({ allowEnvOverride = true, authRegion, repoRoot } = {}) {
  const region = resolveClientBuildRegion(
    authRegion ||
      process.env.CINDY_AUTH_REGION?.trim() ||
      (allowEnvOverride ? process.env.VITE_CINDY_AUTH_REGION?.trim() : ''),
  );
  const override = allowEnvOverride
    ? process.env.VITE_ENDPOINT_MANIFEST_BASE_URL?.trim()
    : '';
  const peerOverride = allowEnvOverride
    ? process.env.VITE_ENDPOINT_MANIFEST_PEER_BASE_URL?.trim()
    : '';
  const lexProduct = loadLexProductConfig(repoRoot);
  return {
    VITE_CINDY_AUTH_REGION: region,
    VITE_LEX_HOMEPAGE_URL: lexProduct.homepageUrl,
    VITE_LEX_DOWNLOAD_PAGE_URL: lexProduct.downloadPageUrl,
    VITE_LEX_SUPPORT_URL: lexProduct.supportUrl,
    VITE_LEX_UPDATE_MANIFEST_BASE_URL: lexProduct.updateManifestBaseUrl,
    VITE_ENDPOINT_MANIFEST_BASE_URL:
      override || loadEndpointManifestBaseUrl({ authRegion: region, repoRoot }),
    VITE_ENDPOINT_MANIFEST_PEER_BASE_URL:
      peerOverride || loadPeerEndpointManifestBaseUrl({ authRegion: region, repoRoot }),
  };
}

/** Mobile/EAS 构建所需的公开变量。 */
export function mobileClientBuildEnv({ authRegion, repoRoot } = {}) {
  const region = resolveClientBuildRegion(
    authRegion || process.env.EXPO_PUBLIC_CINDY_AUTH_REGION?.trim(),
  );
  return {
    EXPO_PUBLIC_CINDY_AUTH_REGION: region,
    EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL: loadEndpointManifestBaseUrl({
      authRegion: region,
      repoRoot,
    }),
  };
}

/**
 * Mobile JS bundle 额外需要对端区域清单基址；CindyDev 还需要 CN Release
 * 清单基址供内部运行时切换。与 mobileClientBuildEnv 分开，避免把这些纯 JS
 * 变量加入 app.config 的既有 Expo extra / runtime fingerprint。
 */
export function mobileClientBundleEnv(options = {}) {
  const buildEnv = mobileClientBuildEnv(options);
  const authRegion = buildEnv.EXPO_PUBLIC_CINDY_AUTH_REGION;
  return {
    ...buildEnv,
    EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL: loadPeerEndpointManifestBaseUrl({
      authRegion,
      repoRoot: options.repoRoot,
    }),
    ...(authRegion === 'dev'
      ? {
          EXPO_PUBLIC_CINDY_DEV_RELEASE_ENDPOINT_MANIFEST_BASE_URL:
            loadEndpointManifestBaseUrl({
              authRegion: 'cn',
              repoRoot: options.repoRoot,
            }),
        }
      : {}),
  };
}

/**
 * 合并最终传给 Mobile bundling 子进程的环境。正式构建必须主动删除 runner
 * 可能残留的 CindyDev Release 清单变量，不能只依赖 app.config.js 在子进程内清理。
 */
export function mobileClientBundleProcessEnv({
  authRegion,
  baseEnv = process.env,
  repoRoot,
} = {}) {
  const bundleEnv = mobileClientBundleEnv({ authRegion, repoRoot });
  const env = { ...baseEnv, ...bundleEnv };
  if (bundleEnv.EXPO_PUBLIC_CINDY_AUTH_REGION !== 'dev') {
    delete env.EXPO_PUBLIC_CINDY_DEV_RELEASE_ENDPOINT_MANIFEST_BASE_URL;
  }
  return env;
}
