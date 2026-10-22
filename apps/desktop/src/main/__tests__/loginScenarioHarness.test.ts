import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import { CindyAuthClient, authServiceRealm, type AuthServiceScope } from '@cindy/auth-client';
import { resolveLoginScenarioFetch } from '@cindy/auth-client/fixtures';

/**
 * 桌面端登录 scenario harness 接线测试(implementation-plan Step 0 WHAT4 / SC-1)。
 *
 * 分两层:
 * 1. 静态 import / 构建排除守卫,以及提取真实 createAuthClient 的运行断言:
 *    依赖注入不加载 Electron,但 client、schema 与 scenario resolver 均使用真实实现。
 * 2. guard 行为断言(fixtures 包纯函数):app.isPackaged(devModeActive=false)
 *    下 harness 全部失效——production-mode 断言。
 */
const authManagerSource = readFileSync(
  resolve(process.cwd(), 'src/main/authManager.ts'),
  'utf8',
);
const viteMainConfigSource = readFileSync(
  resolve(process.cwd(), 'vite.main.config.ts'),
  'utf8',
);
const ast = ts.createSourceFile('authManager.ts', authManagerSource, ts.ScriptTarget.Latest, true);
const factory = ast.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'createAuthClient');
if (!factory) throw new Error('Missing production createAuthClient');
const factoryCode = ts.transpileModule(factory.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

/** Exercise the production injection point with an in-memory network boundary. */
function createClient(realm: AuthServiceScope, packaged = false) {
  const networkFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
    JSON.stringify({ region: authServiceRealm(realm), email: true, phone: false, social: [], attribution: 'email' }),
    { headers: { 'Content-Type': 'application/json' } },
  ));
  const resolveScenario = vi.fn(resolveLoginScenarioFetch);
  const deps = {
    CindyAuthClient, authServiceRealm, resolveLoginScenarioFetch: resolveScenario,
    app: { isPackaged: packaged }, net: { fetch: networkFetch }, deviceId: 'harness-device',
    authServerUrl: () => realm === 'cn' || realm === 'global' ? 'https://auth.scenario.invalid' : realm.slice('lex-server:'.length),
    getResolvedMainLocale: () => 'en', process: { env: { XDT_LOGIN_SCENARIO: 'providers:cn-social' } },
  };
  const build = new Function('deps', 'const {' + Object.keys(deps).join(',') + '}=deps;' + factoryCode + ';return createAuthClient;')(deps) as (scope: AuthServiceScope) => CindyAuthClient;
  return { client: build(realm), networkFetch, resolveScenario };
}

describe('authManager scenario 注入点', () => {
  it('经静态 import 使用 fixtures(main 禁运行时动态 import)', () => {
    expect(authManagerSource).toContain(
      "import { resolveLoginScenarioFetch } from '@cindy/auth-client/fixtures'",
    );
    expect(authManagerSource).not.toContain("import('@cindy/auth-client/fixtures')");
  });

  it('packaged Main disables the configured scenario and uses the real client transport', async () => {
    const harness = createClient('cn', true);
    expect((await harness.client.getProviders()).social).toEqual([]);
    expect(harness.resolveScenario).toHaveBeenCalledWith({ devModeActive: false, scenario: 'providers:cn-social', region: 'cn' });
    expect(harness.networkFetch).toHaveBeenCalledOnce();
  });

  it.each(['cn', 'global'] as const)('injects the scenario fetch into a real Cindy client for %s in development', async realm => {
    const harness = createClient(realm);
    expect((await harness.client.getProviders()).social).toEqual(['apple']);
    expect(harness.resolveScenario).toHaveBeenCalledWith({ devModeActive: true, scenario: 'providers:cn-social', region: realm });
    expect(harness.networkFetch).not.toHaveBeenCalled();
    // 不替换 client、不 fake 方法:注入点仍是唯一的 new CindyAuthClient 构造
    expect(authManagerSource.match(/new CindyAuthClient\(/g)).toHaveLength(1);
  });

  it('never injects a Cindy scenario for Lex Server and preserves its credential-free transport', async () => {
    const harness = createClient('lex-server:https://lex.scenario.invalid');
    expect((await harness.client.getProviders()).social).toEqual([]);
    expect(harness.resolveScenario).toHaveBeenCalledWith({ devModeActive: true, scenario: undefined, region: 'global' });
    expect(harness.networkFetch).toHaveBeenCalledOnce();
    expect(harness.networkFetch).toHaveBeenCalledWith('https://lex.scenario.invalid/api/auth/providers', expect.objectContaining({ method: 'GET', redirect: 'error', credentials: 'omit' }));
  });

  it('vite.main.config 挂了生产 stub alias(build-time 排除双保险)', () => {
    expect(viteMainConfigSource).toContain("mode === 'production'");
    expect(viteMainConfigSource).toContain("find: '@cindy/auth-client/fixtures'");
    expect(viteMainConfigSource).toContain('loginScenarios.production-stub.ts');
  });

  it('vite.main.config 保留显式空 Team ID,不让 .env 旧值重新启用 Touch ID', () => {
    expect(viteMainConfigSource).toContain(
      "Object.prototype.hasOwnProperty.call(process.env, key)",
    );
    expect(viteMainConfigSource).toContain(
      "readMainEnvPreservingEmpty('CINDY_WEBAUTHN_APPLE_TEAM_ID').trim()",
    );
  });
});

describe('guard 行为(production-mode 断言)', () => {
  it('app.isPackaged(devModeActive=false)→ 即使 env 设置了 scenario 也恒 null', () => {
    expect(
      resolveLoginScenarioFetch({
        devModeActive: false,
        scenario: 'providers:both',
        region: 'cn',
      }),
    ).toBeNull();
  });

  it('dev + scenario → 真实 client 全真路径可走通(zod schema 全真)', async () => {
    const scenarioFetch = resolveLoginScenarioFetch({
      devModeActive: true,
      scenario: 'providers:cn-social',
      region: 'cn',
    });
    expect(scenarioFetch).toBeTypeOf('function');
    const client = new CindyAuthClient({
      baseUrl: 'https://auth.scenario.invalid',
      region: 'cn',
      deviceId: 'harness-device',
      clientType: 'desktop',
      fetch: scenarioFetch!,
    });
    const providers = await client.getProviders();
    expect(providers.social).toEqual(['apple']);
    expect(providers.region).toBe('cn');
  });
});
