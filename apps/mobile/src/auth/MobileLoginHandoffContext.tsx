/**
 * MobileLoginHandoffContext —— 移动开机衔接 Provider/store/reporter
 * (PR4b Step 5b WHAT2;状态机核在 loginHandoff.ts 纯模块,本文件只做 React 接线)。
 *
 * reporter 拓扑(写死,v6.3):RootLayout 常驻本 Provider;endpoint gate 在 root 层
 * 直接上报;RootAfterEndpoints 内上报 OTA;AuthProvider 内(桥组件)上报 auth-init;
 * 登录页上报「面板已挂载」;品牌资产为打包资源,由 Stage 的图片 load/error 回调全部结束后上报。
 * 不改变 endpoint→OTA→auth 既有挂载顺序。
 *
 * phase 推进(代码保证确定性,规则 9):readiness 达成时——已登录或 reduced-motion
 * 直落 done(品牌屏直入/无动画);否则进入 handoff,按 loginHandoffTotalMs 定时收束
 * (计时器挂在 Provider,不依赖任一 Stage 实例存活)。
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from 'react';
import { AccessibilityInfo, useWindowDimensions } from 'react-native';

import {
  INITIAL_LOGIN_HANDOFF_STATE,
  loginHandoffReadiness,
  loginHandoffTotalMs,
  reduceLoginHandoff,
  type LoginHandoffAction,
  type LoginHandoffState,
} from './loginHandoff';
import { resolveLoginSurfaceMode } from './loginSkinLayout';

export interface LoginHandoffContextValue {
  state: LoginHandoffState;
  /** loginHandoffReadiness(state) 的缓存投影 */
  ready: boolean;
  dispatch: Dispatch<LoginHandoffAction>;
}

const LoginHandoffContext = createContext<LoginHandoffContextValue | null>(null);

export function MobileLoginHandoffProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(
    reduceLoginHandoff,
    INITIAL_LOGIN_HANDOFF_STATE,
  );
  const { width, height } = useWindowDimensions();

  // reduced-motion:挂载拉取一次 + 订阅变更;卸载移除监听
  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (!cancelled) dispatch({ type: 'reduced-motion', value });
      })
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      (value) => dispatch({ type: 'reduced-motion', value }),
    );
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  const ready = loginHandoffReadiness(state);

  // readiness 达成 → 推进 phase(已登录直入/reduced-motion 直落终态,否则播衔接)
  useEffect(() => {
    if (!ready || state.phase !== 'splash') return;
    if (state.authenticated === true || state.reducedMotion) {
      dispatch({ type: 'handoff-done' });
      return;
    }
    dispatch({ type: 'handoff-start' });
  }, [ready, state.phase, state.authenticated, state.reducedMotion]);

  // handoff 播放收束计时(时长按当前构图;挂 Provider 保证跨闸门屏切换存活)
  useEffect(() => {
    if (state.phase !== 'handoff') return;
    const mode = resolveLoginSurfaceMode(width, height);
    const timer = setTimeout(
      () => dispatch({ type: 'handoff-done' }),
      loginHandoffTotalMs(mode),
    );
    return () => clearTimeout(timer);
  }, [state.phase, width, height]);

  const value = useMemo(() => ({ state, ready, dispatch }), [state, ready]);
  return (
    <LoginHandoffContext.Provider value={value}>
      {children}
    </LoginHandoffContext.Provider>
  );
}

/**
 * 可选消费:Provider 缺席(隔离渲染/旧调用方)时返回 null,
 * Stage 退化为 PR4a 静态终态渲染,不抛错。
 */
export function useLoginHandoffOptional(): LoginHandoffContextValue | null {
  return useContext(LoginHandoffContext);
}

/** 必选消费(reporter 桥组件用;Provider 由 RootLayout 常驻保证存在)。 */
export function useLoginHandoff(): LoginHandoffContextValue {
  const value = useContext(LoginHandoffContext);
  if (value == null) {
    throw new Error('useLoginHandoff must be used within MobileLoginHandoffProvider');
  }
  return value;
}
