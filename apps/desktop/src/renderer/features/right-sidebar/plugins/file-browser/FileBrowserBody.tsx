/** Workspace file tool: tree/search navigation only. Files open in independent content tabs. */

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronsDownUp, FolderX, RefreshCw, Search, X as XIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { isGlobalDropIntercepted } from '@/lib/globalDropIntercept';
import { toast } from '@/lib/toast';
import { mapIpcErrorToI18nKey } from '@/utils/ipcError';
import { Tip } from '@/components/ui/tooltip';
import { Spinner } from '@/components/ui/spinner';
import { ImageLightbox } from '@/components/chat/ImageLightbox';
import {
  FileTreeView,
  type FileTreeViewHandle,
} from '@/features/cc-agent/workdir-browse/FileTreeView';
import { useFileTree, type DirEntry } from '@/features/cc-agent/workdir-browse/hooks/useFileTree';
import { useProjectFileList } from '@/features/cc-agent/workdir-browse/hooks/useProjectFileList';
import { useRevealFileInTree } from '@/features/cc-agent/workdir-browse/hooks/useRevealFileInTree';
import { SearchPanel } from '@/features/cc-agent/workdir-browse/search/SearchPanel';
import { useProjectSearch } from '@/features/cc-agent/workdir-browse/search/hooks/useProjectSearch';
import { FileFilterInput } from '@/features/cc-agent/workdir-browse/FileFilterInput';
import { FilterResultList } from '@/features/cc-agent/workdir-browse/FilterResultList';
import {
  FILTER_RESULT_LIMIT,
  filterFiles,
} from '@/features/cc-agent/workdir-browse/lib/filterFiles';
import { toOsAbsolutePath } from '@/features/cc-agent/workdir-browse/lib/fileMeta';
import {
  openUrlInSidebarBrowser,
  pathToFileUrl,
} from '@/features/right-sidebar/lib/openInSidebarBrowser';
import { openFileContentInSidebar } from '../../lib/openFileContentTab';
import { toWorkdirRel } from '../../../../../shared/workdirPath';

import type { TabKindHostContext } from '../../types';
import type { FileBrowserState } from './index';
import { buildFileTreeImagePreviewUrl } from './fileTreeImagePreview';
import {
  countFileDragItems,
  hasFileDragPayload,
  isDroppedFilePreviewSupported,
  runExternalFileOpenRequest,
  splitExternalFilePath,
} from './dropExternalFile';

/** 项目级 ripgrep 搜索硬上限,跟 doc 模式 sidebar 同值。 */
const SEARCH_MAX_MATCHES = 1000;

type TreeMode = 'tree' | 'search';

// CodeMirror padding / max-width override —— 让嵌入式版 FileBodyView 在窄栏里
// 内容真正贴边,不被 doc 模式那套阅读舒适 padding(72px + max-w 920px)挤到中间。
import './FileBrowserBody.css';

interface FileBrowserBodyProps {
  state: FileBrowserState;
  ctx: TabKindHostContext;
}

export function FileBrowserBody({ state, ctx }: FileBrowserBodyProps) {
  const { workdir } = ctx;
  if (!workdir) {
    return <NoWorkdirPlaceholder />;
  }
  if (ctx.deviceLinkDeviceId === undefined) return <Spinner />;
  return <FileBrowserBodyWithWorkdir state={state} ctx={ctx} workdir={workdir} />;
}

/**
 * 拆出"workdir 非空"分支以保证 hooks 顺序稳定 —— useFileTree / useFileContent
 * 不应在 workdir 空字符串时挂载(IPC 路径校验会炸),React 又禁止条件 hook,所以
 * 把"是否挂"上提到 component 级条件渲染。
 */
