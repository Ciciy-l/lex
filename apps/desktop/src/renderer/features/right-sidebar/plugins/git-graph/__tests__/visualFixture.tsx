import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import zh from '../../../../../i18n/locales/zh-CN/common.json';
import '../../../../../styles/globals.css';
import '../../../../../themes/colors';
import { exportThemeColors } from '../../../../../themes/theme-service';
import { defaultLight } from '../../../../../themes/builtin/default-light';
import { defaultDark } from '../../../../../themes/builtin/default-dark';
import { GitNavigation } from '../../../GitNavigation';
import { GitGraphTabBody } from '../GitGraphTabBody';
import { hydrateGraphState } from '../state';
import topology from './real-history-topology.json';
import type { GitGraphData } from '../../../../../../shared/gitGraph';
import type { TabKindHostContext } from '../../../types';

const oid = (index: number) => index.toString(16).padStart(40, 'a');
const graph: GitGraphData = {
  scope: {
    sessionId: 'preview',
    repoRoot: '/workspace/lex',
    workdir: '/workspace/lex',
    workingDir: '/workspace/lex',
    worktreePath: null,
    branch: 'dev/v1',
    headOid: oid(1),
    isDetached: false,
    isUnborn: false,
    source: 'workingDir',
    aheadBehind: { ahead: 2, behind: 0, upstream: 'origin/dev/v1', stale: false },
    disabledReason: null,
    disabledMessage: null,
    resolutionChain: [],
  },
  commits: Array.from({ length: 30 }, (_, index) => ({
    oid: oid(index + 1),
    parents:
      index === 0
        ? Array.from({ length: 12 }, (_, offset) => oid(offset + 2))
        : index === 29
          ? []
          : [oid(index + 2)],
    title: [
      '优化 Git 提交图信息布局与主题配色',
      '修复分支比较与提交详情显示',
      'feat: preserve commit metadata in narrow content tabs',
    ][index % 3],
    author: index % 2 ? 'Lex contributor' : '开发者',
    authorTime: 1788940800 - index * 3700,
  })),
  refs: [
    { name: 'refs/heads/dev/v1', oid: oid(1), kind: 'local' },
    { name: 'refs/remotes/origin/dev/v1', oid: oid(1), kind: 'remote' },
    { name: 'refs/tags/v1.0-preview', oid: oid(4), kind: 'tag' },
  ],
  hasMore: true,
};

if (new URLSearchParams(location.search).get('history') === 'merges') {
  const main = Array.from({ length: 14 }, (_, index) => ({
    oid: oid(index + 1),
    parents: [index === 13 ? oid(99) : oid(index + 2), oid(index + 51)],
    title: '合并提交 ' + index,
    author: 'Lex',
    authorTime: 1788940800 - index * 3700,
  }));
  const feature = Array.from({ length: 14 }, (_, index) => ({
    oid: oid(index + 51),
    parents: [index === 13 ? oid(99) : oid(index + 52)],
    title: '功能改动 ' + index,
    author: 'Lex',
    authorTime: 1788800000 - index * 3700,
  }));
  graph.commits = [
    ...main.flatMap((commit, index) => [commit, feature[index]]),
    { oid: oid(99), parents: [], title: '初始提交', author: 'Lex', authorTime: 1788000000 },
  ];
}

if (new URLSearchParams(location.search).get('history') === 'real') {
  graph.commits = topology.parents.map((parents, index) => ({
    oid: oid(index + 1),
    parents: parents.map((parent) => oid(parent + 1)),
    title:
      index === topology.focus
        ? '286148cb Merge branch dev/v1'
        : parents.length > 1
          ? '合并提交 ' + index
          : '分支提交 ' + index,
    author: 'Topology fixture',
    authorTime: 1788940800 - index * 1000,
  }));
  graph.hasMore = false;
}

Object.defineProperty(window, 'electronAPI', {
  value: {
    gitReview: {
      graph: async () => graph,
      navigation: async () => ({
        scope: graph.scope,
        status: {
          files: [
            { path: 'src/git-graph/CommitList.tsx', sources: ['unstaged'], isUntracked: false },
          ],
        },
      }),
      history: async () => ({
        scope: graph.scope,
        commits: graph.commits
          .slice(0, 8)
          .map((commit) => ({ ...commit, shortOid: commit.oid.slice(-7) })),
        truncated: true,
      }),
      commitDiff: async () => ({ diffs: [], capped: null }),
      graphCompare: async (request: object) => ({
        ...request,
        diffs: [],
        capped: null,
        warning: null,
      }),
    },
  },
});

const dark = new URLSearchParams(location.search).get('theme') === 'dark';
document.documentElement.classList.toggle('dark', dark);
for (const [token, value] of Object.entries(exportThemeColors(dark ? defaultDark : defaultLight)))
  document.documentElement.style.setProperty('--' + token, value);
document.body.style.background = 'var(--surface)';
document.body.style.color = 'var(--text-primary)';
await i18next.use(initReactI18next).init({
  lng: 'zh-CN',
  resources: { 'zh-CN': { translation: zh } },
  interpolation: { escapeValue: false },
});

function Preview() {
  const [state, setState] = useState(hydrateGraphState(null));
  const ctx = {
    sessionId: 'preview',
    workdir: '/workspace/lex',
    remoteHostId: null,
    deviceLinkDeviceId: null,
    patchState: (patch: object) => setState((current) => ({ ...current, ...patch })),
  } as TabKindHostContext;
  return (
    <main style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 200px', height: '100vh' }}>
      <GitGraphTabBody ctx={ctx} state={state} />
      <aside
        style={{ display: 'flex', minHeight: 0, borderLeft: '1px solid var(--border-default)' }}
      >
        <GitNavigation sessionId="preview" deviceId={null} />
      </aside>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Preview />);
