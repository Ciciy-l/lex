import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { GitGraphData } from '../../../../../shared/gitGraph';
import { GitControl } from '../../lib/GitControl';
import { GRAPH_LANE_COLORS, graphLanes, shortGraphRef } from './state';

export function GraphCommitList({
  data,
  query,
  selected,
  includeRemotes,
  onSelect,
}: {
  data: GitGraphData;
  query: string;
  selected: string | null;
  includeRemotes: boolean;
  onSelect: (oid: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const commits = data.commits;
  const rows = useMemo(() => graphLanes(commits), [commits]);
  const [pan, setPan] = useState(0);
  const totalLanes = Math.max(1, ...rows.map((row) => row.width));
  const shownLanes = Math.min(6, totalLanes);
  const offset = Math.min(pan, Math.max(0, totalLanes - shownLanes));
  // Lanes are centered at 8 + n * 12.  A column therefore needs the
  // (shownLanes - 1) intervals between centers plus 8px on either side;
  // allocating one more full interval leaves an unexplained blank gutter.
  const width = shownLanes * 12 + 4;
  useEffect(() => {
    const row = rows.find((item) => item.oid === selected);
    if (row)
      setPan((current) =>
        row.lane < current
          ? row.lane
          : row.lane >= current + shownLanes
            ? row.lane - shownLanes + 1
            : current,
      );
  }, [selected, rows, shownLanes]);
  const dates = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n?.language, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }),
    [i18n?.language],
  );
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next =
      event.key === 'ArrowDown'
        ? index + 1
        : event.key === 'ArrowUp'
          ? index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? commits.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    const target = commits[Math.max(0, Math.min(next, commits.length - 1))];
    if (!target) return;
    onSelect(target.oid);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('[data-commit-row]')
      [Math.max(0, Math.min(next, commits.length - 1))]?.focus();
  };
  return (
    <div style={{ '--git-graph-width': width + 'px' } as CSSProperties}>
      <div className="lex-git-graph-row lex-git-graph-header sticky top-0 z-10 bg-[var(--surface)]">
        <div className="flex min-w-0 items-center justify-between">
          {totalLanes > shownLanes ? (
            <>
              <GitControl
                label={t('rightSidebar.gitGraph.lanesLeft')}
                iconOnly
                disabled={offset === 0}
                onClick={() => setPan(Math.max(0, offset - 3))}
              >
                <ChevronLeft size={12} />
              </GitControl>
              <span className="text-10" title={t('rightSidebar.gitGraph.lanesHint')}>
                {offset + 1}–{offset + shownLanes}
              </span>
              <GitControl
                label={t('rightSidebar.gitGraph.lanesRight')}
                iconOnly
                disabled={offset + shownLanes >= totalLanes}
                onClick={() => setPan(Math.min(totalLanes - shownLanes, offset + 3))}
              >
                <ChevronRight size={12} />
              </GitControl>
            </>
          ) : (
            <span aria-hidden="true">{t('rightSidebar.gitGraph.graphColumn')}</span>
          )}
        </div>
        <span>{t('rightSidebar.gitGraph.subjectColumn')}</span>
        <span className="lex-git-graph-author">{t('rightSidebar.gitGraph.authorColumn')}</span>
        <span className="lex-git-graph-date">{t('rightSidebar.gitGraph.dateColumn')}</span>
        <span className="lex-git-graph-hash">SHA</span>
      </div>
      {commits.map((commit, index) => {
        const row = rows[index];
        const hasUnloadedParent = row.edges.some((edge) => 'boundary' in edge);
        const refs = data.refs.filter(
          (ref) => ref.oid === commit.oid && (includeRemotes || ref.kind !== 'remote'),
        );
        const time = new Date(commit.authorTime * 1000);
        const validTime = Number.isFinite(time.getTime());
        const shortTime = validTime ? dates.format(time) : '—';
        const fullTime = validTime ? time.toLocaleString(i18n?.language) : '—';
        const matches = [
          commit.oid,
          commit.title,
          commit.author,
          shortTime,
          fullTime,
          ...refs.map((ref) => ref.name),
        ]
          .join(' ')
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase());
        return (
          <button
            type="button"
            key={commit.oid}
            data-commit-row
            data-commit-oid={commit.oid}
            data-head={commit.oid === data.scope.headOid}
            aria-pressed={selected === commit.oid}
            onKeyDown={(event) => keyDown(event, index)}
            onClick={() => onSelect(commit.oid)}
            className={'lex-git-graph-row ' + (matches ? '' : 'opacity-30')}
          >
            <svg
              width={width}
              height={52}
              preserveAspectRatio="none"
              viewBox={offset * 12 + ' 0 ' + width + ' 52'}
              aria-hidden="true"
              className="overflow-hidden"
            >
              {hasUnloadedParent && <title>{t('rightSidebar.gitGraph.unloadedParents')}</title>}
              {row.edges.map((edge, edgeIndex) => {
                const fromX = edge.from * 12 + 8;
                const toX = edge.to * 12 + 8;
                const start = edge.from === row.lane ? 26 : 0;
                return (
                  <path
                    key={edgeIndex}
                    d={
                      'boundary' in edge
                        ? 'M ' + fromX + ' 26 l 5 12'
                        : 'M ' +
                          fromX +
                          ' ' +
                          start +
                          ' C ' +
                          fromX +
                          ' 39 ' +
                          toX +
                          ' 39 ' +
                          toX +
                          ' 52'
                    }
                    stroke={GRAPH_LANE_COLORS[edge.color]}
                    strokeWidth={1.5}
                    strokeDasharray={'boundary' in edge ? '2 2' : undefined}
                    fill="none"
                  />
                );
              })}
              {row.incoming && (
                <path
                  d={'M ' + (row.lane * 12 + 8) + ' 0 V 26'}
                  stroke={GRAPH_LANE_COLORS[row.color]}
                  strokeWidth={1.5}
                />
              )}
              <circle
                cx={row.lane * 12 + 8}
                cy={26}
                r={selected === commit.oid ? 4 : 3}
                fill={GRAPH_LANE_COLORS[row.color]}
                stroke="var(--surface)"
                strokeWidth={1.5}
              />
            </svg>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate font-medium" title={commit.title}>
                {commit.title}
              </span>
              {hasUnloadedParent && (
                <span className="sr-only">{t('rightSidebar.gitGraph.unloadedParents')}</span>
              )}
              <span className="flex min-w-0 items-center gap-1 overflow-hidden text-10">
                {commit.oid === data.scope.headOid && (
                  <span className="lex-git-graph-ref shrink-0 font-medium">HEAD</span>
                )}
                {refs.slice(0, 2).map((ref) => (
                  <span key={ref.name} className="lex-git-graph-ref" title={ref.name}>
                    {shortGraphRef(ref.name)}
                  </span>
                ))}
                {refs.length > 2 && (
                  <span
                    title={refs
                      .slice(2)
                      .map((ref) => ref.name)
                      .join('\n')}
                  >
                    +{refs.length - 2}
                  </span>
                )}
                <span
                  className="lex-git-graph-inline-author truncate text-[var(--text-secondary)]"
                  title={commit.author}
                >
                  {commit.author}
                </span>
              </span>
              <span className="lex-git-graph-inline-date flex min-w-0 gap-2 text-10 text-[var(--text-secondary)]">
                <time dateTime={validTime ? time.toISOString() : undefined} title={fullTime}>
                  {shortTime}
                </time>
                <code className="lex-git-graph-inline-hash" title={commit.oid}>
                  {commit.oid.slice(0, 8)}
                </code>
              </span>
            </span>
            <span
              className="lex-git-graph-author truncate text-11 text-[var(--text-secondary)]"
              title={commit.author}
            >
              {commit.author}
            </span>
            <time
              className="lex-git-graph-date whitespace-nowrap text-11 text-[var(--text-secondary)]"
              dateTime={validTime ? time.toISOString() : undefined}
              title={fullTime}
            >
              {shortTime}
            </time>
            <code
              className="lex-git-graph-hash text-11 text-[var(--text-secondary)]"
              title={commit.oid}
            >
              {commit.oid.slice(0, 8)}
            </code>
          </button>
        );
      })}
    </div>
  );
}
