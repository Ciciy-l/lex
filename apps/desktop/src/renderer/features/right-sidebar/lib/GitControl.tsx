import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Tip } from '@/components/ui/tooltip';

export function GitControl({
  label,
  children,
  iconOnly = false,
  size = 'default',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
  iconOnly?: boolean;
  size?: 'default' | 'compact';
}) {
  const compact = size === 'compact';
  return (
    <Tip text={label}>
      <button
        type="button"
        {...props}
        aria-label={label}
        className={
          'inline-flex shrink-0 items-center justify-center rounded-full font-medium text-[var(--text-secondary)] enabled:hover:bg-[var(--surface-hover)] enabled:hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-40 ' +
          (compact ? 'h-5 gap-0.5 text-10 ' : 'h-7 gap-1.5 text-12 ') +
          (iconOnly ? (compact ? 'w-5' : 'w-7') : compact ? 'px-1' : 'px-2.5') +
          ' ' +
          className
        }
      >
        {children}
      </button>
    </Tip>
  );
}
