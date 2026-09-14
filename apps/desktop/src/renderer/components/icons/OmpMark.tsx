/**
 * OmpMark —— OMP coding agent(can1357/oh-my-pi)的身份 mark。
 *
 * OMP 上游没有对外的品牌 glyph 规范,这里用「圆环 + 内部星芒」的简洁几何形
 * (13-14px 小尺寸下保持清晰,视觉重量与 ClaudeMark 像素脸 / CodexMark `>_`
 * 花形 / PiMark π 字形对齐,且与三者一眼可区分)。
 *  - variant="mono"(默认):currentColor,跟随主题/状态染色;
 *  - variant="brand":OMP 无官方品牌色,当前与 mono 相同(保留参数是为了与
 *    ClaudeMark/CodexMark/PiMark 的调用面一致,出现官方色后只改这里)。
 */

interface OmpMarkProps {
  size?: number;
  className?: string;
  variant?: 'mono' | 'brand';
}

export function OmpMark({ size = 14, className }: OmpMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* 外环(O) */}
        <circle cx="12" cy="12" r="7.4" />
        {/* 内部三向星芒 */}
        <path d="M12 8.6v6.8" />
        <path d="M9.1 10.3l5.8 3.4" />
        <path d="M14.9 10.3l-5.8 3.4" />
      </g>
    </svg>
  );
}
