import type { CSSProperties, ReactNode } from 'react';

interface AgentPresentationLayoutProps {
  mode: 'gui' | 'tui';
  children: ReactNode;
  terminal: ReactNode;
  footer: ReactNode;
  pending?: ReactNode;
  inputWidth: CSSProperties['width'];
  inputPad: CSSProperties['paddingLeft'];
}

/** Keep task controls mounted at one position while either presentation is hidden. */
export function AgentPresentationLayout({
  mode, children, terminal, footer, pending, inputWidth, inputPad,
}: AgentPresentationLayoutProps) {
  return (
    <>
      {/* GUI overlays are relative to this body, which ends above the footer.
          Their existing height measurement must not include the footer again. */}
      <div className="relative flex min-h-0 flex-1 flex-col" data-agent-presentation-body>
        {mode === 'tui' && pending && <div role="status" className="shrink-0 px-3 py-2">{pending}</div>}
        <div className={mode === 'tui' ? 'hidden' : 'contents'} inert={mode === 'tui' ? true : undefined}>
          {children}
        </div>
        {terminal && (
          <div className={mode === 'tui' ? 'min-h-0 flex-1' : 'hidden'} inert={mode === 'gui' ? true : undefined}>
            {terminal}
          </div>
        )}
      </div>
      {/* Match the GUI composer column without narrowing the terminal body.
          The former composer gap (10px) + footer margin (6px) is one 16px inset. */}
      <div
        className="wallpaper-composer-zone shrink-0 bg-[hsl(var(--content-area))] pb-5 pt-4"
        style={{ paddingLeft: inputPad, paddingRight: inputPad }}
        data-agent-presentation-footer
      >
        <div className="mx-auto max-w-full" style={{ width: inputWidth }}>
          {footer}
        </div>
      </div>
    </>
  );
}
