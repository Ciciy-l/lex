import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import {
  Animated,
  Easing,
  Platform,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import Svg, { Circle, Path } from 'react-native-svg';

import {
  resolveLoginStage,
  type LoginStageBox,
  type LoginStageLayout,
  type LoginSurfaceLayout,
} from '@/auth/loginSkinLayout';
import {
  LOGIN_HANDOFF_EASING,
  LOGIN_HANDOFF_TIMING,
  loginHandoffMoveMs,
} from '@/auth/loginHandoff';
import { useLoginHandoffOptional } from '@/auth/MobileLoginHandoffContext';
import { useLoginFirstLaunchLight } from '@/auth/loginFirstLaunchGate';
import { resolveStartupSplashHandoff } from '@/auth/startupSplashContinuity';
import { ThemeOverrideProvider, useTheme } from '@/theme';
import { useAdaptiveWindow } from '@/platform/AdaptiveWindowContext';
import { resolveLoginWindowSurface } from '@/auth/loginGroupPlacement';
import { resolveLexBrandLayout } from '@/auth/lexBrandLayout';

/**
 * MobileLoginHandoffStage —— 白底体系登录/闸门**唯一 full-viewport 品牌宿主**
 * (PR4a 静态视觉宿主,implementation-plan Step 5 WHAT1 / v6.10;PR4b Step 5b
 * 接入 handoff 状态/入场动画 + §3.6 平板双构图 + 键盘位移)。
 *
 * 职责与坐标空间冻结(v6.5;背景 2026-07-22 对齐 PR#104 改纯平):
 *  - 背景 = 主题 surface 纯平底色(edge-to-edge 铺满含 safe area 外区域),
 *    早期 wave4 的双红叠层已撤除;endpoint/OTA/auth 各闸、config-missing、
 *    登录页、iPad 横竖屏全部复用本宿主,共享同一纯平底;
 *  - 底色钉在根 View 上不随键盘位移(keyboardShiftPx 只作用于品牌层,children 的
 *    位移由登录页内层 translate 容器自管,见 v5 冻结测量拓扑);
 *  - Lex 品牌立绘/字标走 stage 坐标(resolveLoginSurface 布局引擎,
 *    U-8a 照 demo;§3.6 平板竖屏 744×1133 / 横屏 1180×820 双构图);新字标
 *    423×145 在字标框内 contain 等比适配,禁止非等比拉伸(368:1381 资产行);
 *  - Lex splash 按安全区域居中，人物/字标/spinner 分区，几何见 lexBrandLayout；
 *    handoff 沿用原时序，readiness 达成后 300ms 起 650ms 位移到登录位
 *    (iPad 横屏无位移变体)，Lex 登录不再显示 Cindy slogan;
 *    reduced-motion / Provider 缺席 → 静态终态；常驻 splash 保持居中直至淡出。动画全部 transform/opacity +
 *    useNativeDriver(compositor-only,规则 7);spinner 仅 splash/handoff 期挂载。
 */

// Lex 品牌资产与来源见 docs/dev-rules/lex-mobile-integration.md。
// Lex 字标提供亮色与暗色画布两个版本，
// 立绘两模式同资产。
// Reuse Lex artwork with the existing responsive stage and handoff.
const heroAsset = require('../../assets/lex/assistant-startup.png');
const wordmarkAsset = require('../../assets/lex/wordmark.png');
const wordmarkDarkAsset = require('../../assets/lex/wordmark-dark.png');

/** hook:物理 viewport → §3.6 三构图 surface 布局(useWindowDimensions → resolveLoginSurface)。 */
export function useLoginSurface(): LoginSurfaceLayout {
  const window = useAdaptiveWindow();
  return useMemo(() => resolveLoginWindowSurface(window), [window]);
}

/** 兼容出口(PR4a 消费面):物理 viewport → 750 手机 stage 两档插值布局。 */
export function useLoginStage(): LoginStageLayout {
  const { width, height } = useWindowDimensions();
  return useMemo(() => resolveLoginStage(width, height), [width, height]);
}

/** Translate/scale the whole image between two non-overlapping compositions. */
function animatedBrandStyle(login: LoginStageBox, splash: LoginStageBox, progress: Animated.Value) {
  return {
    position: 'absolute' as const,
    left: login.x,
    top: login.y,
    width: login.w,
    height: login.h,
    transform: [
      { translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [0, splash.x + splash.w / 2 - login.x - login.w / 2] }) },
      { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [0, splash.y + splash.h / 2 - login.y - login.h / 2] }) },
      { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [1, splash.w / login.w] }) },
    ],
  };
}

