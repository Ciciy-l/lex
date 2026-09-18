/**
 * OmpMark —— OMP coding agent (can1357/oh-my-pi) 的官方 T 形标记。
 *
 *  - variant="mono" (默认): currentColor，供 sidebar 的主题、选中和运行态
 *    Thinking Orange 染色使用；
 *  - variant="brand": 官方粉紫到青色的三段渐变，仅用于需要品牌辨识的
 *    非状态性表面。gradient id 用 useId 派生，避免多个 OMP mark 同屏串色。
 */

import { useId } from 'react';

const OMP_MARK_PATH = 'M10 14h44v9H43v33h-9V23h-9v22h-9V23H10z';

interface OmpMarkProps {
  size?: number;
  className?: string;
  variant?: 'mono' | 'brand';
}

export function OmpMark({ size = 14, className, variant = 'mono' }: OmpMarkProps) {
  const gradientId = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      {variant === 'brand' && (
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="oklch(0.7 0.24 340)" />
            <stop offset=".5" stopColor="oklch(0.62 0.21 295)" />
            <stop offset="1" stopColor="oklch(0.81 0.14 200)" />
          </linearGradient>
        </defs>
      )}
      <path
        fill={variant === 'brand' ? `url(#${gradientId})` : 'currentColor'}
        d={OMP_MARK_PATH}
      />
    </svg>
  );
}
