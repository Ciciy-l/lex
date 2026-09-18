import { describe, expect, it, vi } from 'vitest';

import { createLiziMcpProviders } from '../providers.js';
import type { OrcaMcpDeps } from '../orca/server.js';
import type { LiziMcpSessionContext } from '../types.js';

function createDeps(overrides: Partial<OrcaMcpDeps> = {}): OrcaMcpDeps {
  return {
    startTeam: vi.fn(async () => ({
      ok: true as const,
      teamId: 'team-1',
      workerPermissionMode: 'auto' as const,
    })),
    createWorker: vi.fn(async () => ({
      ok: true as const,
      workerId: 'worker-1',
      workerSessionId: 'worker-session-1',
    })),
    listWorkers: vi.fn(async () => ({ ok: true as const, workers: [] })),
    switchFocus: vi.fn(async () => ({ ok: true as const, workerId: 'worker-1' })),
    sendToWorker: vi.fn(async () => ({
      ok: true as const,
      agentKind: 'omp' as const,
      wakeKind: 'already-active' as const,
      targetTitle: null,
      targetLastUserSendAt: null,
    })),
    interruptWorker: vi.fn(async () => ({
      ok: true as const,
      agentKind: 'omp' as const,
      queuedMessageId: 'queued-1',
      stopOutcome: 'requested' as const,
      queuePaused: false,
    })),
    listWorkerQueuedMessages: vi.fn(async () => ({
      ok: true as const,
      workerId: 'worker-1',
      workerSessionId: 'worker-session-1',
      status: 'running',
      isWorking: true,
      willQueue: true,
      queuePaused: false,
      messages: [],
    })),
    updateWorkerQueuedMessage: vi.fn(async () => ({
      ok: true as const,
      workerId: 'worker-1',
      queuedMessageId: 'queued-1',
    })),
    cancelWorkerQueuedMessage: vi.fn(async () => ({
      ok: true as const,
      workerId: 'worker-1',
      queuedMessageId: 'queued-1',
    })),
    mergeWorkerQueuedMessages: vi.fn(async () => ({
      ok: true as const,
      workerId: 'worker-1',
      queuedMessageId: 'queued-1',
      messages: [],
    })),
    idleWorker: vi.fn(async () => ({ ok: true as const, workerId: 'worker-1' })),
    endTeam: vi.fn(async () => ({ ok: true as const })),
    archiveWorker: vi.fn(async () => ({ ok: true as const, workerId: 'worker-1' })),
    listAvailableModels: vi.fn(async () => ({ ok: true as const })),
    getWorkspaceInfo: vi.fn(async () => ({
      ok: true as const,
      workflow: null,
      ui_capacity: 1,
      worker_count: 0,
      workers: [],
    })),
    getWorkerStatus: vi.fn(async () => ({
      ok: true as const,
      worker_id: 'worker-1',
      session_id: 'worker-session-1',
      status: 'done',
      session_status: 'not_running',
      idle_ms: 0,
      restored_from_storage: false,
    })),
    readWorker: vi.fn(async () => ({
      ok: true as const,
      worker_id: 'worker-1',
      session_id: 'worker-session-1',
      status: 'done',
      session_status: 'not_running',
      idle_ms: 0,
      restored_from_storage: false,
      result: 'done',
    })),
    ...overrides,
  };
}

function createOmpOrcaTools(
  deps: OrcaMcpDeps,
  overrides: Partial<LiziMcpSessionContext> = {},
) {
  const provider = createLiziMcpProviders({
    enabled: ['cindy_orca'],
    orca: deps,
  }).find((candidate) => candidate.name === 'cindy_orca');
  if (!provider?.toOmpRpcHostTools) throw new Error('Missing OMP Orca provider adapter');
  const tools = provider.toOmpRpcHostTools({
    agentKind: 'omp',
    workingDir: 'C:/repo',
    sessionId: 'lead-1',
    vendorOptions: { orcaRole: 'lead' },
    ...overrides,
  });
  if (tools === null) throw new Error('OMP Orca provider unexpectedly unavailable');
  return tools;
}

function payload(result: { content: readonly { type: 'text'; text: string }[] }) {
  return JSON.parse(result.content[0]!.text);
}

