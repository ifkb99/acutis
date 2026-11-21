import { $ } from "bun";
import { existsSync, lstatSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Repo, Workspace, WorkspaceProvider } from "../../core/types";

const identityCache = new Map<string, Record<string, string>>();

/**
 * Commits need an author; jj leaves it empty when user.name/email aren't configured. Fall back to
 * git's identity. Resolved in the directory jj will run in, because jj and git both read repo-level
 * config: the daemon's own cwd says nothing about the target repo.
 */
export async function identityFor(cwd: string): Promise<Record<string, string>> {
  const cached = identityCache.get(cwd);
  if (cached) return cached;
  const get = async (cmd: string[]) => (await $`${cmd}`.cwd(cwd).nothrow().quiet()).stdout.toString().trim();
  const env: Record<string, string> = {};
  if (!(await get(["jj", "config", "get", "user.name"]))) {
    const n = await get(["git", "config", "user.name"]);
    if (n) env.JJ_USER = n;
  }
  if (!(await get(["jj", "config", "get", "user.email"]))) {
    const e = await get(["git", "config", "user.email"]);
    if (e) env.JJ_EMAIL = e;
  }
  identityCache.set(cwd, env);
  return env;
}

export class JjError extends Error {}

async function jj(cwd: string, args: string[], retryStale = true): Promise<string> {
  const env = { ...process.env, ...(await identityFor(cwd)) };
  const res = await $`jj --no-pager --color=never ${args}`.cwd(cwd).env(env).nothrow().quiet();
  if (res.exitCode !== 0) {
    const err = res.stderr.toString();
    if (retryStale && /working copy is stale/i.test(err)) {
      await $`jj workspace update-stale`.cwd(cwd).env(env).nothrow().quiet();
      return jj(cwd, args, false);
    }
    throw new JjError(`jj ${args.join(" ")} failed in ${cwd}:\n${err.trim()}`);
  }
  return res.stdout.toString();
}

/**
 * While a sandboxed command runs, Claude Code mounts read-only empty files over config paths in
 * the workspace (`.bashrc`, `.gitconfig`, `.gitmodules`, `.mcp.json`, `.claude/settings.json`…) so
 * they can't be written. A jj snapshot taken meanwhile, or after the session died, would record
 * them as part of the change. Before diffing or landing, delete files that look exactly like
 * that (empty, not owner-writable, at the top level or in `.claude/`) unless the base tracks them.
 */
export async function prunePlaceholders(wsPath: string, baseCommit: string): Promise<string[]> {
  const candidates: string[] = [];
  for (const dir of ["", ".claude"]) {
    let names: string[] = [];
    try {
      names = readdirSync(`${wsPath}/${dir}`);
    } catch {
      continue;
    }
    for (const n of names) {
      const rel = dir ? `${dir}/${n}` : n;
      try {
        const st = lstatSync(`${wsPath}/${rel}`);
        if (st.isFile() && st.size === 0 && (st.mode & 0o200) === 0) candidates.push(rel);
      } catch {}
    }
  }
  if (!candidates.length) return [];
  const tracked = new Set(
    (await jj(wsPath, ["file", "list", "--ignore-working-copy", "-r", baseCommit, "--", ...candidates.map((c) => `root-file:"${c}"`)]).catch(() => ""))
      .split("\n")
      .filter(Boolean),
  );
  const removed = candidates.filter((c) => !tracked.has(c));
  for (const c of removed) rmSync(`${wsPath}/${c}`, { force: true });
  return removed;
}

export class JjWorkspaceProvider implements WorkspaceProvider {
  constructor(private workspacesRoot: string) {}

  static async isJjRepo(path: string): Promise<boolean> {
    return existsSync(`${path}/.jj`);
  }

  async resolve(repo: Repo, revset: string): Promise<string> {
    const out = await jj(repo.path, [
      "log", "--ignore-working-copy", "--no-graph", "-r", revset, "-T", 'commit_id ++ "\\n"',
    ]);
    const ids = out.split("\n").filter(Boolean);
    if (ids.length !== 1) {
      throw new JjError(`revset "${revset}" resolved to ${ids.length} commits in ${repo.name}; expected exactly 1`);
    }
    return ids[0]!;
  }

