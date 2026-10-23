import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CindyAuthClient } from '@cindy/auth-client';
import { resolveLoginScenarioFetch } from '@cindy/auth-client/fixtures';

/**
 * 移动端登录 scenario harness 接线测试(implementation-plan Step 0 WHAT4 / SC-1)。
 *
 * AuthContext.tsx 整模块依赖 expo/RN 运行时,node vitest 不宜加载——注入点用
 * 读源码断言(与仓内既有模式一致),guard 行为用 fixtures 纯函数断言:
 * 非 __DEV__(devModeActive=false)下 harness 全部失效(production-mode 断言)。
 */
const authContextSource = readFileSync(
  resolve(process.cwd(), 'src/auth/AuthContext.tsx'),
  'utf8',
);
const metroConfigSource = readFileSync(resolve(process.cwd(), 'metro.config.js'), 'utf8');

describe('AuthContext 注入点(静态源码断言)', () => {
  it('经静态 import 使用 fixtures', () => {
    expect(authContextSource).toContain(
      "import { resolveLoginScenarioFetch } from '@cindy/auth-client/fixtures'",
    );
  });

  it('guard 写死为 __DEV__ + EXPO_PUBLIC_LOGIN_SCENARIO(附录 A 值域 env)', () => {
    expect(authContextSource).toContain('devModeActive: __DEV__');
    expect(authContextSource).toContain('scenario: process.env.EXPO_PUBLIC_LOGIN_SCENARIO');
  });

  it('注入形态 = 真实 CindyAuthClient + fetch 构造参数(scenarioFetch ?? 真 fetch)', () => {
    expect(authContextSource).toContain(
      "fetch: region === 'cn' || region === 'global' ? scenarioFetch ?? mobileServiceFetch : mobileServiceFetch",
    );
    expect(authContextSource.match(/new CindyAuthClient\(/g)).toHaveLength(1);
  });

  it('metro.config 挂了生产 stub resolveRequest(build-time 排除双保险)', () => {
    expect(metroConfigSource).toContain("'@cindy/auth-client/fixtures'");
    expect(metroConfigSource).toContain("process.env.NODE_ENV === 'production'");
    expect(metroConfigSource).toContain('loginScenarios.production-stub.ts');
  });
});

describe('guard 行为(production-mode 断言)', () => {
  it('非 __DEV__(devModeActive=false)→ 即使 env 设置了 scenario 也恒 null', () => {
    expect(
      resolveLoginScenarioFetch({
        devModeActive: false,
        scenario: 'outcome:select-account',
        region: 'cn',
      }),
    ).toBeNull();
  });

  it('dev + scenario → 真实 mobile client 全真路径可走通', async () => {
    const scenarioFetch = resolveLoginScenarioFetch({
      devModeActive: true,
      scenario: 'outcome:binding-phone',
      region: 'cn',
    });
    expect(scenarioFetch).toBeTypeOf('function');
    const client = new CindyAuthClient({
      baseUrl: 'https://auth.scenario.invalid',
      region: 'cn',
      deviceId: 'harness-device',
      clientType: 'mobile',
      fetch: scenarioFetch!,
    });
    const outcome = await client.verifyCode('phone', '13800000000', '123456');
    expect(outcome).toMatchObject({ status: 'binding_required', bindType: 'phone' });
  });
});
