/**
 * #5788:插件 errand 派活走 sendToSessionInternal 的 lazy-resume 时,必须按会话落库的
 * 权限档恢复,不能落到 main 侧通路的缺省 bypass。否则插件任务被提权,errand 复用判定也会
 * 因活跃会话的档位(bypass)≠ 任务设置的档位而每轮失败、另开新会话。
 *
 * 这项决定由宿主显式传入的策略参数承载;`sourcePlugin` 只是来源标签,不能当权限判据
 * (docs/product-rules/message-source.md)。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const registerSource = readFileSync(resolve(__dirname, '..', 'register.ts'), 'utf8').replace(
  /\r\n?/g,
  '\n',
);

function lazyResumeCreateOpts(): string {
  const start = registerSource.indexOf('async function sendToSessionInternal(params: {');
  const resume = registerSource.indexOf("lockStage = 'lazy-resume-bootstrap';", start);
  const end = registerSource.indexOf('await synthesizeOrcaVendorOptionsFromDb(targetSessionId, createOpts);', resume);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(resume).toBeGreaterThan(start);
  expect(end).toBeGreaterThan(resume);
  return registerSource.slice(resume, end);
}

describe('sendToSessionInternal lazy-resume permission mode', () => {
  it('restores the stored permission mode when the host asks for it', () => {
    expect(lazyResumeCreateOpts()).toContain(
      `permissionMode: params.resumeWithStoredPermissionMode || params[ORCA_NATIVE_BODY]
            ? permissionModeOrAsk(dbRow.permissionMode)
            : 'bypassPermissions',`,
    );
  });

  it('does not derive the permission decision from the source label', () => {
    const opts = lazyResumeCreateOpts();
    expect(opts).not.toMatch(/^\s*permissionMode: 'bypassPermissions',$/m);
    expect(opts).not.toMatch(/permissionMode:[^\n]*sourcePlugin/);
  });

  it('has the Ghost errand dispatch request the stored permission mode', () => {
    const runner = registerSource.indexOf('createGhostErrandRunner({');
    const dispatch = registerSource.indexOf('dispatch: async ({ targetSessionId, message }) => {', runner);
    const call = registerSource.indexOf('const r = await sendToSessionInternal({', dispatch);
    const close = registerSource.indexOf('});', call);
    expect(runner).toBeGreaterThanOrEqual(0);
    expect(dispatch).toBeGreaterThan(runner);
    expect(call).toBeGreaterThan(dispatch);
    expect(registerSource.slice(call, close)).toContain('resumeWithStoredPermissionMode: true');
  });

  it('retains plugin-task authorization checks while requesting stored permissions', () => {
    const dispatch = registerSource.indexOf('dispatch: async (pluginId, taskId, clientId, text) => {');
    const end = registerSource.indexOf('await awaitAgentInputQueueSnapshotPersistence(taskId);', dispatch);
    expect(dispatch).toBeGreaterThanOrEqual(0);
    const body = registerSource.slice(dispatch, end);
    expect(body).toContain('resumeWithStoredPermissionMode: true');
    expect(body).toContain('assertPlugin(pluginId)');
    expect(body).toContain('.assertDispatch(pluginId, taskId)');
  });

  it('reads the persisted permission mode in the row snapshot used by lazy resume', () => {
    const sessionsSource = readFileSync(resolve(__dirname, '..', '..', 'localDb', 'ipc', 'sessions.ts'), 'utf8');
    const select = sessionsSource.slice(sessionsSource.indexOf('async function selectSessionRowSnapshot('));
    expect(select.slice(0, select.indexOf('.from(sessions)'))).toContain('permissionMode: sessions.permissionMode,');
  });
});
