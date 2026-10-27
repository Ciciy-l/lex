/** Application attribution only. Never supplies credentials, originator,
 * account/session identity, endpoint or a guessed native runtime version. */
export function withLexApplicationHeaders(
  input: Readonly<Record<string, string>> | Headers,
  options: { appendNativeUserAgent?: boolean } = {},
): Record<string, string> {
  // Normalize once so a mixed-case explicit override cannot become a second
  // HTTP value. Later entries retain the existing override precedence.
  const entries = input instanceof Headers ? [...input.entries()] : Object.entries(input);
  const names = new Map<string, string>();
  const headers: Record<string, string> = {};
  for (const [name, value] of entries) {
    const lower = name.toLowerCase();
    const previous = names.get(lower);
    if (previous !== undefined) delete headers[previous];
    names.set(lower, name); headers[name] = value;
  }
  if (!names.has('x-title')) headers['X-Title'] = 'Lex';
  const userAgentName = names.get('user-agent');
  if (options.appendNativeUserAgent && userAgentName && headers[userAgentName]) {
    headers[userAgentName] = appendLexUserAgent(headers[userAgentName]);
  }
  return headers;
}

/** A bare product token is truthful when the embedding caller has no build
 * version. The native client retains its own complete version/platform prefix. */
export function appendLexUserAgent(nativeUserAgent: string): string {
  return /(?:^|[\s;(])Lex(?:\/[^\s;)]+)?(?=$|[\s;)])/i.test(nativeUserAgent)
    ? nativeUserAgent : nativeUserAgent + ' Lex';
}

/** Claude's line-based override format. Existing user values remain byte-for-byte
 * intact; no parsing/reserializing of authentication or protocol headers. */
export function withLexCustomHeaders(value?: string): string {
  if (value && /^\s*x-title\s*:/im.test(value)) return value;
  return value ? value + '\nX-Title: Lex' : 'X-Title: Lex';
}