describe('cindy_orca OMP host-tool adapter', () => {
  it('projects the same complete, strict 18-tool Orca manifest for an OMP Lead', () => {
    const tools = createOmpOrcaTools(createDeps());

    expect(tools.map((tool) => tool.name)).toEqual([
      'start_team',
      'create_worker',
      'create_workers',
      'list_workers',
      'switch_focus',
      'send_to_worker',
      'interrupt_worker',
      'get_worker_queue_status',
      'update_queued_message',
      'cancel_queued_message',
      'merge_queued_messages',
      'idle_worker',
      'end_team',
      'archive_worker',
      'list_available_models',
      'get_workspace_info',
      'worker_status',
      'read_worker',
    ]);
    expect(tools.find((tool) => tool.name === 'start_team')?.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    for (const tool of tools) {
      expect(tool.description).not.toMatch(/[\u0000-\u001f\u007f]/u);
      expect(new TextEncoder().encode(JSON.stringify(tool.parameters)).byteLength).toBeLessThanOrEqual(
        64 * 1024,
      );
    }
  });

  it('uses the existing Lead handler and preserves its structured result', async () => {
    const deps = createDeps();
    const startTeam = createOmpOrcaTools(deps, { vendorOptions: {} }).find(
      (tool) => tool.name === 'start_team',
    );
    if (!startTeam) throw new Error('Missing start_team tool');

    const result = await startTeam.execute({}, { signal: new AbortController().signal });
    expect(payload(result)).toMatchObject({
      ok: true,
      team_id: 'team-1',
      worker_permission_mode: 'auto',
    });
    expect(deps.startTeam).toHaveBeenCalledWith({ leadSessionId: 'lead-1' });
  });

  it('observes a live OMP Lead promotion through the same host-tool context reference', async () => {
    const deps = createDeps();
    const vendorOptions: Record<string, unknown> = {};
    const tools = createOmpOrcaTools(deps, { vendorOptions });
    const startTeam = tools.find((tool) => tool.name === 'start_team');
    const endTeam = tools.find((tool) => tool.name === 'end_team');
    if (!startTeam || !endTeam) throw new Error('Missing OMP Orca control tool');

    await startTeam.execute({}, { signal: new AbortController().signal });
    // OmpSessionHandle.setVendorOptions performs this host-owned in-place
    // update after start_team succeeds. The registered OMP tool objects must
    // retain this reference rather than the ordinary-session snapshot.
    Object.assign(vendorOptions, {
      orcaRole: 'lead',
      orcaWorkflowId: 'team-1',
      orcaLeadSessionId: 'lead-1',
    });
    const result = await endTeam.execute({}, { signal: new AbortController().signal });

    expect(payload(result)).toMatchObject({ ok: true });
    expect(deps.endTeam).toHaveBeenCalledWith({ leadSessionId: 'lead-1' });
  });

  it('keeps the existing role and strict-argument gates for OMP', async () => {
    const deps = createDeps();
    const workerStart = createOmpOrcaTools(deps, {
      vendorOptions: { orcaRole: 'worker' },
    }).find((tool) => tool.name === 'start_team');
    const leadStart = createOmpOrcaTools(deps).find((tool) => tool.name === 'start_team');
    if (!workerStart || !leadStart) throw new Error('Missing start_team tool');

    const workerResult = await workerStart.execute({}, { signal: new AbortController().signal });
    const invalidResult = await leadStart.execute(
      { unexpected: true },
      { signal: new AbortController().signal },
    );

    expect(payload(workerResult)).toMatchObject({
      ok: false,
      errorCode: 'WORKER_CANNOT_NEST',
    });
    expect(payload(invalidResult)).toMatchObject({
      ok: false,
      errorCode: 'INVALID_ARGS',
    });
    expect(deps.startTeam).not.toHaveBeenCalled();
  });

  it('does not dispatch an already-cancelled host-tool call', async () => {
    const deps = createDeps();
    const startTeam = createOmpOrcaTools(deps).find((tool) => tool.name === 'start_team');
    if (!startTeam) throw new Error('Missing start_team tool');
    const controller = new AbortController();
    controller.abort();

    const result = await startTeam.execute({}, { signal: controller.signal });

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0]?.text).toContain('cancelled');
    expect(deps.startTeam).not.toHaveBeenCalled();
  });
});
