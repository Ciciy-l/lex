import { describe, expect, it, vi } from 'vitest';
import { createConsoleLogger } from '../../interfaces/logger.js';
import type { AgentEvent, InteractionRequest } from '../../types/events.js';
import type { OmpUiCorrelation, OmpUiResponse } from './rpc-client.js';
import {
  classifyOmpOptions,
  describeOmpApproval,
  OmpPermissionBridge,
  parseOmpUiRequest,
} from './permission-bridge.js';

/** 真实抓帧形态（spike §9.2）：`method: 'select'` + `options: ["Approve","Deny"]`。 */
function selectFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'extension_ui_request',
    id: '157cf60a9ce9ac08',
    method: 'select',
    title: 'Allow tool: write\nPath: hello.txt\nContent:\nhi',
    options: ['Approve', 'Deny'],
    ...overrides,
  };
}

type PermissionAnswer = { kind: 'permission'; behavior: 'allow' | 'deny' };

interface Harness {
  bridge: OmpPermissionBridge;
  written: Array<Record<string, unknown>>;
  events: AgentEvent[];
  setResolver(
    resolver: (request: InteractionRequest) => Promise<{ kind: 'permission'; behavior: 'allow' | 'deny' }>,
  ): void;
  requests: InteractionRequest[];
}

function harness(): Harness {
  const written: Array<Record<string, unknown>> = [];
  const events: AgentEvent[] = [];
  const requests: InteractionRequest[] = [];
  const bridge = new OmpPermissionBridge({
    logger: createConsoleLogger('omp-bridge-test'),
    respond: (id: string, response: OmpUiResponse, correlation?: OmpUiCorrelation) => {
      const payload: Record<string, unknown> = { id, ...response };
      // v18.1.18 的帧没有 requestGeneration，因此这里只有真出现时才记下来，
      // 好让断言能验证「帧里没有就不 echo」。
      if (correlation?.requestGeneration !== undefined) {
        payload.correlation = correlation;
      }
      written.push(payload);
    },
    emit: (event: AgentEvent) => events.push(event),
  });
  return {
    bridge,
    written,
    events,
    requests,
    setResolver(next) {
      bridge.setResolver(async (request) => {
        requests.push(request);
        return next(request);
      });
    },
  };
}

function lastResponse(written: Array<Record<string, unknown>>): Record<string, unknown> {
  return written[written.length - 1] ?? {};
}

/** `toolName` 只存在于 permission kind 上；测试里按 kind 收窄，不做 cast。 */
function toolNameOf(request: InteractionRequest | undefined): string {
  return request?.kind === 'permission' ? request.toolName : '';
}

describe('parseOmpUiRequest', () => {
  it('parses the real select frame captured on device', () => {
    const request = parseOmpUiRequest(selectFrame());
    expect(request).toBeDefined();
    expect(request?.method).toBe('select');
    expect(request?.id).toBe('157cf60a9ce9ac08');
    expect(request?.options).toEqual(['Approve', 'Deny']);
    // v18.1.18 无 requestGeneration（spike §9.2）—— 确认不会凭空造一个出来。
    expect(request?.requestGeneration).toBeUndefined();
  });

  it('fails closed on every malformed variant', () => {
    expect(parseOmpUiRequest(selectFrame({ id: undefined }))).toBeUndefined();
    expect(parseOmpUiRequest(selectFrame({ id: '' }))).toBeUndefined();
    expect(parseOmpUiRequest(selectFrame({ method: undefined }))).toBeUndefined();
    expect(parseOmpUiRequest(selectFrame({ type: 'other' }))).toBeUndefined();
    expect(parseOmpUiRequest(null)).toBeUndefined();
    expect(parseOmpUiRequest([])).toBeUndefined();
  });
});

