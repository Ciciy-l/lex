/** Apply only a matching host acknowledgement while the captured page/owner is current. */
export async function deleteRemoteMessageConfirmed(input: {
  sessionId: string;
  clientId: string;
  send(): Promise<unknown>;
  isCurrent(): boolean;
  apply(clientIds: string[]): void;
}): Promise<boolean> {
  if (!input.isCurrent()) return false;
  const value = await input.send();
  if (!input.isCurrent()) return false;
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!result || result.sessionId !== input.sessionId || result.clientId !== input.clientId) {
    throw new Error('Invalid message deletion acknowledgement');
  }
  if (result.clientIds !== undefined && (!Array.isArray(result.clientIds)
    || result.clientIds.some(id => typeof id !== 'string' || !id))) {
    throw new Error('Invalid message deletion acknowledgement');
  }
  const ids = result.clientIds === undefined ? [result.clientId as string] : result.clientIds as string[];
  input.apply([...new Set(ids)]);
  return true;
}