  async readAt(repo: Repo, commit: string, file: string): Promise<string | null> {
    try {
      return await jj(repo.path, ["file", "show", "--ignore-working-copy", "-r", commit, `root-file:"${file}"`]);
    } catch (e) {
      if (e instanceof JjError && /no such path|doesn't exist|not found/i.test(e.message)) return null;
      throw e;
    }
  }

  pathFor(repo: Repo, name: string): string {
    return `${this.workspacesRoot}/${repo.name}/${name}`;
  }

  async create(repo: Repo, name: string, baseCommit: string): Promise<Workspace> {
    const path = this.pathFor(repo, name);
    if (existsSync(path)) throw new JjError(`workspace path already exists: ${path}`);
    mkdirSync(dirname(path), { recursive: true });
    await jj(repo.path, ["workspace", "add", "--name", name, "-r", baseCommit, path]);
    return { name, path, baseCommit };
  }

  async diff(_repo: Repo, ws: Workspace): Promise<string> {
    if (!existsSync(ws.path)) return "";
    await prunePlaceholders(ws.path, ws.baseCommit);
    return jj(ws.path, ["diff", "--git", "--from", ws.baseCommit, "--to", "@"]);
  }

  async changedFiles(_repo: Repo, ws: Workspace): Promise<string[]> {
    if (!existsSync(ws.path)) return [];
    await prunePlaceholders(ws.path, ws.baseCommit);
    const out = await jj(ws.path, ["diff", "--name-only", "--from", ws.baseCommit, "--to", "@"]);
    return out.split("\n").filter(Boolean);
  }

  async land(_repo: Repo, ws: Workspace, opts: { message: string; bookmark: string | null; push: boolean }) {
    await prunePlaceholders(ws.path, ws.baseCommit);
    await jj(ws.path, ["describe", "-m", opts.message]);
    if (!opts.bookmark) return;
    await jj(ws.path, ["bookmark", "set", opts.bookmark, "-r", "@", "--allow-backwards"]);
    if (opts.push) await jj(ws.path, ["git", "push", "--bookmark", opts.bookmark]);
  }

  async rebase(_repo: Repo, ws: Workspace, onto: string): Promise<{ moved: boolean; conflicts: string[] }> {
    const parents = (await jj(ws.path, ["log", "--no-graph", "-r", "@-", "-T", 'commit_id ++ "\\n"'])).split("\n").filter(Boolean);
    const moved = !(parents.length === 1 && parents[0] === onto);
    if (moved) await jj(ws.path, ["rebase", "-r", "@", "-d", onto]);
    // Always check: a change rebased by an earlier, stopped landing already sits on trunk but may
    // still be conflicted.
    const conflicted = (await jj(ws.path, ["log", "--no-graph", "-r", "@", "-T", 'if(conflict, "yes", "no")'])).trim();
    if (conflicted !== "yes") return { moved, conflicts: [] };
    const list = await jj(ws.path, ["resolve", "--list"]).catch(() => "");
    const conflicts = list.split("\n").map((l) => l.trim().split(/\s+/)[0]!).filter(Boolean);
    return { moved, conflicts: conflicts.length ? conflicts : ["(unknown files)"] };
  }

  async advance(_repo: Repo, ws: Workspace, bookmark: string) {
    // No --allow-backwards: if trunk moved sideways since the rebase, this fails instead of dropping work.
    await jj(ws.path, ["bookmark", "set", bookmark, "-r", "@"]);
  }

  async isBookmark(repo: Repo, name: string): Promise<boolean> {
    if (!/^[A-Za-z0-9._\/-]+$/.test(name)) return false;
    const out = await jj(repo.path, ["bookmark", "list", "--ignore-working-copy", "-T", 'name ++ "\\n"']).catch(() => "");
    return out.split("\n").includes(name);
  }

  async destroy(repo: Repo, ws: Workspace, opts: { abandon: boolean }) {
    if (opts.abandon) {
      await jj(repo.path, ["abandon", `${ws.name}@`]).catch(() => {});
    }
    await jj(repo.path, ["workspace", "forget", ws.name]).catch(() => {});
    if (existsSync(ws.path)) rmSync(ws.path, { recursive: true, force: true });
    if (existsSync(`${repo.path}/.git`)) {
      await $`git worktree prune`.cwd(repo.path).nothrow().quiet();
    }
  }
}
