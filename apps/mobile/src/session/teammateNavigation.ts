import { resolveRemoteText } from '@cindy/device-link';
import type { HostedRemoteCollectionItem } from '@/device-link/remoteResources';

/** Stable host-local roster ordering used by group creation and member editing. */
export function orderedTeammates(
  rows: readonly HostedRemoteCollectionItem[],
  query: string,
  locale: string,
): HostedRemoteCollectionItem[] {
  const needle = query.normalize('NFKC').trim().toLocaleLowerCase(locale);
  return rows
    .filter((row) => row.item.ref.collectionId === 'teammates' && row.item.ref.kind === 'bot')
    .filter((row) => !needle || resolveRemoteText(row.item.display.title, locale).normalize('NFKC').toLocaleLowerCase(locale).includes(needle));
}
