import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const route = readFileSync(resolve(__dirname, '../features/cc-agent/NewMakerDraftRoute.tsx'), 'utf8');
const view = readFileSync(resolve(__dirname, '../features/cc-agent/CCAgentSessionView.tsx'), 'utf8');
const handler = route.slice(route.indexOf('const handleDraftPresentation ='), route.indexOf('/**', route.indexOf('const handleDraftPresentation =')));

describe('new-task native entry', () => {
  it('persists the ordinary unnamed task and routes an owner-bound TUI intent without sending or titling', () => {
    expect(handler.indexOf('markSendInFlight(true)')).toBeLessThan(handler.indexOf('await vendorAuthGate.checkAndConfirm'));
    expect(handler).toContain('id: localDraftSessionIdRef.current');
    expect(handler).toContain('workspaceKind: effectiveWorkingDir ?');
    expect(handler).toContain('isDataOwnerGenerationCurrent(owner)');
    expect(handler).toContain('nativePresentation: { sessionId: newSession.id, ownerId: dataOwnerId }');
    expect(handler).not.toMatch(/sendMessage|setPending|emitAutoTitle|generateSessionTitle|maker\.createSession/);
    expect(view).toContain('const nativePresentationIntent = navState?.nativePresentation');
    expect(view).toContain('initialMode: nativePresentationIntent && !!sessionId');
    expect(view).toContain('nativePresentationIntent.sessionId === sessionId');
    expect(view).toContain('nativePresentationIntent.ownerId !== undefined');
    expect(view).toContain('nativePresentationIntent.ownerId === dataOwnerId');
  });

  it('keeps composer contents and selected runtime settings while leaving unsupported workspace modes alone', () => {
    expect(handler).toContain('rehomeDraftAttachments(composer.attachments, newSession.id)');
    expect(handler).toContain('saveComposerDraft(newSession.id, { ...composer,');
    expect(handler.indexOf('saveComposerDraft(newSession.id')).toBeLessThan(handler.indexOf('clearComposerDraftAndNotify'));
    for (const setting of ['effectiveFastMode', 'effectivePlanMode', 'chatInitialPermissionMode', 'chatInitialProviderId', 'effectiveExtraDirs', 'effectiveWritableDirs']) {
      expect(handler).toContain(setting);
    }
    const eligibility = route.slice(route.indexOf('const canShowDraftNative ='), route.indexOf('const handleDraftPresentation ='));
    for (const guard of ['!isDeviceLinkDraft', '!isRemoteProjectDraft', '!effectiveRemoteHostId', '!effectiveCollab.enabled', '!wtEnabled', '!!draftInitialModel', '!showProviderOnboardingCard']) expect(eligibility).toContain(guard);
    expect(eligibility).toContain('const canOpenDraftNative = canShowDraftNative && hasLocalNativePresentation(persistedAgentKind)');
    expect(handler).toContain("if (mode !== 'tui' || !canOpenDraftNative || sendInFlightRef.current) return");
    expect(route).toContain('{canShowDraftNative && (');
    expect(route).toContain('disabled={nativeDraftOpening}');
    expect(route).toContain('<AgentPresentationSwitch mode="gui"');
  });
});
