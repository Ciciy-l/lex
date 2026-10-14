/** Serialize supplier identity allocation and secret/config publication across
 * suppliers. A catalog refresh inside a mutation must not migrate again. */
let tail: Promise<void> = Promise.resolve();
let pending = 0;

export function providerStorageMutationPending(): boolean {
  return pending > 0;
}

export async function withProviderStorageMutation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = tail;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  tail = previous.catch(() => undefined).then(() => gate);
  pending += 1;
  try {
    await previous.catch(() => undefined);
    return await operation();
  } finally {
    pending -= 1;
    release();
  }
}
