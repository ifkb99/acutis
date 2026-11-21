/** Names that look like credentials: never handed to commands that run worker-written code. */
const SECRET = /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH|SESSION|COOKIE)(_|$)|^ANTHROPIC_|^CLAUDE_CODE_|^AWS_|^GH_|^GITHUB_|^ACUTIS_NOTIFY/i;

/**
 * The daemon's environment minus anything secret-looking, plus `extra`. Used for gates and the
 * preview server, which run code the worker wrote: a test file can print `process.env`.
 */
export function workerEnv(extra: Record<string, string> = {}, base: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !SECRET.test(k)) out[k] = v;
  return { ...out, ...extra };
}
