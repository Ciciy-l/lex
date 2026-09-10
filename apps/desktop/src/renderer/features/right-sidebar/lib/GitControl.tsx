import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Tip } from '@/components/ui/tooltip';

export function GitControl({
  label,
  children,
  iconOnly = false,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
  iconOnly?: boolean;
}) {
  return (
    <Tip text={label}>
      <button
        type="button"
        {...props}
        aria-label={label}
        className={
          'inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-full text-12 font-medium text-[var(--text-secondary)] enabled:hover:bg-[var(--surface-hover)] enabled:hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-40 ' +
          (iconOnly ? 'w-7' : 'px-2.5') +
          ' ' +
          className
        }
      >
        {children}
      </button>
    </Tip>
  );
}
