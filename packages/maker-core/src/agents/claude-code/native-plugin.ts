import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_NATIVE_BRIDGE_PLUGIN_NAME, CLAUDE_NATIVE_MOD_SOURCE,
  CLAUDE_NATIVE_MEDIA_COMMAND, CLAUDE_NATIVE_MEDIA_PROMPT } from './native-mod-source.js';

/** Per-runtime owned projection, not installed into the user's Claude plugin registry. */
export async function prepareClaudeNativePlugin(): Promise<{ root: string; dispose(): Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lex-claude-bridge-'));
  let disposal: Promise<void> | undefined;
  const dispose = () => disposal ??= fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  try {
    await Promise.all(['.claude-plugin', 'hooks', 'commands'].map((dir) => fs.mkdir(path.join(root, dir))));
    await Promise.all([
      fs.writeFile(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
        name: CLAUDE_NATIVE_BRIDGE_PLUGIN_NAME, version: '1.0.0', description: 'Lex task presentation bridge',
      })),
      fs.writeFile(path.join(root, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.ts'] })),
      fs.writeFile(path.join(root, 'hooks', 'register.ts'), CLAUDE_NATIVE_MOD_SOURCE),
      fs.writeFile(path.join(root, 'commands', CLAUDE_NATIVE_MEDIA_COMMAND + '.md'), CLAUDE_NATIVE_MEDIA_PROMPT),
    ]);
    return { root, dispose };
  } catch (error) { await dispose(); throw error; }
}
