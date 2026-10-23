import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

/** Filesystem-safe, collision-resistant namespace; wire IDs are never changed. */
export function mobileStorageNamespace(accountKey: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(accountKey)));
}