describe('classifyOmpOptions', () => {
  it('recognizes the captured Approve/Deny pair', () => {
    expect(classifyOmpOptions(['Approve', 'Deny'])).toEqual({
      approve: 'Approve',
      deny: 'Deny',
    });
  });

  it('returns nothing for unrecognized options instead of guessing by position', () => {
    expect(classifyOmpOptions(['Maybe', 'Later'])).toEqual({});
    expect(classifyOmpOptions([])).toEqual({});
    expect(classifyOmpOptions(undefined)).toEqual({});
  });
});

describe('describeOmpApproval', () => {
  it('extracts the tool name and path from the approval title', () => {
    const descriptor = describeOmpApproval('Allow tool: write\nPath: hello.txt\nContent:\nhi');
    expect(descriptor.toolName).toBe('write');
    expect(descriptor.input).toMatchObject({ path: 'hello.txt' });
    expect(descriptor.description).toContain('Path: hello.txt');
  });

  it('degrades to a neutral descriptor when the title is missing', () => {
    expect(describeOmpApproval(undefined).toolName).toBe('unknown');
  });
});

describe('OmpPermissionBridge', () => {
  it('answers a select frame with value "Approve" when the resolver allows', async () => {
    const test = harness();
    test.setResolver(async () => ({ kind: 'permission', behavior: 'allow' }));
    const request = parseOmpUiRequest(selectFrame());
    if (!request) throw new Error('expected a parsed request');
    test.bridge.handleRequest(request);
    await vi.waitFor(() => expect(test.written).toHaveLength(1));
    expect(lastResponse(test.written)).toEqual({ id: '157cf60a9ce9ac08', value: 'Approve' });
    expect(test.requests[0]?.kind).toBe('permission');
    expect(toolNameOf(test.requests[0])).toBe('write');
  });

  it('answers a select frame with value "Deny" when the resolver denies', async () => {
    const test = harness();
    test.setResolver(async () => ({ kind: 'permission', behavior: 'deny' }));
    const request = parseOmpUiRequest(selectFrame());
    if (!request) throw new Error('expected a parsed request');
    test.bridge.handleRequest(request);
    await vi.waitFor(() => expect(test.written).toHaveLength(1));
    expect(lastResponse(test.written)).toEqual({ id: '157cf60a9ce9ac08', value: 'Deny' });
  });

  it('answers a confirm frame with confirmed booleans', async () => {
    const test = harness();
    test.setResolver(async () => ({ kind: 'permission', behavior: 'allow' }));
    const request = parseOmpUiRequest({
      type: 'extension_ui_request',
      id: 'abc',
      method: 'confirm',
      title: 'Allow tool: bash',
    });
    if (!request) throw new Error('expected a parsed request');
    test.bridge.handleRequest(request);
    await vi.waitFor(() => expect(test.written).toHaveLength(1));
    expect(lastResponse(test.written)).toEqual({ id: 'abc', confirmed: true });
  });

  it('never auto-allows: no resolver means cancelled', async () => {
    const test = harness();
    const request = parseOmpUiRequest(selectFrame());
    if (!request) throw new Error('expected a parsed request');
    test.bridge.handleRequest(request);
    await vi.waitFor(() => expect(test.written).toHaveLength(1));
    expect(lastResponse(test.written)).toEqual({ id: '157cf60a9ce9ac08', cancelled: true });
  });

  it('cancels when the resolver throws', async () => {
    const test = harness();
    test.bridge.setResolver(async () => {
      throw new Error('UI surface is gone');
    });
    const request = parseOmpUiRequest(selectFrame());
    if (!request) throw new Error('expected a parsed request');
    test.bridge.handleRequest(request);
    await vi.waitFor(() => expect(test.written).toHaveLength(1));
    expect(lastResponse(test.written)).toEqual({ id: '157cf60a9ce9ac08', cancelled: true });
  });

  it('cancels unknown methods instead of treating them as authorization', async () => {
    const test = harness();
    test.setResolver(async () => ({ kind: 'permission', behavior: 'allow' }));
    for (const method of ['input', 'setWidget']) {
      const request = parseOmpUiRequest({ type: 'extension_ui_request', id: 'z', method });
      if (!request) throw new Error('expected a parsed request');
      test.bridge.handleRequest(request);
    }
    await vi.waitFor(() => expect(test.written).toHaveLength(2));
    expect(test.written.every((entry) => entry.cancelled === true)).toBe(true);
  });

  it('cancels when the approve option cannot be identified (fail-closed)', async () => {
    const test = harness();
    test.setResolver(async () => ({ kind: 'permission', behavior: 'allow' }));
    const request = parseOmpUiRequest(selectFrame({ options: ['Proceed', 'Abort'] }));
    if (!request) throw new Error('expected a parsed request');
    test.bridge.handleRequest(request);
    await vi.waitFor(() => expect(test.written).toHaveLength(1));
    expect(lastResponse(test.written)).toEqual({ id: '157cf60a9ce9ac08', cancelled: true });
  });

  it('allows only one pending interaction; the second is cancelled', async () => {
    const test = harness();
    test.setResolver(async () => ({ kind: 'permission', behavior: 'allow' }));
    const first = parseOmpUiRequest(selectFrame({ id: 'first' }));
    const second = parseOmpUiRequest(selectFrame({ id: 'second' }));
    if (!first || !second) throw new Error('expected parsed requests');
    test.bridge.handleRequest(first);
    test.bridge.handleRequest(second);
    await vi.waitFor(() => expect(test.written).toHaveLength(2));
    const byId = new Map(test.written.map((entry) => [String(entry.id), entry]));
    expect(byId.get('second')).toEqual({ id: 'second', cancelled: true });
    expect(byId.get('first')).toEqual({ id: 'first', value: 'Approve' });
  });

  it('cancels with timedOut and emits interaction_dismissed on timeout', async () => {
    vi.useFakeTimers();
    try {
      const test = harness();
      // 用户一直不作答 —— 这才是超时路径的真实前提。
      test.setResolver(() => new Promise<PermissionAnswer>(() => undefined));
      const request = parseOmpUiRequest(selectFrame({ timeout: 5 }));
      if (!request) throw new Error('expected a parsed request');
      test.bridge.handleRequest(request);
      await vi.advanceTimersByTimeAsync(10);
      expect(lastResponse(test.written)).toEqual({
        id: '157cf60a9ce9ac08',
        cancelled: true,
        timedOut: true,
      });
      expect(test.events.some((event) => event.type === 'interaction_dismissed')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dismissAll denies pending cards, and only allows on an explicit escalation', async () => {
    const denied = harness();
    denied.setResolver(async () => ({ kind: 'permission', behavior: 'allow' }));
    const request = parseOmpUiRequest(selectFrame());
    if (!request) throw new Error('expected a parsed request');
    denied.bridge.handleRequest(request);
    denied.bridge.dismissAll('turn_aborted');
    await vi.waitFor(() => expect(denied.written).toHaveLength(1));
    expect(lastResponse(denied.written)).toEqual({ id: '157cf60a9ce9ac08', cancelled: true });
    expect(denied.events[0]?.data).toMatchObject({ reason: 'turn_aborted', resolvedAs: 'deny' });

    const allowed = harness();
    allowed.setResolver(async () => ({ kind: 'permission', behavior: 'deny' }));
    const second = parseOmpUiRequest(selectFrame());
    if (!second) throw new Error('expected a parsed request');
    allowed.bridge.handleRequest(second);
    allowed.bridge.dismissAll('permission_mode_changed_to_bypassPermissions', 'allow');
    await vi.waitFor(() => expect(allowed.written).toHaveLength(1));
    expect(lastResponse(allowed.written)).toEqual({ id: '157cf60a9ce9ac08', value: 'Approve' });
    expect(allowed.bridge.pendingCount).toBe(0);
  });
});
