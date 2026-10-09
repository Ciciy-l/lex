// apksigner uses SDK-range labels for v3/v3.1 signatures and numbered labels
// for older schemes. Only certificate digests count, never public-key digests.
export function verifyAndroidCertificate(output, expected) {
  if (!/^[a-f0-9]{64}$/i.test(expected ?? '')) throw new Error('Invalid pinned Android certificate SHA-256');
  const digests = [...output.matchAll(/^Signer (?:#\d+|\(minSdkVersion=[^\r\n]+\)) certificate SHA-256 digest: ([a-f0-9]{64})\s*$/gim)].map((match) => match[1].toLowerCase());
  if (!digests.length) throw new Error('No signer certificate SHA-256 found in apksigner output');
  if (digests.some((digest) => digest !== expected.toLowerCase())) {
    throw new Error('APK signing certificate does not match the pinned Lex identity');
  }
}
