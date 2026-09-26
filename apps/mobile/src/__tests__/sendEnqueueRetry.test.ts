import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * enqueue 弱网重试的写序边界(codex review P1 + auto-review P1 回归锚点):
 * - NOT_CONNECTED 不保证未送达——断连时 in-flight invoke 会被 failAllPending 批量
 *   reject 成 NOT_CONNECTED(请求可能已出、ack 丢失);
 * - BACKPRESSURE 要么在本地发送前拒绝,要么由被控端 admission 明确拒绝执行;
 * - projection 也无法证明未入队——空闲 agent 下 enqueue-immediate 会把消息瞬间
 *   slice 进 activeTurn,pendingQueue 里查不到;
 */
describe('send enqueue weak-network retry ordering', () => {
  const source = readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');
  const durableDelivery = readFileSync(resolve(process.cwd(), 'src/session/durableOutboxDelivery.ts'), 'utf8');

  /**
   * 提取仍在页面内进行的直接 enqueue 弱网重试循环。Durable outbox 的不确定
   * 结果由 app-level receipt reconciliation 按同一 clientId 收敛，不做新消息重发。
   */
  const LOOP_MARKER = 'for (let attempt = 0; ; attempt++) {';
  const extractRetryLoops = (): string[] => {
    const loops: string[] = [];
    for (let from = source.indexOf(LOOP_MARKER); from > -1; from = source.indexOf(LOOP_MARKER, from + 1)) {
      const endMatch = /remoteSessionStore\.setInputProjectionIfCurrent\(\s*[^,]+,\s*projection,\s*projectionEpochAtRequestStart,\s*projectionRemoteEpochAtRequestStart,\s*queued\.clientId,\s*\);/.exec(source.slice(from));
      expect(endMatch).not.toBeNull();
      loops.push(source.slice(from, from + (endMatch?.index ?? 0)));
    }
    return loops;
  };

  it('重试门槛必须要求可安全重发的传输错误且非 in-flight(send 与 outbox 两条路径)', () => {
    expect(source).toContain("import { isInFlightDeviceLinkError } from '@cindy/device-link';");
    expect(source).toContain("code === 'NOT_CONNECTED' || code === 'BACKPRESSURE'");
    expect(source).toContain("formatted.includes('[BACKPRESSURE]')");
    const loops = extractRetryLoops();
    expect(loops).toHaveLength(1);
    for (const loopBody of loops) {
      expect(loopBody).toContain('|| isInFlightDeviceLinkError(err)');
      expect(loopBody).toContain('|| !isRetryableEnqueueTransportError(err)');
    }
  });

  it('不允许回归为「NOT_CONNECTED 保证未送达」的盲重注释,也不允许用 pendingQueue 对账当放行依据', () => {
    expect(source).not.toContain('被控端不可能收到');
    expect(source).not.toContain('绝不会造成重复入队');
    // 循环内不允许出现「refetch pendingQueue 判未入队 → 放行重发」——activeTurn
    // 不在 projection 里,该判据在空闲 agent 场景必然漏判(auto-review P1)。
    // getProjection 只允许出现在循环结束后的回滚对账段(catch 分支),不得参与重发决策。
    for (const loopBody of extractRetryLoops()) {
      expect(loopBody).not.toContain('getProjection');
    }
    expect(durableDelivery).toContain('enqueueStarted: true');
    expect(durableDelivery).toContain('record.retrySafe && projection.inputDeliveryVersion === 1');
    expect(durableDelivery).toContain('if (state === "removed") return await finish(true);');
    expect(durableDelivery).toContain('state: "failed", error: deps.confirmationMessage');
  });
});