/**
 * splash spinner(demo msSpin 尺寸/落点;白底体系沿 LoginLoadingRing 圈样式——
 * demo 的 invert 白 spinner 为红底时代参数,wave4 白底以近黑环呈现)。
 * 1s linear infinite,transform-only + useNativeDriver;仅 splash/handoff 期挂载。
 */
function SplashSpinner({
  size,
  opacity,
  reducedMotion,
}: {
  size: number;
  opacity: Animated.Value;
  reducedMotion: boolean;
}) {
  const { colors } = useTheme();
  const rotation = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reducedMotion) return;
    const loop = Animated.loop(
      Animated.timing(rotation, {
        toValue: 1,
        duration: 1000,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [reducedMotion, rotation]);
  const spin = rotation.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });
  return (
    <Animated.View
      style={{ width: size, height: size, opacity, transform: [{ rotate: spin }] }}
    >
      <Svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden>
        <Circle
          cx="32"
          cy="32"
          r="29"
          stroke={colors.login.loadingRingTrack}
          strokeWidth="6"
        />
        <Path
          d="M61 32a29 29 0 0 0-29-29"
          stroke={colors.login.primaryButtonBg}
          strokeWidth="6"
          strokeLinecap="round"
        />
      </Svg>
    </Animated.View>
  );
}

/**
 * 品牌宿主组件。children 渲染在品牌层之上的 viewport 坐标 overlay
 * (登录页在其中自行铺设 stage 缩放的 Log_in 组;闸门屏放退化后的内容层)。
 * Provider 缺席时按静态终态渲染(PR4a 行为不变)。
 */
export function MobileLoginHandoffStage(props: {
  children?: ReactNode;
  /** Startup overlay keeps its own centered composition until it fades away. */
  splashOnly?: boolean;
  /** handoff 动画期品牌层由本宿主状态机驱动;静态调用方恒显 */
  showBrand?: boolean;
  /** 键盘位移(物理 px,向上为正;只作用品牌层——children 位移由登录页自管) */
  keyboardShiftPx?: number;
  testID?: string;
  accessibilityLabel?: string;
}) {
  // 首启亮色门在品牌宿主层消费(DESIGN.md §16.5 主题跟随):splash/闸门/登录
  // 共享同一覆盖,首启不出现「舞台暗 → 登录亮」闪变;覆盖仅限本宿主子树。
  const firstLaunchGate = useLoginFirstLaunchLight();
  const { mode: systemTheme } = useTheme();
  const handoff = resolveStartupSplashHandoff(firstLaunchGate, systemTheme);
  // pending 时由 Android 原生帧复刻层继续覆盖；本舞台不提前猜测主题。
  if (handoff.targetTheme == null) return null;
  return (
    <ThemeOverrideProvider mode={handoff.targetTheme}>
      <MobileLoginHandoffStageInner {...props} />
    </ThemeOverrideProvider>
  );
}

