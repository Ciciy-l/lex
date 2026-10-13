// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ts from 'typescript';
import { responseSpeedActivity } from '@cindy/maker-shared/usage-format';
import { afterEach, expect, it, vi } from 'vitest';
import { ResponseSpeedStatus } from '@/features/cc-agent/ResponseSpeedStatus';
import {
  RunningTokenRatePopover,
  useRunningTokenRateHistory,
} from '@/features/cc-agent/RunningTokenRatePopover';
import {
  formatRecentOutputTokenRate,
  formatRunningTokenCount,
  resolveRunningUsageMeta,
} from '@/features/cc-agent/lib/runningTokenUsage';

vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, values?: { value?: unknown; rate?: unknown }) => `${key}${values?.value ?? values?.rate ?? ''}`,
}) }));

// Execute the actual status bar without loading the entire session view's IPC/store graph.
const source = readFileSync(
  resolve(__dirname, '../features/cc-agent/CCAgentSessionView.tsx'),
  'utf8',
);
const ast = ts.createSourceFile(
  'view.tsx',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const component = ast.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'RunningStatusBar',
);
if (!component) throw new Error('RunningStatusBar not found');
const compiled = ts.transpileModule(component.getText(ast), {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
}).outputText;
const Icon = () => null;
const deps = {
  React,
  responseSpeedActivity,
  useCallback,
  useEffect,
  useRef,
  useState,
  useTranslation: () => ({
    t: (key: string, values?: { value?: unknown; rate?: unknown }) => `${key}${values?.value ?? values?.rate ?? ''}`,
  }),
  useReducedMotion: () => true,
  useAnimatedNumber: (value: number) => value,
  localizeAgentStatus: (status: string) => status,
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
  Check: Icon,
  Activity: Icon,
  Layers: Icon,
  Sparkles: Icon,
  Spinner: Icon,
  Square: Icon,
  ArrowDown: Icon,
  STATUS_BAR_FADE_MS: 400,
  RunningTokenRatePopover,
  useRunningTokenRateHistory,
  formatRecentOutputTokenRate,
  formatRunningTokenCount,
  resolveRunningUsageMeta,
  ResponseSpeedStatus,
  Tip: ({ children }: { children: React.ReactNode }) => children,
};
const RunningStatusBar = new Function(
  'deps',
  `const {${Object.keys(deps).join(',')}} = deps; ${compiled}; return RunningStatusBar;`,
)(deps) as React.ComponentType<{
  visible: boolean;
  responseSpeed?: import('@cindy/maker-shared/usage-format').ResponseSpeedSnapshot;
  suppressContent?: boolean;
  rightLeadingSlot?: React.ReactNode;
  status: string;
  reconnectStatus?: string | null;
  startedAt: number | null;
  tokenUsage: number;
  outputTokens: number;
  generationDurationMs: number;
  generationActive?: boolean;
  generationReliable?: boolean;
}>;

afterEach(() => { cleanup(); vi.useRealTimers(); });

const completed = { phase: 'complete' as const, waitOrigin: 'turn' as const, firstResponseMs: 2000,
  waitingMs: 0, durationMs: 4000, outputTokens: 300, estimated: false, averageRate: 75, recentRate: 75,
  samples: [{ durationMs: 1000, outputTokens: 70, rate: 70 }], sampledAt: 1 };
const props = { visible: false, status: 'Done', startedAt: null, tokenUsage: 90000,
  outputTokens: 90000, generationDurationMs: 4000, responseSpeed: completed };

it('retains measured output after completion, without billing tokens, and yields to interaction cards', () => {
  const view = render(<RunningStatusBar {...props} rightLeadingSlot={<span>control</span>} />);
  expect(screen.getByText('control')).toBeTruthy();
  fireEvent.click(view.container.querySelector('button')!);
  const dialog = screen.getByRole('dialog');
  expect(dialog.textContent).toContain('75');
  expect(dialog.textContent).not.toContain('90.0k');
  view.rerender(<RunningStatusBar {...props} rightLeadingSlot={<span>control</span>} suppressContent />);
  expect(screen.getByText('control')).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(view.container.querySelector('[data-running-status-meta]')).toBeNull();
});

it('clears the retained result on the next turn and preserves the legacy fallback', () => {
  const view = render(<RunningStatusBar {...props} />);
  expect(view.container.textContent).toContain('chat.runningStatus.lastGeneration');
  view.rerender(<RunningStatusBar {...props} visible status="Thinking..." startedAt={Date.now()}
    responseSpeed={{ ...completed, phase: 'waiting', firstResponseMs: null, outputTokens: 0,
      durationMs: 0, samples: [], recentRate: null, averageRate: null }} />);
  expect(view.container.textContent).not.toContain('75');
  expect(view.container.textContent).toContain('chat.runningStatus.responsePending');
  view.rerender(<RunningStatusBar {...props} visible responseSpeed={undefined} />);
  expect(view.container.querySelector('[data-running-status-meta]')).toBeTruthy();
});
