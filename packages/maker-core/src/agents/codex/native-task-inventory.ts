function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Project a genuine inventory page without replacing its pagination contract.
 * The owning task supplies visibility; sharing an app-server grants no access. */
export function projectCodexNativeTaskInventory(page: unknown, owns: (threadId: string) => boolean): unknown {
  if (!record(page) || !Array.isArray(page.data)) throw new Error('Native task list is invalid');
  return { ...page, data: page.data.filter(row => {
    const id = typeof row === 'string' ? row : record(row) ? row.id : undefined;
    return typeof id === 'string' && owns(id);
  }) };
}
