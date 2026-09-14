import { describe, expect, it } from 'vitest';
import {
  isOmpApprovalMode,
  isOmpPermissionModeSupported,
  normalizeOmpApprovalMode,
  OMP_APPROVAL_TIERS,
  OMP_FALLBACK_APPROVAL_MODE,
  OMP_PERMISSION_MODES,
  OMP_SUPPORTED_PERMISSION_MODES,
  resolveOmpApprovalMode,
  toOmpApprovalMode,
} from './permission-map.js';

describe('resolveOmpApprovalMode', () => {
  it('maps the three exposed Lex tiers onto the OMP gates', () => {
    expect(resolveOmpApprovalMode('ask')).toMatchObject({
      approvalMode: 'always-ask',
      requested: 'ask',
      matched: true,
    });
    expect(resolveOmpApprovalMode('auto')).toMatchObject({
      approvalMode: 'write',
      matched: true,
    });
    expect(resolveOmpApprovalMode('bypassPermissions')).toMatchObject({
      approvalMode: 'yolo',
      matched: true,
    });
  });

  it('never exposes acceptEdits, default or plan', () => {
    expect(OMP_SUPPORTED_PERMISSION_MODES).not.toContain('acceptEdits');
    expect(OMP_SUPPORTED_PERMISSION_MODES).not.toContain('default');
    expect(OMP_SUPPORTED_PERMISSION_MODES).not.toContain('plan');
    expect(OMP_PERMISSION_MODES.map((mode) => mode.id)).toEqual([
      'ask',
      'auto',
      'bypassPermissions',
    ]);
  });

  it('fails closed to always-ask and never to yolo', () => {
    const hostile: unknown[] = [
      undefined,
      null,
      '',
      'acceptEdits',
      'default',
      'plan',
      'YOLO',
      'yolo ',
      0,
      {},
      [],
      Symbol('ask'),
    ];
    for (const value of hostile) {
      const resolution = resolveOmpApprovalMode(value);
      expect(resolution.approvalMode).toBe('always-ask');
      expect(resolution.approvalMode).not.toBe('yolo');
      expect(resolution.matched).toBe(false);
    }
    expect(resolveOmpApprovalMode(undefined).requested).toBeUndefined();
    expect(resolveOmpApprovalMode('nonsense').requested).toBe('nonsense');
  });

  it('documents the read-tier auto-approval honestly in every descriptor', () => {
    for (const mode of OMP_PERMISSION_MODES) {
      expect(mode.description ?? '').toContain('auto-approved');
    }
    // OMP 在**任何**档位都自动放行 read tier —— 不能宣称"每个工具都问"。
    for (const tier of Object.values(OMP_APPROVAL_TIERS)) {
      expect(tier.read).toBe(true);
    }
    expect(OMP_APPROVAL_TIERS['always-ask'].write).toBe(false);
    expect(OMP_APPROVAL_TIERS['always-ask'].exec).toBe(false);
    expect(OMP_APPROVAL_TIERS.write.exec).toBe(false);
    expect(OMP_APPROVAL_TIERS.yolo.exec).toBe(true);
  });
});

describe('permission-map helpers', () => {
  it('toOmpApprovalMode keeps the fail-closed contract', () => {
    expect(toOmpApprovalMode('bypassPermissions')).toBe('yolo');
    expect(toOmpApprovalMode('unknown')).toBe(OMP_FALLBACK_APPROVAL_MODE);
  });

  it('normalizeOmpApprovalMode rejects anything but an OMP gate', () => {
    expect(normalizeOmpApprovalMode('yolo')).toBe('yolo');
    expect(normalizeOmpApprovalMode('nope')).toBe('always-ask');
    expect(normalizeOmpApprovalMode(undefined)).toBe('always-ask');
  });

  it('guards the mode predicates', () => {
    expect(isOmpApprovalMode('write')).toBe(true);
    expect(isOmpApprovalMode('always-ask')).toBe(true);
    expect(isOmpApprovalMode('ask')).toBe(false);
    expect(isOmpApprovalMode(42)).toBe(false);
    expect(isOmpPermissionModeSupported('ask')).toBe(true);
    expect(isOmpPermissionModeSupported('acceptEdits')).toBe(false);
  });
});
