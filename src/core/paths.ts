import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";

export function isInside(root: string, p: string): boolean {
  const abs = resolve(root, p);
  const r = resolve(root);
  return abs === r || abs.startsWith(r + sep);
}

/** Paths a shell command may name without being "outside the workspace". */
const HARMLESS = [/^\/dev\/(null|stdin|stdout|stderr|tty|fd\/\d+)$/, /^\/proc\/self\//];

/**
 * Top-level directories that only root can write to. Naming them is fine: the risk with the
 * sandbox off is writes to user-writable places (/tmp, $HOME, other repos).
 */
const ROOT_OWNED = new Set(["usr", "bin", "sbin", "lib", "lib32", "lib64", "libx32", "etc", "opt", "boot", "proc", "sys", "snap"]);

function tokens(command: string): { text: string; quoted: boolean }[] {
  const out: { text: string; quoted: boolean }[] = [];
  let cur = "";
  let quoted = false;
  let q: string | null = null;
  const push = () => {
    if (cur) out.push({ text: cur, quoted });
    cur = "";
    quoted = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (q) {
      if (ch === q) q = null;
      else if (ch === "\\" && q === '"' && i + 1 < command.length) cur += command[++i];
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      q = ch;
      quoted = true;
    } else if (ch === "\\" && i + 1 < command.length) {
      cur += command[++i];
    } else if (/\s|[;|&<>()`]/.test(ch)) {
      push();
    } else {
      cur += ch;
    }
  }
  push();
  return out;
}

/**
 * Best-effort list of user-writable paths outside `cwd` that a shell command names.
 *
 * This is a heuristic, not a boundary: `bun test` or a script can touch anything without naming it.
 * Its job is to stop allowlisted commands (e.g. `bun build --outdir /tmp/x`) from silently reaching
 * outside the workspace when the bubblewrap sandbox is unavailable.
 */
export function outsidePaths(command: string, cwd: string, home = process.env.HOME ?? ""): string[] {
  const found = new Set<string>();
  for (const tok of tokens(command)) {
    let t = tok.text;
    const eq = t.match(/^-{1,2}[\w-]+=(.*)$/);
    if (eq) t = eq[1]!;
    if (!t || t.includes("://")) continue;
    let candidate: string | null = null;
    if (t === "~" || t.startsWith("~/")) candidate = home ? home + t.slice(1) : null;
    else if (t === "$HOME" || t.startsWith("$HOME/") || t.startsWith("${HOME}")) {
      candidate = home ? t.replace(/^\$\{?HOME\}?/, home) : null;
    } else if (t.startsWith("/")) candidate = t;
    else if (t === ".." || t.startsWith("../") || t.includes("/../")) candidate = resolve(cwd, t);
    if (!candidate) continue;
    const abs = resolve(cwd, candidate);
    if (isInside(cwd, abs)) continue;
    if (HARMLESS.some((re) => re.test(abs))) continue;
    const top = abs.split("/")[1] ?? "";
    if (ROOT_OWNED.has(top)) continue;
    // "/api/" in `grep "/api/" src` is a pattern, not a path: only count it if its top level exists.
    if (!existsSync(`/${top}`)) continue;
    found.add(abs);
  }
  return [...found];
}
