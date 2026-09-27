import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { discardMobileUploadedAttachment } from '@/session/mobileAttachmentUpload';

export function discardNewSessionUploadedAttachments(
  attachments: readonly { path?: string }[],
  getToken: () => Promise<string | null>,
): void {
  if (attachments.length === 0) return;
  const ownerAtClear = getMobileAuthOwner();
  let token: Promise<string | null>;
  try { token = getToken().catch(() => null); } catch { return; }
  for (const attachment of attachments) {
    discardMobileUploadedAttachment(attachment, {
      getToken: async () => {
        const captured = await token;
        return isMobileAuthOwnerCurrent(ownerAtClear) ? captured : null;
      },
    });
  }
}
