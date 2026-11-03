// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}#${JSON.stringify(values)}` : key,
  }),
}));
vi.mock('@/hooks/useCodexContextWindow', () => ({
  useCodexContextWindow: () => ({
    contextWindow: 1_000_000,
    usableContextWindow: 950_000,
    autoCompactTokenLimit: 900_000,
    pendingApply: false,
  }),
}));
vi.mock('@/lib/modelDefinitions', () => ({ getModelsForVendor: () => [] }));
vi.mock('../ContextWindowBudgetChip', () => ({
  ContextWindowBudgetChip: ({
    children,
    details,
    onCompact,
    agentKind,
  }: {
    children: React.ReactNode;
    details: React.ReactNode;
    onCompact?: () => void;
    agentKind: string;
  }) => (
    <div data-agent={agentKind}>
      {children}
      {details}
      {onCompact && <button type="button" onClick={onCompact}>compact-action</button>}
    </div>
  ),
}));

import { ContextCapacityRing } from '../ContextCapacityRing';

describe('ContextCapacityRing', () => {
  it('shows runtime usage, Codex technical facts and the manual action hook', () => {
    const onCompact = vi.fn();
    render(
      <ContextCapacityRing
        sessionId="session-1"
        contextTokens={500_000}
        model="gpt-test"
        vendorKey="codex"
        sdkContextWindow={1_000_000}
        providers={{ providers: [] }}
        onCompact={onCompact}
      />,
    );

    expect(screen.getByText('50%')).toBeTruthy();
    expect(screen.getByText('ccAgent.contextRingPanel.title')).toBeTruthy();
    expect(screen.getByText('ccAgent.contextRingPanel.technical')).toBeTruthy();
    expect(screen.getByText(/codexContextValues/).textContent).toContain('900,000');
    fireEvent.click(screen.getByRole('button', { name: 'compact-action' }));
    expect(onCompact).toHaveBeenCalledOnce();
  });

  it('keeps OMP on the runtime-reported window without inventing catalog capacity', () => {
    render(
      <ContextCapacityRing
        sessionId="session-omp"
        contextTokens={128_000}
        model="omp-test"
        vendorKey="omp"
        sdkContextWindow={256_000}
        providers={{ providers: [] }}
      />,
    );
    expect(screen.getByText('50%')).toBeTruthy();
    expect(document.querySelector('[data-agent="omp"]')).toBeTruthy();
  });
});
