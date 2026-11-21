import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/**
 * The API token lives in `$ACUTIS_HOME/token` (0600). It persists across restarts so open
 * dashboard tabs keep working. Gates and previews run with `$ACUTIS_HOME` hidden, and the agent's
 * sandbox and file tools deny it. It never goes into the environment, which workers inherit.
 */
export const tokenPath = (home: string) => `${home}/token`;

export function ensureToken(home: string): string {
  const existing = readToken(home);
  if (existing) return existing;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  writeFileSync(tokenPath(home), token + "\n", { mode: 0o600, flag: "w" });
  chmodSync(tokenPath(home), 0o600);
  return token;
}

export function readToken(home: string): string | null {
  const p = tokenPath(home);
  if (!existsSync(p)) return null;
  const t = readFileSync(p, "utf8").trim();
  return t || null;
}

export function tokenMatches(expected: string, given: string | null | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
