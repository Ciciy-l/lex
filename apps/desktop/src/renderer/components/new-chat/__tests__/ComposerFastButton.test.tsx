// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ComposerFastButton } from '../ComposerFastButton';
import { toast } from '@/lib/toast';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/tooltip', () => ({ Tip: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('requests a change once and waits for the owning state before showing Fast on', async () => {
  let finish!: (applied: boolean) => void;
  const onChange = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  const view = render(<ComposerFastButton enabled={false} onChange={onChange} />);
  const button = screen.getByRole('button') as HTMLButtonElement;
  fireEvent.click(button);
  fireEvent.click(button);
  expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
  expect(button.disabled).toBe(true);
  expect(button.getAttribute('aria-pressed')).toBe('false');
  await act(async () => finish(false));
  expect(button.disabled).toBe(false);
  expect(button.getAttribute('aria-pressed')).toBe('false');
  view.rerender(<ComposerFastButton enabled onChange={onChange} />);
  expect(button.getAttribute('aria-pressed')).toBe('true');
  expect(button.getAttribute('aria-label')).toContain('disable');
  fireEvent.click(button);
  expect(onChange).toHaveBeenLastCalledWith(false);
  await act(async () => finish(true));
});

it('cannot write locked settings and recovers from rejected saves', async () => {
  const onChange = vi.fn().mockRejectedValue(new Error('offline'));
  const view = render(<ComposerFastButton enabled disabled onChange={onChange} />);
  const button = screen.getByRole('button') as HTMLButtonElement;
  fireEvent.click(button);
  expect(onChange).not.toHaveBeenCalled();
  view.rerender(<ComposerFastButton enabled onChange={onChange} />);
  fireEvent.click(button);
  await waitFor(() => expect(toast.error).toHaveBeenCalledOnce());
  expect(button.disabled).toBe(false);
  expect(button.getAttribute('aria-pressed')).toBe('true');
});
