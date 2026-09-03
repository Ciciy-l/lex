// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CindyAuthClient, reduceAuthFlow, type AuthFlowState } from '@cindy/auth-client';
import { createScenarioFetch } from '@cindy/auth-client/fixtures';

/**
 * Cindy 账号服务区徽标(标题旁品牌红胶囊)的映射单测。
 *
 * 为什么单独成文件:Lex 只有一个安装包，徽标行为跟随 Main 返回的登录 realm，
 * 与构建区域无关。这里直接切换 useLogin 的 loginRealm 覆盖 cn/global 两档。
 *
 * 为什么值得测:徽标**缺席**在代码里是看不见的——global 不挂徽标是产品叙事的
 * 硬规则(DESIGN.md §16.3「给 global 恢复徽标即回退该决策,不得回退」),但没有
 * 断言的话,后来者很容易把它当成漏做而"补"回来;dev 漏进映射表同样不会有任何
 * 报错。本 PR 施工期间 login-flow-hifi 预览就真的把判定条件写反过(默认 cn 不
 * 挂、global 反而挂),正是这类错误的实例。
 */

const loginHook = vi.hoisted(() => ({
  value: {
    isLoading: false,
    errorCode: null as string | null,
    loginState: null as unknown,
    loginRealm: 'cn' as 'cn' | 'global',
    dispatch: vi.fn(async () => true),
    dispatchWithResult: vi.fn(async () => ({ success: true, code: null })),
    clearError: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../../shared/brandRegion', () => ({
  CURRENT_CINDY_REGION: 'global',
  CURRENT_APP_ID: 'com.xd.cindy',
}));
vi.mock('@/hooks/useLogin', () => ({ useLogin: () => loginHook.value }));
vi.mock('@/components/title-bar/WindowControls', () => ({ WindowControls: () => null }));

import { LoginPage } from '../LoginPage';

/**
 * identifier 屏状态。徽标只挂在 identifier 屏的标题块上,且其渲染只取决于
 * 当前登录 realm、与服务端下发的 providers 无关。
 */
async function identifierState(): Promise<AuthFlowState> {
  const client = new CindyAuthClient({
    baseUrl: 'https://auth.scenario.invalid',
    region: 'cn',
    deviceId: 'region-pill-test',
    clientType: 'desktop',
    fetch: createScenarioFetch('providers:both', { region: 'cn' })!,
  });
  const providers = await client.getProviders();
  return reduceAuthFlow(null, { type: 'providers-loaded', providers });
}

function mount(state: AuthFlowState, loginRealm: 'cn' | 'global') {
  loginHook.value = {
    isLoading: false,
    errorCode: null,
    loginState: state,
    loginRealm,
    dispatch: vi.fn(async () => true),
    dispatchWithResult: vi.fn(async () => ({ success: true, code: null })),
    clearError: vi.fn(),
  };
  return render(<LoginPage />);
}

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { platform: 'darwin', acceptPrivacyConsent: async () => ({ allowed: true }) },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('登录页 Cindy 服务区徽标', () => {
  it('选择中国大陆服务区时显示 CN 徽标', async () => {
    mount(await identifierState(), 'cn');
    expect(screen.getByTestId('login-region-pill').textContent).toBe('login.regionPill.cn');
  });

  it('选择 Global 服务区时不挂徽标', async () => {
    mount(await identifierState(), 'global');
    // 标题仍在,只是不带徽标——区分「没渲染徽标」与「整个标题块没渲染」
    expect(screen.getByTestId('login-panel-identifier')).toBeTruthy();
    expect(screen.queryByTestId('login-region-pill')).toBeNull();
  });

  it('徽标宽度由 padding 撑开,不写死宽度(文案随区域变长变短)', async () => {
    mount(await identifierState(), 'cn');
    const pill = screen.getByTestId('login-region-pill');
    // 固定 width 是旧几何(为 "Global" 一词量身定的 70px),回退它会让 CN / Dev
    // 在胶囊里留大片空白,见 REGION_PILL doc 与 DESIGN.md §16.3。
    expect(pill.style.width).toBe('');
    expect(pill.style.paddingLeft).toBe('11px');
    expect(pill.style.paddingRight).toBe('11px');
    expect(pill.style.height).toBe('30px');
  });
});
