import { resolveSystemLocale } from './locale';

/** Translation targets are independent of the app's UI locale catalogue. */
export const SCREENSHOT_TRANSLATION_LANGUAGES = [
  'zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'it',
  'pt-PT', 'pt-BR', 'ru', 'ar', 'hi', 'th', 'vi', 'id', 'ms', 'tr', 'nl', 'pl', 'uk',
  'sv', 'da', 'fi', 'nb', 'el', 'he', 'cs', 'ro', 'hu',
] as const;

export type ScreenshotTranslationLanguage = (typeof SCREENSHOT_TRANSLATION_LANGUAGES)[number];
export type ScreenshotTranslationPreference = ScreenshotTranslationLanguage | 'ui';

export function isScreenshotTranslationLanguage(value: unknown): value is ScreenshotTranslationLanguage {
  return typeof value === 'string' && (SCREENSHOT_TRANSLATION_LANGUAGES as readonly string[]).includes(value);
}

export function isScreenshotTranslationPreference(value: unknown): value is ScreenshotTranslationPreference {
  return value === 'ui' || isScreenshotTranslationLanguage(value);
}

export function resolveScreenshotTranslationLanguage(preference: unknown, uiLocale: string): ScreenshotTranslationLanguage {
  if (isScreenshotTranslationLanguage(preference)) return preference;
  try {
    const parsed = new Intl.Locale(uiLocale.replace(/_/g, '-'));
    const exact = parsed.toString();
    if (isScreenshotTranslationLanguage(exact)) return exact;
    if (parsed.language === 'zh') {
      return parsed.script === 'Hant' || ['tw', 'hk', 'mo'].includes(parsed.region?.toLowerCase() ?? '')
        ? 'zh-TW' : 'zh-CN';
    }
    if (parsed.language === 'pt') {
      return parsed.region?.toUpperCase() === 'BR' ? 'pt-BR' : 'pt-PT';
    }
    const language = screenshotTranslationCultureLanguage(parsed.language);
    if (language) return language;
  } catch { /* fall through to Lex's UI locale */ }
  return resolveSystemLocale(uiLocale);
}

function screenshotTranslationCultureLanguage(language: string): ScreenshotTranslationLanguage | null {
  return SCREENSHOT_TRANSLATION_LANGUAGES.find((candidate) => candidate.toLowerCase() === language) ?? null;
}

export function screenshotTranslationLanguageName(language: ScreenshotTranslationLanguage, locale: string): string {
  // Script names distinguish Simplified / Traditional, rather than naming countries.
  const tag = language === 'zh-CN' ? 'zh-Hans' : language === 'zh-TW' ? 'zh-Hant' : language;
  let displayLocale = resolveSystemLocale(locale);
  try { displayLocale = new Intl.Locale(locale).toString() as typeof displayLocale; } catch { /* keep UI locale */ }
  return new Intl.DisplayNames([displayLocale], { type: 'language' }).of(tag) ?? tag;
}