function FileBrowserBodyWithWorkdir({
  state,
  ctx,
  workdir,
}: FileBrowserBodyProps & { workdir: string }) {
  const { t } = useTranslation();
  // Host ownership is resolved before mounting any read/search hooks. Never
  // persist unknown ownership as an explicit local file source.
  const deviceId = ctx.deviceLinkDeviceId ?? null;
  const remoteHostId = deviceId ? null : ctx.remoteHostId;
  const isRemote = Boolean(remoteHostId) || Boolean(deviceId);
  const tree = useFileTree({ workdir, hideMetaFiles: true, remoteHostId, deviceId });
  const [imageLightboxSrc, setImageLightboxSrc] = useState<string | null>(null);
  const fileDragDepthRef = useRef(0);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const openFile = useCallback(
    async (path: string, preview = false, line?: number) => {
      if (!ctx.sessionId) return;
      try {
        await openFileContentInSidebar(ctx.sessionId, {
          path,
          workdir,
          external: false,
          preview,
          ...(line ? { reveal: { line, requestId: crypto.randomUUID() } } : {}),
          remoteHostId,
          deviceId,
        });
      } catch {
        toast.error(t('rightSidebar.tabs.addFailed'));
      }
    },
    [ctx.sessionId, workdir, remoteHostId, deviceId, t],
  );
  // 文件树 / 搜索 双模式 —— 跟 doc 模式 sidebar 同 ergonomics(参考 WorkdirBrowseSidebar
  // L124 的 mode state)。mode 不持久化,关 tab 重开默认 tree(合理预期:用户切到
  // 新 tab 期望"看文件",不是"接着上次的搜索状态")。
  const [mode, setMode] = useState<TreeMode>('tree');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  // 文件名筛选 query —— tree 模式下用,独立于内容搜索。空 query 显示文件树,有
  // 内容显示筛选结果列表。不持久化(关 tab 重开默认空)。
  const [filterQuery, setFilterQuery] = useState('');
  // 项目级文件名扁平列表(走 ripgrep --files honor .gitignore),给文件名筛选用。
  // 缓存 30 秒,跨 tab 共享同 workdir 索引;tree.refresh 时同步 invalidate。
  // remote:daemon 内跑远端 rg;远端没有 rg 时返回空 + error,走"未索引"占位。
  // enabled 惰性拉取:query 为空(FilterResultList 不显示)时不扫描 —— 切会话
  // 不再为用不上的索引付 rg + IPC + 建索引的主线程成本。trim 与 filterFiles
  // 的匹配语义对齐:纯空格 query 结果必为空,不值得为它扫描。
  const projectFiles = useProjectFileList(workdir, remoteHostId, deviceId, {
    enabled: filterQuery.trim() !== '',
  });
  const filteredFiles = useMemo(
    () => filterFiles(filterQuery, projectFiles.files),
    [filterQuery, projectFiles.files],
  );
  const search = useProjectSearch({
    workdir,
    remoteHostId,
    deviceId,
    query: searchQuery,
    caseSensitive: searchCaseSensitive,
    maxMatches: SEARCH_MAX_MATCHES,
  });

  const containerRef = useRef<HTMLDivElement>(null);

  const handleSelectFile = useCallback(
    async (relPath: string) => {
      // Tree selection never replaces or discards another file tab's draft.
      ctx.patchState({ selectedFilePath: relPath });
      await openFile(relPath, true);
    },
    [openFile, ctx],
  );

  const handleOpenMatch = useCallback(async (relPath: string, line: number) => {
    ctx.patchState({ selectedFilePath: relPath });
    await openFile(relPath, true, line);
  }, [openFile, ctx]);

  // FileTreeView 的 imperative ref —— useRevealFileInTree 通过它调 scrollToPath。
  const fileTreeRef = useRef<FileTreeViewHandle>(null);
  const revealFileInTree = useRevealFileInTree(tree, fileTreeRef);

  // 聊天目录 chip → openDirInSidebarFileBrowser 写入的一次性定位请求:切回 tree
  // 视图、展开父目录并滚到该目录行、把目录本身也展开(用户意图是"看这个文件夹
  // 里有什么")。消费后立即清空 transient 字段,tab 重挂载 / 会话切换不会重放。
  // nonce 进依赖:同一目录重复点击也重新触发。
  const revealDirPath = state.revealDirPath ?? null;
  const revealDirNonce = state.revealDirNonce ?? 0;
  useEffect(() => {
    if (revealDirPath === null) return;
    let cancelled = false;
    void (async () => {
      setMode('tree');
      setFilterQuery('');
      if (revealDirPath === '') {
        ctx.patchState({ revealDirPath: null });
        return;
      }
      await revealFileInTree(revealDirPath);
      if (cancelled) return;
      if (!tree.expanded.has(revealDirPath)) tree.toggleFolder(revealDirPath);
      ctx.patchState({ revealDirPath: null });
    })();
    return () => {
      cancelled = true;
    };
    // tree/ctx 引用变化不该重放已消费的请求。
  }, [revealDirPath, revealDirNonce]);

  // 聊天文件 chip → openFileInSidebarFileBrowser 写入的一次性定位请求:
  // 选中文件,切回 tree 视图,展开父目录并把文件行滚到视口中部。切换前仍走
  // dirty guard,避免用户在当前 RSB 文件里有未保存编辑时被外部右键菜单直接切走。
  const revealFilePath = state.revealFilePath ?? null;
  const revealFileNonce = state.revealFileNonce ?? 0;
  useEffect(() => {
    if (!revealFilePath) return;
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      setMode('tree');
      setFilterQuery('');
      ctx.patchState({ selectedFilePath: revealFilePath });
      await openFile(revealFilePath);
      await revealFileInTree(revealFilePath);
      if (cancelled) return;
      ctx.patchState({ revealFilePath: null });
    })();
    return () => {
      cancelled = true;
    };
    // state/ctx/tree 引用变化不该重放已消费的请求。
  }, [revealFilePath, revealFileNonce]);

  // 文件名筛选结果点击 → 选中文件 + 清空 query + 展开父目录 + 滚动到该行
  // (回到正常文件树视图,跟用户直觉一致:"我找到这个文件了,接下来就在看它")。
  // 展开 + 滚动逻辑封在 useRevealFileInTree,doc 模式 sidebar 共用同一份(以后
  // 优化 reveal 行为只改 hook 一处)。
  const handleSelectFromFilter = handleSelectFile;


  // refresh 按钮:文件树 + 项目文件索引一起 invalidate。
  const handleRefresh = useCallback(() => {
    void tree.refresh();
    projectFiles.refresh();
  }, [tree, projectFiles]);

  const handleCopyFilePath = useCallback(
    async (entry: DirEntry) => {
      const abs = toOsAbsolutePath(workdir, entry.relPath);
      try {
        await navigator.clipboard.writeText(abs);
        toast.success(t('ccAgent.workdirBrowse.pathCopied'));
      } catch {
        toast.warning(t('ccAgent.workdirBrowse.copyFailed'));
      }
    },
    [workdir, t],
  );

  const handlePreviewImage = useCallback(
    (entry: DirEntry) => {
      const src = buildFileTreeImagePreviewUrl({
        workdir,
        relPath: entry.relPath,
        remoteHostId,
        deviceId,
      });
      if (!src) {
        toast.warning(t('ccAgent.workdirBrowse.unrenderable.remoteNotSupported'));
        return;
      }
      setImageLightboxSrc(src);
    },
    [deviceId, remoteHostId, t, workdir],
  );

  const handleRevealInFolder = useCallback(
    async (entry: DirEntry) => {
      const abs = toOsAbsolutePath(workdir, entry.relPath);
      const res = await window.electronAPI.showItemInFolder({ filePath: abs });
      if (!res.success) {
        toast.error(
          t('ccAgent.workdirBrowse.revealFailed', {
            error: res.error ?? t('ccAgent.common.unknownError'),
          }),
        );
      }
    },
    [workdir, t],
  );

  const handleOpenInSidebarBrowser = useCallback(
    async (entry: DirEntry) => {
      if (!ctx.sessionId) return;
      const abs = toOsAbsolutePath(workdir, entry.relPath);
      try {
        await openUrlInSidebarBrowser(ctx.sessionId, pathToFileUrl(abs));
      } catch {
        toast.error(t('chat.markdownRenderer.openInSidebarFailed'));
      }
    },
    [ctx.sessionId, workdir, t],
  );

  const handleOpenInFileBrowser = useCallback(
    async (entry: DirEntry) => {
      if (entry.type !== 'file') return;
      if (!ctx.sessionId) return;
      try {
        await openFile(entry.relPath);
      } catch {
        toast.error(t('rightSidebar.tabs.addFailed'));
      }
    },
    [ctx.sessionId, t],
  );

  const handleOpenInBrowser = useCallback(
    async (entry: DirEntry) => {
      const abs = toOsAbsolutePath(workdir, entry.relPath);
      try {
        await window.electronAPI.openFileInBrowser(abs);
      } catch (error) {
        toast.error(
          t(
            mapIpcErrorToI18nKey(error, {
              namespace: 'chat.markdownRenderer',
              fallback: 'chat.markdownRenderer.openInBrowserFailed',
            }),
          ),
        );
      }
    },
    [workdir, t],
  );

  const handleDroppedExternalFile = useCallback(
    async (absPath: string, isCancelled: () => boolean = () => false) => {
      if (!isDroppedFilePreviewSupported(absPath)) {
        toast.error(t('rightSidebar.fileBrowser.unsupportedDropFile'));
        return;
      }

      const localRelPath = !isRemote ? toWorkdirRel(workdir, absPath) : null;
      if (localRelPath) {
        if (isCancelled()) return;
        setMode('tree');
        setFilterQuery('');
        ctx.patchState({ selectedFilePath: localRelPath });
        await openFile(localRelPath);
        void revealFileInTree(localRelPath);
        return;
      }

      const external = splitExternalFilePath(absPath);
      if (!external) {
        toast.error(t('rightSidebar.fileBrowser.unsupportedDropFile'));
        return;
      }

      if (isCancelled()) return;
      setMode('tree');
      setFilterQuery('');
      await openFileContentInSidebar(ctx.sessionId, {
        path: external.relPath,
        workdir: external.workdir,
        external: true,
      });
      ctx.patchState({ selectedFilePath: null });
    },
    [openFile, ctx, isRemote, revealFileInTree, state.selectedFilePath, t, workdir],
  );

  // 聊天文件 chip 的“在侧边栏文件浏览器中打开”可把 workdir 外本地文件写成
  // 一次性请求。这里直接复用上面的原生拖入处理，确保格式限制、dirty guard、
  // 只读预览和“仓内路径仍定位文件树”的行为只有一份实现。
  const externalFilePath = state.externalFilePath ?? null;
  const externalFileNonce = state.externalFileNonce ?? 0;
  useEffect(() => {
    if (!externalFilePath) return;
    let cancelled = false;
    void runExternalFileOpenRequest({
      absPath: externalFilePath,
      open: handleDroppedExternalFile,
      isCancelled: () => cancelled,
      clearRequest: () => ctx.patchState({ externalFilePath: null }),
    });
    return () => {
      cancelled = true;
    };
    // ctx / handler 引用变化不应重放已消费的请求；path / nonce 更新会取消旧请求。
  }, [externalFilePath, externalFileNonce]);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!hasFileDragPayload(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      fileDragDepthRef.current = 0;
      setIsDraggingFile(false);

      // .cindy / .cshare 已被窗口级 capture 接管(装入 / 导入链路),
      // 只清理拖拽 UI 状态,不进文件预览。
      if (isGlobalDropIntercepted(event.nativeEvent)) return;

      if (countFileDragItems(event.dataTransfer) > 1) {
        toast.error(t('rightSidebar.fileBrowser.multipleDropFilesUnsupported'));
        return;
      }

      const items = event.dataTransfer.items;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind !== 'file') continue;
        const entry = item.webkitGetAsEntry?.();
        if (entry?.isDirectory) {
          toast.error(t('rightSidebar.fileBrowser.unsupportedDropFile'));
          return;
        }
        const file = item.getAsFile();
        if (!file) continue;
        let absPath = '';
        try {
          absPath = window.electronAPI.getFilePath(file);
        } catch {
          absPath = '';
        }
        if (absPath) {
          void handleDroppedExternalFile(absPath);
          return;
        }
      }

      if (event.dataTransfer.files.length > 0) {
        let absPath = '';
        try {
          absPath = window.electronAPI.getFilePath(event.dataTransfer.files[0]);
        } catch {
          absPath = '';
        }
        if (absPath) {
          void handleDroppedExternalFile(absPath);
          return;
        }
      }

      toast.error(t('rightSidebar.fileBrowser.unsupportedDropFile'));
    },
    [handleDroppedExternalFile, t],
  );

  const handleFileDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasFileDragPayload(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    fileDragDepthRef.current += 1;
    setIsDraggingFile(true);
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleFileDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasFileDragPayload(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setIsDraggingFile(true);
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleFileDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasFileDragPayload(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
    if (fileDragDepthRef.current === 0) setIsDraggingFile(false);
  }, []);

  const handleFileDragEnd = useCallback(() => {
    fileDragDepthRef.current = 0;
    setIsDraggingFile(false);
  }, []);

  // remote 会话的 watch 事件经远端 daemon 推回(P4),正常路径下与本地同等实时;
  // 但 SSH 断链重连的间隙里 daemon 换代、事件会漏,窗口重新聚焦时静默刷新
  // 文件树 + 当前文件作为兜底,保证"断链期间远端改了文件 → 用户切回来能看到"。
  useEffect(() => {
    if (!isRemote) return;
    const onFocus = () => {
      void tree.refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [isRemote, tree]);

  const handleToggleSearch = useCallback(() => {
    setMode((m) => (m === 'search' ? 'tree' : 'search'));
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative flex h-full min-h-0 w-full overflow-hidden"
      onDragEnter={handleFileDragEnter}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDragEnd={handleFileDragEnd}
      onDrop={handleDrop}
    >
      {/* 右 pane:文件树 / 搜索 双模式 —— 拖拽宽度,跨 tab 共享持久化。
          v1 不接 onNewFile / onDelete / onRename 等右键能力,只支持选中文件 —— RSB
          这种狭窄面板里弹"新建文件 / 重命名"对话框体验差,doc 模式更合适。
          tree / search 切换跟 doc 模式 sidebar 同 ergonomics:tree 模式显示文件树,
          search 模式显示 SearchPanel(ripgrep 项目级搜索)。 */}
      <div className="rsb-fbody-tree-pane flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        <TreeHeader
          workdir={workdir}
          mode={mode}
          onToggleSearch={handleToggleSearch}
          onCollapseAll={tree.collapseAll}
          onRefresh={handleRefresh}
        />
        {/* tree 模式:常驻文件名筛选输入框 + (筛选结果列表 / 文件树)。
            注:className 必须**只在隐藏时**加 `hidden`,**不能**同时写 `block` ——
            Tailwind 的 `block` 是 display:block,会覆盖 `flex`,容器不再是 flex 容器,
            内部 `min-h-0 flex-1` 拿不到明确高度,FileTreeView 的 overflow-y-auto
            就滚不动了(2026-06-30 用户实测 bug)。 */}
        <div className={cn('flex min-h-0 flex-1 flex-col', mode !== 'tree' && 'hidden')}>
          <FileFilterInput value={filterQuery} onChange={setFilterQuery} />
          {filterQuery ? (
            <FilterResultList
              files={filteredFiles}
              truncated={
                // ripgrep cap 截断,或者前端展示上限截断(命中超过 FILTER_RESULT_LIMIT)
                projectFiles.truncated || filteredFiles.length >= FILTER_RESULT_LIMIT
              }
              isLoading={projectFiles.isLoading}
              indexError={projectFiles.error}
              selectedPath={state.selectedFilePath}
              onSelectFile={handleSelectFromFilter}
              onOpenFile={path => void openFile(path)}
            />
          ) : tree.loadError && tree.entries.size === 0 ? (
            <TreeLoadErrorPlaceholder kind={tree.loadError} onRetry={handleRefresh} />
          ) : (
            <div className="rsb-fbody-tree-scroll min-h-0 flex-1">
              <FileTreeView
                ref={fileTreeRef}
                tree={tree}
                selectedPath={state.selectedFilePath}
                onSelectFile={handleSelectFile}
                onOpenFile={path => void openFile(path)}
                onPreviewImage={handlePreviewImage}
                onCopyFilePath={!isRemote ? handleCopyFilePath : undefined}
                onRevealInFolder={!isRemote ? handleRevealInFolder : undefined}
                onOpenInFileBrowser={ctx.sessionId ? handleOpenInFileBrowser : undefined}
                onOpenInSidebarBrowser={
                  !isRemote && ctx.sessionId ? handleOpenInSidebarBrowser : undefined
                }
                onOpenInBrowser={!isRemote ? handleOpenInBrowser : undefined}
              />
            </div>
          )}
        </div>
        {/* search 模式:整个 body 替换为 ripgrep 内容搜索面板 */}
        <div className={cn('min-h-0 flex-1', mode === 'search' ? 'block' : 'hidden')}>
          <SearchPanel
            query={searchQuery}
            onQueryChange={setSearchQuery}
            caseSensitive={searchCaseSensitive}
            onCaseSensitiveChange={setSearchCaseSensitive}
            results={search.results}
            totalMatches={search.totalMatches}
            totalFiles={search.totalFiles}
            status={search.status}
            errorMessage={search.errorMessage}
            errorCode={search.errorCode}
            maxMatches={SEARCH_MAX_MATCHES}
            onOpenMatch={handleOpenMatch}
            onKeepMatch={(path, line) => void openFile(path, false, line)}
          />
        </div>
      </div>
      {isDraggingFile && (
        <div
          className="pointer-events-none absolute inset-2 z-20 rounded-xl border border-dashed border-[var(--drop-overlay-border)] bg-[var(--drop-overlay-bg)]"
          aria-hidden="true"
        />
      )}
      {imageLightboxSrc ? (
        <ImageLightbox
          src={imageLightboxSrc}
          sessionId={ctx.sessionId}
          onClose={() => setImageLightboxSrc(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * 文件树顶部 chrome —— 对标 doc 模式 WorkdirBrowseSidebar 顶部那行(标题 + 工具按钮)。
 *
 * 内容:
 *  - 左:workdir basename(项目名,从 workdir 路径末段提取)
 *  - 右(tree 模式):search / collapse-all / refresh 三个 icon 按钮
 *  - 右(search 模式):X 退出搜索(替代 search 按钮位置)
 *
 * 视觉对齐 doc 模式 WorkdirBrowseSidebar(参考 L570-678):
 *   - 整行 pt-2 pb-1 pl-3 pr-2(窄栏比 doc 模式 pl-6 pr-3 紧)
 *   - 标题 text-sm font-semibold text-foreground
 *   - icon 按钮 size-5 rounded-md hover:bg-sidebar-item-active text-sidebar-action-icon
 */
function TreeHeader({
  workdir,
  mode,
  onToggleSearch,
  onCollapseAll,
  onRefresh,
}: {
  workdir: string;
  mode: TreeMode;
  onToggleSearch: () => void;
  onCollapseAll: () => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  // workdir basename:POSIX 用最后一段(/Users/sam/Documents/Cindy → Cindy);
  // Windows 'C:\\Users\\sam\\Cindy' 也按 / 和 \ 切。空值兜底空串。
  const displayName = workdir.split(/[/\\]/).filter(Boolean).pop() ?? '';

  return (
    <div className="flex shrink-0 items-center justify-between pt-2 pb-1 pl-3 pr-2">
      <span className="truncate text-sm font-semibold text-foreground" title={workdir}>
        {displayName}
      </span>
      <div className="flex shrink-0 items-center gap-1.5">
        {mode === 'search' ? (
          // search 模式:refresh / collapse 只对文件树有意义,搜索时不显示;只留 X
          // 退出搜索回到 tree 模式(替代 search 按钮位置,跟 doc 模式同 ergonomics)。
          <Tip text={t('ccAgent.workdirBrowse.searchPanel.exit')}>
            <button
              type="button"
              onClick={onToggleSearch}
              className="flex size-5 items-center justify-center rounded-md text-sidebar-action-icon hover:bg-sidebar-item-active hover:text-sidebar-item-active-foreground"
            >
              <XIcon size={14} strokeWidth={2} />
            </button>
          </Tip>
        ) : (
          <>
            <Tip text={t('ccAgent.workdirBrowse.searchPanel.searchFiles')}>
              <button
                type="button"
                onClick={onToggleSearch}
                className="flex size-5 items-center justify-center rounded-md text-sidebar-action-icon hover:bg-sidebar-item-active hover:text-sidebar-item-active-foreground"
              >
                <Search size={14} strokeWidth={2} />
              </button>
            </Tip>
            <Tip text={t('ccAgent.workdirBrowse.treeAction.collapseAll')}>
              <button
                type="button"
                onClick={onCollapseAll}
                className="flex size-5 items-center justify-center rounded-md text-sidebar-action-icon hover:bg-sidebar-item-active hover:text-sidebar-item-active-foreground"
              >
                <ChevronsDownUp size={14} strokeWidth={2} />
              </button>
            </Tip>
            <Tip text={t('ccAgent.workdirBrowse.treeAction.refresh')}>
              <button
                type="button"
                onClick={onRefresh}
                className="flex size-5 items-center justify-center rounded-md text-sidebar-action-icon hover:bg-sidebar-item-active hover:text-sidebar-item-active-foreground"
              >
                <RefreshCw size={14} strokeWidth={2} />
              </button>
            </Tip>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 文件树 root 加载失败占位。device-too-old = 对方设备版本过旧(老被控端没有
 * remote-op channel,能力全有全无),提示升级;其余给通用失败 + 重试。
 */
function TreeLoadErrorPlaceholder({
  kind,
  onRetry,
}: {
  kind: 'device-too-old' | 'load-failed';
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <span className="text-12 text-[var(--text-tertiary)]">
        {t(
          kind === 'device-too-old'
            ? 'rightSidebar.fileBrowser.deviceTooOld'
            : 'rightSidebar.fileBrowser.loadFailed',
        )}
      </span>
      {kind === 'load-failed' && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md px-2 py-1 text-12 text-sidebar-action-icon hover:bg-sidebar-item-active hover:text-sidebar-item-active-foreground"
        >
          {t('ccAgent.workdirBrowse.treeAction.refresh')}
        </button>
      )}
    </div>
  );
}

function NoWorkdirPlaceholder() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--surface-elevated)]">
        <FolderX size={20} strokeWidth={1.5} className="text-[var(--text-tertiary)]" />
      </div>
      <span className="text-12 text-[var(--text-tertiary)]">
        {t('rightSidebar.fileBrowser.noWorkdir')}
      </span>
    </div>
  );
}
