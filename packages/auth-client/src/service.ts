import { z } from "zod";
import { authRegionSchema, type AuthRegion } from "./types.js";

/** A deployment identity, independent of the wire's cn/global compatibility field. */
export type AuthService =
  | { kind: "cindy"; realm: AuthRegion }
  | { kind: "lex-server"; origin: string };

export type LexServiceKey = `lex-server:${string}`;
/** Internal credential namespace. Cindy keys deliberately retain their legacy spelling. */
export type AuthServiceScope = AuthRegion | LexServiceKey;

export function normalizeLexServerOrigin(input: string): string {
  if (input.length > 2048 || /[\u0000-\u001f\u007f]/u.test(input)) {
    throw new Error("INVALID_SERVER_URL");
  }
  const value = input.trim();
  // URL accepts backslashes and silently strips some invalid input. Never normalize those away.
  if (!/^https?:\/\/[^/?#@\\]+\/?$/i.test(value)) throw new Error("INVALID_SERVER_URL");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('INVALID_SERVER_URL'); }
  if (url.username || url.password || url.search || url.hash ||
      (url.pathname !== "/" && url.pathname !== "")) throw new Error("INVALID_SERVER_URL");
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("SERVER_HTTPS_REQUIRED");
  }
  return url.origin;
}

export const authServiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cindy"), realm: authRegionSchema }).strict(),
  z.object({ kind: z.literal("lex-server"), origin: z.string().refine((value) => {
    try { return normalizeLexServerOrigin(value) === value; } catch { return false; }
  }) }).strict(),
]);

export function authServiceScope(service: AuthService): AuthServiceScope {
  return service.kind === "cindy" ? service.realm : `lex-server:${normalizeLexServerOrigin(service.origin)}`;
}

export function authServiceFromScope(scope: AuthServiceScope): AuthService {
  if (scope === "cn" || scope === "global") return { kind: "cindy", realm: scope };
  if (!scope.startsWith('lex-server:')) throw new Error('INVALID_SERVICE_SCOPE');
  const origin = normalizeLexServerOrigin(scope.slice("lex-server:".length));
  if (scope !== `lex-server:${origin}`) throw new Error("INVALID_SERVICE_SCOPE");
  return { kind: "lex-server", origin };
}

export function isAuthServiceScope(value: unknown): value is AuthServiceScope {
  if (value === "cn" || value === "global") return true;
  if (typeof value !== "string" || !value.startsWith("lex-server:")) return false;
  try { authServiceFromScope(value as LexServiceKey); return true; } catch { return false; }
}

/** global is only the Lex Server wire compatibility value, never its credential identity. */
export function authServiceRealm(scope: AuthServiceScope): AuthRegion {
  return scope === "cn" ? "cn" : "global";
}

/** Old records without a service remain tied to their original Cindy realm. */
export function storedAuthServiceScope(record: { realm: AuthRegion; service?: AuthService }): AuthServiceScope {
  const realm = authRegionSchema.parse(record.realm);
  if (!record.service) return realm;
  const scope = authServiceScope(authServiceSchema.parse(record.service));
  if (authServiceRealm(scope) !== realm) throw new Error("SERVICE_REALM_MISMATCH");
  return scope;
}
