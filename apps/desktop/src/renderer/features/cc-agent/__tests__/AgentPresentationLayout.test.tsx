// @vitest-environment jsdom
import { useEffect } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentPresentationLayout } from '../AgentPresentationLayout';

afterEach(cleanup);

it('exposes the same pending host action while TUI hides its original GUI prompt', () => {
  const respond = vi.fn();
  const ui = render(<AgentPresentationLayout mode="tui" inputWidth="100%" inputPad={10}
    pending={<button onClick={respond}>Open pending action</button>} footer={<span>Footer</span>} terminal={<div>Native</div>}>
    <div data-testid="prompt">Original pending request</div>
  </AgentPresentationLayout>);
  expect(screen.getByTestId('prompt').closest('[inert]')).not.toBeNull();
  const entry = screen.getByRole('button');
  expect(entry.closest('[inert]')).toBeNull();
  fireEvent.click(entry);
  expect(respond).toHaveBeenCalledOnce();
  ui.unmount();
});

it('keeps footer controls, GUI drafts and the terminal mounted across presentation changes', () => {
  const mount = vi.fn();
  const unmount = vi.fn();
  function Footer() {
    useEffect(() => { mount(); return unmount; }, []);
    return <button>Switch presentation</button>;
  }
  const view = (mode: 'gui' | 'tui') => (
    <AgentPresentationLayout mode={mode} inputWidth={934} inputPad={40}
      footer={<Footer />} terminal={<div data-testid="terminal">Terminal output</div>}>
      <input aria-label="Draft" defaultValue="Unsent draft" />
    </AgentPresentationLayout>
  );
  const ui = render(view('gui'));
  const toggle = screen.getByRole('button');
  const draft = screen.getByLabelText('Draft');
  const terminal = screen.getByTestId('terminal');
  fireEvent.change(draft, { target: { value: 'Edited but not sent' } });
  for (const mode of ['tui', 'gui', 'tui', 'gui'] as const) {
    ui.rerender(view(mode));
    expect(screen.getByRole('button')).toBe(toggle);
    expect(toggle.closest('[inert]')).toBeNull();
    expect(screen.getByLabelText('Draft')).toBe(draft);
    expect((draft as HTMLInputElement).value).toBe('Edited but not sent');
    expect(screen.getByTestId('terminal')).toBe(terminal);
    expect(draft.closest('[inert]') !== null).toBe(mode === 'tui');
    expect(terminal.closest('[inert]') !== null).toBe(mode === 'gui');
  }
  expect(mount).toHaveBeenCalledTimes(1);
  expect(unmount).not.toHaveBeenCalled();
});

it('preserves focused footer controls when terminal support becomes available or the pane narrows', () => {
  const view = (terminalAvailable: boolean, width: number) => (
    <AgentPresentationLayout mode="gui" inputWidth={width} inputPad={10}
      footer={<button>Working directory</button>}
      terminal={terminalAvailable ? <div>Terminal</div> : null}>
      <div>Messages</div>
    </AgentPresentationLayout>
  );
  const ui = render(view(false, 934));
  const button = screen.getByRole('button');
  button.focus();
  ui.rerender(view(true, 380));
  expect(screen.getByRole('button')).toBe(button);
  expect(document.activeElement).toBe(button);
  ui.rerender(view(false, 934));
  expect(document.activeElement).toBe(button);
});