function MobileLoginHandoffStageInner({
  children,
  showBrand = true,
  splashOnly = false,
  keyboardShiftPx = 0,
  testID,
  accessibilityLabel,
}: {
  children?: ReactNode;
  /** Startup overlay keeps its own centered composition until it fades away. */
  splashOnly?: boolean;
  /** handoff 动画期品牌层由本宿主状态机驱动;静态调用方恒显 */
  showBrand?: boolean;
  /** 键盘位移(物理 px,向上为正;只作用品牌层——children 位移由登录页自管) */
  keyboardShiftPx?: number;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const { colors, mode } = useTheme();
  const stage = useLoginSurface();
  const window = useAdaptiveWindow();
  const brand = resolveLexBrandLayout(stage, window.insets);
  const handoff = useLoginHandoffOptional();
  // Provider 缺席 = 静态终态(pr4a 兼容);缺席时不播动画、不挂 spinner
  const phase = splashOnly ? 'splash' : handoff?.state.phase ?? 'done';

  // Bundled URLs are available synchronously; decoded image pixels are not.
  const settledAssets = useRef(new Set<string>());
  const dispatch = handoff?.dispatch;
  const assetSettled = useCallback((key: string) => {
    settledAssets.current.add(key);
    if (settledAssets.current.size === 2) dispatch?.({ type: 'assets-ready' });
  }, [dispatch]);

  // handoff 动画驱动(demo splashHandoff 时序;值域 1=splash 居中位,0=登录终位)
  const brandProgress = useRef(
    new Animated.Value(phase === 'done' ? 0 : 1),
  ).current;
  const spinnerOpacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (phase === 'handoff') {
      const moveMs = loginHandoffMoveMs(stage.mode);
      const spinnerAnimation = Animated.timing(spinnerOpacity, {
        toValue: 0,
        duration: LOGIN_HANDOFF_TIMING.spinnerFadeMs,
        useNativeDriver: true,
      });
      const brandAnimation = Animated.sequence([
        Animated.delay(LOGIN_HANDOFF_TIMING.brandMoveDelayMs),
        Animated.timing(brandProgress, {
          toValue: 0,
          duration: moveMs,
          easing: Easing.bezier(
            LOGIN_HANDOFF_EASING.brandMove[0],
            LOGIN_HANDOFF_EASING.brandMove[1],
            LOGIN_HANDOFF_EASING.brandMove[2],
            LOGIN_HANDOFF_EASING.brandMove[3],
          ),
          useNativeDriver: true,
        }),
      ]);
      spinnerAnimation.start();
      brandAnimation.start();
      return () => {
        spinnerAnimation.stop();
        brandAnimation.stop();
      };
    }
    if (phase === 'done') {
      brandProgress.setValue(0);
      spinnerOpacity.setValue(0);
      return;
    }
    brandProgress.setValue(1);
    spinnerOpacity.setValue(1);
  }, [phase, stage.mode, brandProgress, spinnerOpacity]);

  // 暗色画布用白字版 Lex 字标；立绘两模式同资产。
  const wordmarkSource = mode === 'dark' ? wordmarkDarkAsset : wordmarkAsset;

  return (
    <View
      accessibilityLabel={accessibilityLabel}
      style={[styles.root, { backgroundColor: colors.login.bgBase }]}
      testID={testID}
    >
      {/* 白底体系:状态栏随主题模式。Android 继续走组件式 StatusBar(覆盖 Stack
          未挂载的闸门屏);iOS 27 起 RN StatusBar 全局 API 失效,iOS 侧由 _layout /
          login 的 statusBarStyle screen option 按舞台有效主题控制,导航器外
          (端点闸门错误屏)由系统外观自动适配。 */}
      {Platform.OS === 'android' ? (
        <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
      ) : null}
      {showBrand ? (
        // 键盘位移层(demo kb-shift 同构):品牌随面板整体上顶,根 View 纯平底不动
        <View
          pointerEvents="none"
          style={[
            styles.stage,
            {
              left: stage.offsetX,
              top: stage.offsetY,
              width: stage.stageWidth,
              height: stage.stageHeight,
              transform: [
                { translateY: -keyboardShiftPx },
                { scale: stage.scale },
              ],
            },
          ]}
        >
          <Animated.Image
            accessibilityIgnoresInvertColors
            accessible={false}
            resizeMode="contain"
            fadeDuration={0}
            source={heroAsset}
            onLoad={() => assetSettled('hero')}
            onError={() => assetSettled('hero')}
            style={animatedBrandStyle(brand.login.hero, brand.splash.hero, brandProgress)}
          />
          <Animated.Image
            accessibilityIgnoresInvertColors
            accessible={false}
            resizeMode="contain"
            fadeDuration={0}
            source={wordmarkSource}
            onLoad={() => assetSettled('wordmark')}
            onError={() => assetSettled('wordmark')}
            style={animatedBrandStyle(brand.login.word, brand.splash.word, brandProgress)}
          />
          {/* splash spinner:仅 splash/handoff 期挂载(限时长,规则 7) */}
          {handoff != null && phase !== 'done' ? (
            <View
              style={{
                position: 'absolute',
                left: brand.spinner.x,
                top: brand.spinner.y,
              }}
            >
              <SplashSpinner size={brand.spinner.size} opacity={spinnerOpacity} reducedMotion={handoff.state.reducedMotion} />
            </View>
          ) : null}
        </View>
      ) : null}
      {children != null ? <View collapsable={false} style={[StyleSheet.absoluteFill, { zIndex: 1 }]}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    overflow: 'hidden',
  },
  stage: {
    position: 'absolute',
    // stage → 物理 px:整层 transform 缩放,原点钉左上(demo transform-origin:0 0)
    transformOrigin: 'top left',
  },
});
