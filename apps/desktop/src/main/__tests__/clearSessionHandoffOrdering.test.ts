/**
 * `/clear` 事务的先后契约:普通路径先立墓碑再落 cleared_at,最后在 finally
 * 封 clear 边界;native 路径先完成 journal tombstone,再发布队列投影。
 *
 * 事务体由 INPUT_CLEAR_SESSION 与 Orca context_policy=clear 共用
 * hostSessionClearService.ts;register.ts 只保留 receipts/参数校验/错误映射。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const registerSource = readFileSync(
  resolve(__dirname, '..', 'maker-ipc', 'register.ts'),
  'utf8',
).replace(/\r\n?/g, '\n');
const serviceSource = readFileSync(
  resolve(__dirname, '..', 'maker-ipc', 'hostSessionClearService.ts'),
  'utf8',
).replace(/\r\n?/g, '\n');

describe('/clear:墓碑 → cleared_at 落库 → 封 clear 边界', () => {
  const handlerStart = registerSource.indexOf('MAKER_INVOKE.INPUT_CLEAR_SESSION');
  const handlerEnd = registerSource.indexOf('MAKER_INVOKE.ABORT_SESSION', handlerStart);
  const handler = registerSource.slice(handlerStart, handlerEnd);

  it('the IPC handler delegates to the shared host clear transaction', () => {
    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(handler).toContain('const clearService = hostSessionClearHolder');
    expect(handler).toContain('await clearService.clearSession(sid, {');
    expect(handler).toContain("receipt.status = 'failed'");
    expect(handler).toContain("receipt.applied = true");
  });

  it('ordinary clear places the tombstone before the durable boundary', () => {
    const projectionAt = serviceSource.indexOf(
      'const projection = deps.clearInputProjection(sessionId, clearBoundary);',
    );
    const ordinaryEnd = serviceSource.indexOf('nativeClear.executor', projectionAt);
    const ordinary = serviceSource.slice(projectionAt, ordinaryEnd);
    expect(projectionAt).toBeGreaterThan(-1);
    const tombstoneAt = ordinary.indexOf('deps.invalidateAgentHandoff(sessionId)');
    const persistAt = ordinary.indexOf(
      'await deps.clearSessionContextInDb(sessionId, clearBoundaryMs)',
    );
    expect(tombstoneAt).toBeGreaterThan(-1);
    expect(persistAt).toBeGreaterThan(tombstoneAt);
    const finallyAt = serviceSource.indexOf('} finally {', projectionAt);
    const sealAt = serviceSource.indexOf(
      'deps.sealAgentHandoffClearBoundary(sessionId)',
      finallyAt,
    );
    expect(finallyAt).toBeGreaterThan(persistAt);
    expect(sealAt).toBeGreaterThan(finallyAt);
  });

  it('ordinary failures stay best-effort; native failures wait for tombstone before projection', () => {
    const projectionAt = serviceSource.indexOf(
      'const projection = deps.clearInputProjection(sessionId, clearBoundary);',
    );
    const ordinaryEnd = serviceSource.indexOf('nativeClear.executor', projectionAt);
    const ordinary = serviceSource.slice(projectionAt, ordinaryEnd);
    expect(ordinary).toContain('deps.logError(');
    expect(ordinary).not.toContain('HostSessionClearError(');
    expect(serviceSource).toContain('await deps.withNativeHistoryClear(nativeClear, at, async (guard) => {');
    expect(serviceSource).toContain('if (committed) {');
    expect(serviceSource).toContain("throw new HostSessionClearError(");
    // The native projection runs after the journal transaction resolves, not
    // inside its commit callback.
    const nativeAt = serviceSource.indexOf('await deps.withNativeHistoryClear(nativeClear, at, async (guard) => {');
    const nativeProjectionAt = serviceSource.indexOf('const projection = finishProjection(boundaryMs);', nativeAt);
    expect(nativeProjectionAt).toBeGreaterThan(nativeAt);
    expect(serviceSource.slice(nativeAt, nativeProjectionAt)).not.toContain(
      'clearInputProjection(sessionId',
    );
  });
});
