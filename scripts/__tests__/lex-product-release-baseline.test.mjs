import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

test('Lex product URLs remain independent from Cindy account service realms', () => {
  const product = readJson('config/lex-product.json');
  assert.equal(product.homepageUrl, 'https://ciciy-l.github.io/lex/');
  assert.equal(product.downloadPageUrl, 'https://github.com/Ciciy-l/lex/releases');
  assert.equal(product.supportUrl, 'https://github.com/Ciciy-l/lex/issues');
  assert.equal(
    product.updateManifestBaseUrl,
    'https://raw.githubusercontent.com/Ciciy-l/lex/updates',
  );
});

test('release workflows keep one package while choosing signed or versioned unsigned output', () => {
  const release = readText('.github/workflows/desktop-release.yml');
  const preview = readText('.github/workflows/desktop-preview.yml');
  const updates = readText('.github/workflows/lex-updates.yml');
  const packaging = readText('apps/desktop/scripts/package-desktop.mjs');
  const upstream = readText('.github/workflows/upstream-sync.yml');
  const ci = readText('.github/workflows/ci.yml');
  const releaseWorkflow = YAML.parse(release);
  const previewWorkflow = YAML.parse(preview);

  assert.match(release, /--region global/);
  assert.doesNotMatch(release, /--region cn/);
  assert.match(release, /selected=signed/);
  assert.match(release, /selected=unsigned/);
  assert.match(release, /--no-sign\s+\\?\s*--allow-unsigned/);
  assert.match(release, /permissions:\n  contents: read/);
  assert.match(release, /publish:[\s\S]*?permissions:\n      contents: write/);
  assert.match(release, /merge-base --is-ancestor "\$release_commit" origin\/main/);
  assert.match(release, /Package signed Windows desktop[\s\S]*?CINDY_WIN_SIGN_CMD/);
  assert.doesNotMatch(
    release.match(/Package signed Windows desktop[\s\S]*?Package signed macOS desktop/)?.[0] ?? '',
    /APPLE_(?:ID|TEAM_ID|SIGN_IDENTITY|APP_PASSWORD)/,
  );
  assert.match(release, /Package signed macOS desktop[\s\S]*?APPLE_ID/);
  assert.doesNotMatch(
    release.match(/Package signed macOS desktop[\s\S]*?Package signed Linux desktop/)?.[0] ?? '',
    /CINDY_WIN_SIGN_CMD/,
  );
  assert.match(release, /The package keeps its SemVer, GitHub Release, and update manifest/);
  assert.match(preview, /--no-sign/);
  assert.match(
    release,
    /pnpm check:dco -- --base "\$\{GITHUB_SHA\}\^1" --head "\$GITHUB_SHA"/,
  );
  assert.match(preview, /pnpm check:dco -- --base origin\/main --head "\$GITHUB_SHA"/);
  assert.match(release, /--upstream-baseline abcf92c2b34e99209e505662a3fe4e11868e8aa1/);
  assert.doesNotMatch(preview, /--upstream-baseline/);
  assert.doesNotMatch(`${release}\n${preview}`, /^\s*pnpm check:dco\s*$/m);
  for (const [name, workflow] of [
    ['release', releaseWorkflow],
    ['preview', previewWorkflow],
  ]) {
    assert.equal(workflow.jobs.quality.env.ELECTRON_SKIP_BINARY_DOWNLOAD, '1', name);
    assert.equal(
      workflow.jobs.quality.env.ELECTRON_OVERRIDE_DIST_PATH,
      '${{ github.workspace }}/.electron-stub-dist',
      name,
    );
    assert.equal(workflow.env?.ELECTRON_SKIP_BINARY_DOWNLOAD, undefined, name);
    assert.equal(workflow.jobs.package.env?.ELECTRON_SKIP_BINARY_DOWNLOAD, undefined, name);

    const packageSteps = workflow.jobs.package.steps;
    const linuxDependencies = packageSteps.find(
      (step) => step.name === 'Install Linux packaging dependencies',
    );
    const virtualDisplay = packageSteps.find(
      (step) => step.name === 'Start Linux virtual display',
    );
    assert.ok(linuxDependencies, `${name} Linux packaging dependencies step`);
    assert.equal(linuxDependencies.if, "matrix.system == 'linux'", name);
    assert.match(linuxDependencies.run, /\bxvfb\b/, name);
    assert.match(linuxDependencies.run, /\bx11-utils\b/, name);
    assert.ok(virtualDisplay, `${name} Linux virtual display step`);
    assert.equal(virtualDisplay.if, "matrix.system == 'linux'", name);
    assert.match(virtualDisplay.run, /Xvfb :99/, name);
    assert.match(virtualDisplay.run, /xdpyinfo -display :99/, name);
    assert.match(virtualDisplay.run, /DISPLAY=:99.*GITHUB_ENV/, name);
  }
  assert.match(updates, /release:\n\s+types: \[published\]/);
  assert.match(updates, /isDraft == false/);
  assert.match(updates, /Windows-x64-Auto-Update/);
  assert.match(updates, /macOS-\{public_arch\}-Auto-Update/);
  assert.match(updates, /Linux-x64/);
  assert.match(updates, /\{arch\}-hotfix/);
  assert.match(packaging, /Lex-<version\|Preview>-Windows-x64-Setup\.exe/);
  assert.match(packaging, /Creating unsigned DMG around ad-hoc signed app/);
  assert.match(release, /basename "\$file"/);
  assert.match(release, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(release, /actions\/download-artifact@[0-9a-f]{40}/);
  assert.match(preview, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.doesNotMatch(`${release}\n${preview}`, /actions\/(?:upload|download)-artifact@v\d/);
  assert.doesNotMatch(release, /\(\$\{SIGNING_MODE\}, draft\)/);
  assert.match(upstream, /merge-base --is-ancestor cindy-upstream\/main origin\/main/);
  assert.match(upstream, /gh workflow run ci\.yml.*--ref main.*checkout_ref=/);
  assert.match(ci, /checkout_ref:/);
  assert.match(ci, /ref: \$\{\{ inputs\.checkout_ref \|\| github\.sha \}\}/);
});

test('Lex agent runtime snapshot is pinned, complete, and platform-safe', () => {
  const snapshot = readJson('config/lex-agent-runtime-assets.json');
  const pins = {
    claudeCode: readJson('tools/claude/latest.json'),
    codex: readJson('tools/codex/latest.json'),
    codexPackage: readJson('tools/codex-package/latest.json'),
    pi: readJson('tools/pi/latest.json'),
  };
  const directories = {
    claudeCode: 'claude-code',
    codex: 'codex',
    codexPackage: 'codex-package',
    pi: 'pi',
  };

  assert.equal(snapshot.schemaVersion, 1);
  assert.match(snapshot.cdnBaseUrl, /^https:\/\/[^\s/]+(?:\/[^\s/]+)*$/);
  assert.ok(!snapshot.cdnBaseUrl.endsWith('/'));
  assert.deepEqual(Object.keys(snapshot.platforms).sort(), [
    'darwin-arm64',
    'darwin-x64',
    'linux-x64',
    'win32-x64',
  ]);

  for (const [platform, assets] of Object.entries(snapshot.platforms)) {
    for (const field of ['claudeCode', 'codex', 'codexPackage', 'pi']) {
      const value = assets[field];
      assert.ok(value && typeof value === 'object', `${platform}/${field}`);
      assert.equal(value.version, pins[field].version, `${platform}/${field} version`);
      assert.equal(
        value.file.startsWith(`${directories[field]}/${value.version}/${platform}/`),
        true,
        `${platform}/${field} file`,
      );
      assert.equal(value.file.includes('..'), false, `${platform}/${field} traversal`);
      assert.equal(value.file.includes('\\'), false, `${platform}/${field} separator`);
      assert.equal(value.file.includes('://'), false, `${platform}/${field} relative path`);
      assert.match(value.sha256, /^[a-f0-9]{64}$/i, `${platform}/${field} sha256`);
      assert.equal(Number.isSafeInteger(value.size) && value.size > 0, true, `${platform}/${field} size`);
      if (value.binarySha256 !== undefined) {
        assert.match(value.binarySha256, /^[a-f0-9]{64}$/i, `${platform}/${field} binarySha256`);
      }
    }
    assert.equal(
      assets.claudeCode.binarySha256,
      pins.claudeCode.runtimeAssets[platform].sha256,
      `${platform}/claudeCode upstream binary digest`,
    );
  }
});

test('Lex update publishing projects the tag-pinned runtime snapshot without network drift', () => {
  const updates = readText('.github/workflows/lex-updates.yml');
  const factory = readText('apps/desktop/src/main/agent-binaries/factory.ts');
  const binaries = readText('apps/desktop/src/main/agent-binaries/index.ts');

  assert.match(updates, /config\/lex-agent-runtime-assets\.json/);
  assert.match(updates, /runtime_snapshot\.get\('cdnBaseUrl'/);
  assert.match(updates, /runtime_snapshot\.get\('platforms'/);
  assert.match(updates, /payload\.update\(runtime_assets\(platform\)\)/);
  assert.match(updates, /manifest_suffixes = \[suffix\] if suffix else \['', '-beta'\]/);
  assert.match(updates, /for output_suffix in manifest_suffixes/);
  assert.match(updates, /RC installs can graduate/);
  assert.match(updates, /'claudeCode', 'codex', 'codexPackage', 'ripgrep', 'pi'/);
  assert.doesNotMatch(updates, /urllib\.request|urlopen\(|CINDY_VENDOR_CDN_BASE/);

  for (const source of [factory, binaries]) {
    assert.match(source, /getRuntimeManifest/);
    assert.doesNotMatch(source, /fetchManifest|getCachedManifest|getBaseUrl/);
  }
});

test('packaging metadata uses the Lex display name while Cindy remains the service brand', () => {
  const forge = readText('apps/desktop/forge.config.ts');
  const loginBrand = readText('apps/desktop/src/renderer/components/login/LoginBrandStage.tsx');
  assert.match(
    forge,
    /new MakerNSIS\(\{[\s\S]*?getAppBuilderConfig: async \(\) => \(\{[\s\S]*?publish: null,/,
  );
  assert.match(forge, /ProductName: BRAND_IDENTITY\.displayName/);
  assert.match(forge, /mac display name → \$\{displayName\}/);
  assert.doesNotMatch(forge, /ProductName: ['"]Cindy['"]/);
  assert.doesNotMatch(forge, /Set :\$\{key\} Cindy/);
  assert.match(loginBrand, /lex-wordmark\.svg/);
  assert.match(loginBrand, /lex-wordmark-dark\.svg/);
  assert.doesNotMatch(loginBrand, /assets\/login\/wordmark(?:-dark)?(?:@2x)?\.png/);
});

test('Lex updater package and binary entry keep the same Rust crate identity', () => {
  const cargo = readText('apps/desktop/cindy-updater/src-tauri/Cargo.toml');
  const main = readText('apps/desktop/cindy-updater/src-tauri/src/main.rs');
  const packageSection = cargo.match(/\[package\]([\s\S]*?)(?=\n\[|$)/)?.[1] ?? '';
  const packageName = packageSection.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];

  assert.equal(packageName, 'lex-updater');
  assert.match(main, new RegExp(`\\b${packageName.replaceAll('-', '_')}::run\\(\\);`));
  assert.doesNotMatch(main, /\bcindy_updater::/);
});

test('GitHub Pages workflow and self-contained website form a valid download surface', () => {
  for (const workflowPath of [
    '.github/workflows/pages.yml',
    '.github/workflows/desktop-preview.yml',
    '.github/workflows/desktop-release.yml',
    '.github/workflows/lex-updates.yml',
  ]) {
    const workflow = YAML.parse(readText(workflowPath));
    assert.ok(workflow && typeof workflow === 'object' && workflow.jobs, `${workflowPath} jobs`);
  }

  const html = readText('website/index.html');
  const pages = readText('.github/workflows/pages.yml');
  const pagesWorkflow = YAML.parse(pages);
  assert.equal(pagesWorkflow.on.release, undefined);
  assert.deepEqual(pagesWorkflow.on.workflow_run, {
    workflows: ['publish-lex-update-manifests'],
    types: ['completed'],
  });
  assert.equal(
    pagesWorkflow.jobs.deploy.if,
    "github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success'",
  );
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /@media\(max-width:760px\)/);
  assert.match(html, /fetch\('\.\/release\.json'/);
  assert.match(html, /github\.com\/Ciciy-l\/lex\/releases/);
  assert.match(html, /platform==='mac'\?null/);
  assert.match(html, /Windows-x64/);
  assert.match(html, /Linux-x64/);
  assert.match(html, /TapDB analytics disabled by default/);
  assert.match(pages, /select\(\.draft == false and \.published_at != null\)/);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+stylesheet/i);

  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => Function(scripts[0][1]));
});

test('all third-party GitHub Actions are pinned to complete commit SHAs', () => {
  const workflowDir = path.join(ROOT, '.github', 'workflows');
  for (const entry of fs.readdirSync(workflowDir)) {
    if (!/\.ya?ml$/.test(entry)) continue;
    const source = readText(path.join('.github', 'workflows', entry));
    for (const match of source.matchAll(/^\s*uses:\s*([^\s#]+)/gm)) {
      const action = match[1];
      if (action.startsWith('./')) continue;
      assert.match(action, /^[^@]+@[0-9a-f]{40}$/, `${entry}: ${action}`);
    }
  }
});
