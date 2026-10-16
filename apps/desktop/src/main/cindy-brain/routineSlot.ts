/** Preserve the old plugin reply envelope without starting the retired service. */
export async function handleRoutineRequest(..._legacyRequest: unknown[]): Promise<{ ok: false; message: string }> {
  return { ok: false, message: 'Routine service is unavailable' };
}
