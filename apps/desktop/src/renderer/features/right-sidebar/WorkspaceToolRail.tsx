import {
  FolderTree,
  GitFork,
  ListTodo,
  ChevronsLeft,
  ChevronsRight,
  UsersRound,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tip } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { listTabKindMenuMetas } from './registry';
import type { TabKindId } from './types';
import { workspaceSurface } from '../../../shared/workspaceSurface';

const FIXED_TOOLS = [
  ['file-browser', 'rightSidebar.tabs.kinds.fileBrowser', FolderTree],
  ['background-tasks', 'rightSidebar.tabs.kinds.backgroundTasks', ListTodo],
  // Collaboration is content-level navigation too: the existing Cindy worker
  // conversation UI stays in the tab strip; the rail is only its stable entry.
  ['orca-workers', 'rightSidebar.tabs.kinds.collaboration', UsersRound],
  // Review opens its existing content tab, while this fixed button remains the
  // stable navigation affordance requested by the Lex workspace layout.
  ['review', 'rightSidebar.workbench.git', GitFork],
] as const;

export function WorkspaceToolRail({
  activeKind,
  expanded,
  onToggle,
  onSelect,
  subagentsAvailable,
  iosSimulatorAvailable,
}: {
  activeKind?: string;
  expanded: boolean;
  onToggle: () => void;
  onSelect: (kind: TabKindId) => void;
  subagentsAvailable: boolean;
  iosSimulatorAvailable: boolean;
}) {
  const { t } = useTranslation();
  // Keep the overflow mechanism for future/custom workspace tools, but only
  // expose it when there are actual tool entries to fold. Content creators
  // (browser, simulator, Subagents, terminals) belong to the top-bar `+` menu.
  const extras = listTabKindMenuMetas().filter(
    (item) =>
      item.enabled &&
      !item.hiddenFromMenu &&
      workspaceSurface(item.kind) === 'tool' &&
      !FIXED_TOOLS.some(([kind]) => kind === item.kind) &&
      (item.kind !== 'subagents' || subagentsAvailable) &&
      (item.kind !== 'ios-simulator' || iosSimulatorAvailable),
  );
  const ToggleIcon = expanded ? ChevronsRight : ChevronsLeft;
  const toggleLabel = t(
    expanded ? 'rightSidebar.terminal.hideTools' : 'rightSidebar.terminal.showTools',
  );
  return (
    <nav
      aria-label={t('rightSidebar.terminal.tools')}
      className="flex w-10 shrink-0 flex-col items-center gap-1 border-l border-[var(--border-default)] py-1"
    >
      <Tip text={toggleLabel}>
        <Button
          size="md"
          className="w-8 px-0"
          variant="secondary"
          onClick={onToggle}
          aria-label={toggleLabel}
          aria-expanded={expanded}
        >
          <ToggleIcon size={16} />
        </Button>
      </Tip>
      {FIXED_TOOLS.map(([kind, label, Icon]) => (
        <Tip key={kind} text={t(label)}>
          <Button
            size="md"
            className="w-8 px-0"
            variant={expanded && activeKind === kind ? 'primary' : 'secondary'}
            aria-label={t(label)}
            aria-pressed={expanded && activeKind === kind}
            onClick={() => onSelect(kind)}
          >
            <Icon size={16} />
          </Button>
        </Tip>
      ))}
      {extras.length > 0 && (
        <DropdownMenu>
          <Tip text={t('rightSidebar.terminal.moreTools')}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="secondary"
                size="md"
                className="w-8 px-0"
                aria-label={t('rightSidebar.terminal.moreTools')}
              >
                …
              </Button>
            </DropdownMenuTrigger>
          </Tip>
          <DropdownMenuContent side="left">
            {extras.map((item) => (
              <DropdownMenuItem key={item.kind} onSelect={() => onSelect(item.kind)}>
                {item.labelText || t(item.labelKey)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </nav>
  );
}
