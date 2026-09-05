/**
 * useBrandLogo — 品牌 wordmark logo 的深浅色选择。
 *
 * 品牌 logo 有两版打包资源:黑字版给浅色主题、白字版给深色主题
 * (两张都是透明底的横向 wordmark,同尺寸)。深浅判定跟随 <html> 上由
 * theme-service 按 theme.type 挂的 `dark` class,因此对内置/本地自定义
 * 主题一律生效,主题切换时实时更新。
 */

import { useIsDarkMode } from '@/components/markdown/useIsDarkMode';

import logoLight from '@/assets/login/lex-wordmark.svg';
import logoDark from '@/assets/login/lex-wordmark-dark.svg';

export { logoLight, logoDark };

/** 返回当前主题下应显示的品牌 logo URL(可直接用于 <img src>)。 */
export function useBrandLogo(): string {
  return useIsDarkMode() ? logoDark : logoLight;
}
