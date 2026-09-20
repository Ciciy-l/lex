/**
 * Renderer 模块图分发入口。
 *
 * 资源用量窗口、右侧栏独立子窗口与主应用共用同一个受信任 HTML/origin，
 * 但从这里开始加载不同的模块图。判断必须发生在任何主应用静态依赖之前，
 * 否则 ESM 会先执行语音、诊断和设置初始化。
 */
import {
  clearEntryLoadRetry,
  isRetryableViteEntryLoadError,
  reserveEntryLoadRetry,
} from './lib/entryLoadRecovery';

const urlParams = new URLSearchParams(window.location.search);
const isRemoteDesktopViewer = urlParams.get('remoteDesktopViewer') === '1';
const isResourceUsageWindow = urlParams.get('resourceUsageWindow') === '1';
const isSidebarWindow = urlParams.get('sidebarWindow') === '1';
const ghostPanelWindowId = urlParams.get('ghostPanelWindow');

const entryLoad = isRemoteDesktopViewer
  ? import('./remote-desktop-viewer-entry')
  : isResourceUsageWindow
  ? import('./resource-usage-entry')
  : isSidebarWindow
    ? import('./sidebar-window-entry')
    : ghostPanelWindowId
      ? import('./ghost-panel-window-entry')
      : import('./main-entry').then(({ mainEntryReady }) => mainEntryReady);

void entryLoad
  .then(() => {
    if (import.meta.env.DEV) clearEntryLoadRetry(window.sessionStorage);
  })
  .catch((error: unknown) => {
    // A Vite optimize-deps generation can change while Electron Forge is
    // opening this window. Reload once to obtain the current module graph;
    // persistent source errors still reach the normal error report below.
    if (
      import.meta.env.DEV &&
      isRetryableViteEntryLoadError(error) &&
      reserveEntryLoadRetry(window.sessionStorage)
    ) {
      window.electronAPI?.logToMain?.(
        'warn',
        'renderer/entry',
        'Vite dependency prebundle changed during entry load; reloading once.',
      );
      window.setTimeout(() => {
        const recoverViteDependencyLoad = window.electronAPI?.recoverViteDependencyLoad;
        if (recoverViteDependencyLoad) {
          recoverViteDependencyLoad();
          return;
        }
        // Old preloads can appear briefly while the dev process is restarting.
        // Keep their prior bounded retry semantics rather than leaving a blank window.
        window.location.reload();
      }, 1_000);
      return;
    }
    // 入口加载失败发生在 React boundary 之前，仍通过统一 renderer logger 落盘。
    window.electronAPI?.logToMain?.(
      'error',
      'renderer/entry',
      `renderer entry load failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
