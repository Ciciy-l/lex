export const BOT_MESSAGE_TIME_GROUP_MS = 5 * 60 * 1_000;

export interface BotTimelineMessage {
  clientId: string;
  createdAt?: string | number | null;
}

function timestampOf(value: BotTimelineMessage['createdAt']): number | null {
  const timestamp = typeof value === 'number' ? value : Date.parse(value ?? '');
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

/** Return the first visible message timestamp for each five-minute group. */
export function collectBotMessageTimeGroups(
  messages: readonly BotTimelineMessage[],
  windowMs = BOT_MESSAGE_TIME_GROUP_MS,
): ReadonlyMap<string, number> {
  const groups = new Map<string, number>();
  let groupStartTimestamp: number | null = null;
  for (const message of messages) {
    const timestamp = timestampOf(message.createdAt);
    if (timestamp === null) continue;
    if (groupStartTimestamp === null || timestamp - groupStartTimestamp >= windowMs) {
      groups.set(message.clientId, timestamp);
      groupStartTimestamp = timestamp;
    }
  }
  return groups;
}

function isSameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

export function formatBotMessageGroupTime(timestamp: number, locale: string, now = Date.now()): string {
  const value = new Date(timestamp);
  const current = new Date(now);
  const dateFields: Intl.DateTimeFormatOptions = isSameLocalDay(value, current)
    ? {}
    : value.getFullYear() === current.getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { year: 'numeric', month: 'short', day: 'numeric' };
  return new Intl.DateTimeFormat(locale, { ...dateFields, hour: '2-digit', minute: '2-digit' }).format(value);
}
