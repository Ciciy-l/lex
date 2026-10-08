import { describe, expect, it, vi } from 'vitest';
import { createSharedTaskApi, SharedTaskScopeChangedError } from '../sharedTaskApi.js';

const snapshot = () => ({
  sharedTaskId: 'sharedTask', sessionId: 'session', ownerAccountId: 'owner', hostDeviceId: 'desktop',
  revision: 2, status: 'active', title: 'Task', guests: [{
    memberId: 'member', accountId: 'guest', deviceIds: ['phone'], version: 1, displayName: 'Guest', joinedAt: 1,
  }],
});
function setup() {
  let generation = 1;
  const request = vi.fn<(path: string, options: unknown) => Promise<unknown>>();
  const api = createSharedTaskApi({ request, captureScope: () => {
    const captured = generation;
    return { isCurrent: () => captured === generation };
  } });
  return { api, request, changeAccountOrRegion: () => { generation++; } };
}

describe('shared task management client', () => {
  it('observes a late create ID for host cleanup but never returns stale UI success', async () => {
    const { api, request, changeAccountOrRegion } = setup();
    const observed = vi.fn();
    request.mockImplementation(async () => { changeAccountOrRegion(); return { sharedTaskId: 'sharedTask', revision: 1 }; });
    await expect(api.create('session', 'Task', observed)).rejects.toBeInstanceOf(SharedTaskScopeChangedError);
    expect(observed).toHaveBeenCalledExactlyOnceWith('sharedTask');
  });
  it('bounds long titles without changing local title source or splitting a surrogate pair', async () => {
    const { api, request } = setup();
    const title = 'x'.repeat(127) + '😀';
    request.mockResolvedValue({ sharedTaskId: 'sharedTask', revision: 1 });
    await api.create('session', title);
    expect(request.mock.calls[0][1]).toEqual(expect.objectContaining({ body: { sessionId: 'session', title: 'x'.repeat(127) } }));
    request.mockResolvedValue({ ...snapshot(), title: 'x'.repeat(128) });
    await expect(api.get('sharedTask')).resolves.toEqual(expect.objectContaining({ title: 'x'.repeat(128) }));
  });
  it('keeps invitations in POST bodies and validates response scope', async () => {
    const { api, request } = setup();
    const invitation = 'x'.repeat(43);
    request.mockResolvedValue({ sharedTaskId: 'sharedTask', memberId: 'member', status: 'joined', created: true });
    await expect(api.join(invitation, 'Guest')).resolves.toMatchObject({ status: 'joined' });
    expect(request).toHaveBeenCalledWith('/api/device-link/shared-tasks/join', expect.objectContaining({ method: 'POST', body: { invitation, displayName: 'Guest' } }));
    expect(request.mock.calls[0][0]).not.toContain(invitation);
    request.mockResolvedValue({ ...snapshot(), sharedTaskId: 'other' });
    await expect(api.get('sharedTask')).rejects.toThrow('scope mismatch');
  });
  it('projects authority separately from display labels and rejects duplicates', async () => {
    const { api, request } = setup();
    request.mockResolvedValue(snapshot());
    const detail = await api.get('sharedTask');
    expect(detail.guests[0]).not.toHaveProperty('displayName');
    expect(detail.memberLabels).toEqual([{ memberId: 'member', displayName: 'Guest', joinedAt: 1 }]);
    request.mockResolvedValue({ sharedTasks: [snapshot(), snapshot()] });
    await expect(api.list()).rejects.toThrow('Duplicate');
  });
  it('rejects already-invalid scopes and late authority replies', async () => {
    const invalidRequest = vi.fn();
    const invalidApi = createSharedTaskApi({ request: invalidRequest, captureScope: () => ({ isCurrent: () => false }) });
    await expect(invalidApi.close('sharedTask')).rejects.toBeInstanceOf(SharedTaskScopeChangedError);
    expect(invalidRequest).not.toHaveBeenCalled();
    const { api, request, changeAccountOrRegion } = setup();
    request.mockImplementation(async () => { changeAccountOrRegion(); return snapshot(); });
    await expect(api.get('sharedTask')).rejects.toBeInstanceOf(SharedTaskScopeChangedError);
  });
});
