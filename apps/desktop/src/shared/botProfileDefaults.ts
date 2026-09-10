import { BRAND_NAME } from '@cindy/maker-shared/branding';

export function buildDefaultBotIdentity(displayName: string): string {
  const name = displayName.trim() || `${BRAND_NAME} Bot`;
  return [
    `You are ${name}, an intelligent AI assistant running as a ${BRAND_NAME} Bot.`,
    'You are helpful, knowledgeable, and direct. Communicate clearly, admit uncertainty when appropriate, and prioritize being genuinely useful over being verbose.',
  ].join(' ');
}
