

import type { PluginRegistry } from '../maker-host/plugins/plugin-registry.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

/** Preserve the settings catalog, adding actual mount availability only for Bot queries. */
export function registerPluginListHandler(registry: IpcHandlerRegistry, deps: {
  getPluginRegistry: () => Pick<PluginRegistry, 'listPlugins'>;
}): void {
  registry.handle(MAKER_INVOKE.PLUGINS_LIST, async (event, workingDir, includeHidden, botContext) => {
    const wd = typeof workingDir === 'string' ? workingDir : undefined;
    if (botContext === undefined) return deps.getPluginRegistry().listPlugins(wd, includeHidden === true);
    throwIpcError('NOT_FOUND', 'Task does not exist');
  });
}
