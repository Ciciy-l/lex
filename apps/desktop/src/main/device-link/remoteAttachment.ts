/**
 * Narrow host adapter for controlled Device Link attachment references.
 *
 * G4 only consumes the existing cindy-oss-attach relay contract.  File Peer
 * materialisation remains a separate capability and is intentionally not
 * enabled by this group-chat phase.
 */
import {
  parseAttachmentOssRef,
  type AttachmentIntegrity,
  type AttachmentOssRef,
} from '@cindy/device-link';
import { downloadToFile } from './mediaTransfer.js';

export type RemoteAttachment = AttachmentOssRef;

export function parseRemoteAttachmentRef(value: string): RemoteAttachment | null {
  return parseAttachmentOssRef(value);
}

export async function materializeRemoteAttachment(
  ref: RemoteAttachment,
  destination: string,
  integrity?: AttachmentIntegrity,
): Promise<void> {
  await downloadToFile(ref.ossKey, destination, integrity);
}
