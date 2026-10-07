// expo-router 深链拦截。
//
// auth-server 回调 cindycn://auth / cindy://auth 没有对应路由页,默认会落到 expo-router 的
// +not-found(「Unmatched Route」白屏),把登录界面盖住。这里把该回调路径重定向到 '/'(index),
// 让 index 按登录态渲染(未登录→/login,已登录→首页)。
//
// 实际的 PKCE code 交换**不依赖路由**:由 src/auth/AuthContext.tsx 的 Linking.addEventListener /
// getInitialURL 监听器独立捕获原始 URL 并完成(见其 handleDeepLink)。本文件只负责别让路由 404。
//
// 背景(为何 Android 暴露、iOS 不会):iOS 的系统认证会话通常会在会话内捕获
// 自定义 scheme 并 inline 完成,router 不会导航到 /auth;Android 上服务器 302 到自定义
// scheme 常以新 intent 冷启 App,expo-router 就撞上无路由的 /auth。此拦截让两端一致落到 index。
//
// 纯 JS(不进 @expo/fingerprint / 不改 runtimeVersion),可随热更下发。

import { clearSharedTaskInvitationIntent, receiveSharedTaskInvitationIntent } from '@/device-link/sharedTaskInvitationIntent';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const invitationUrl = /^(?:\/shared-session|\/shared-task\/join)\?/.test(path) ? 'cindy:/' + path : path;
    if (receiveSharedTaskInvitationIntent(invitationUrl)) return '/shared-session';
    // path 可能是完整 URL('cindycn://auth?code=...')或路径('/auth?code=...'),统一取出 pathname。
    const noScheme = path.replace(/^[a-zA-Z][\w+.-]*:\/\//, '/');
    const pathname = noScheme.split('?')[0].split('#')[0].replace(/\/+$/, '') || '/';
    // 命中 OAuth 回调 → 回首页;其余深链(/sessions/xxx、/devices 等)原样放行。
    if (pathname === '/auth') return '/';
    if (pathname === '/shared-session' || pathname === '/shared-task/join') {
      clearSharedTaskInvitationIntent();
      return '/shared-session';
    }
    return path;
  } catch {
    return path;
  }
}
