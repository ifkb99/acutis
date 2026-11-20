import { $ } from "bun";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Repo, Workspace, WorkspaceProvider } from "../../core/types";

let identityEnv: Record<string, string> | null = null;

/** jj refuses to push commits with an empty identity; fall back to git's identity. */
async function identity(): Promise<Record<string, string>> {
  if (identityEnv) return identityEnv;
  const env: Record<string, string> = {};
  const jjName = (await $`jj config get user.name`.nothrow().quiet()).stdout.toString().trim();
  const jjEmail = (await $`jj config get user.email`.nothrow().quiet()).stdout.toString().trim();
  if (!jjName) {
    const n = (await $`git config user.name`.nothrow().quiet()).stdout.toString().trim();
    if (n) env.JJ_USER = n;
  }
  if (!jjEmail) {
    const e = (await $`git config user.email`.nothrow().quiet()).stdout.toString().trim();
    if (e) env.JJ_EMAIL = e;
  }
  identityEnv = env;
  return env;
}

export class JjError extends Error {}

async function jj(cwd: string, args: string[], retryStale = true): Promise<string> {
  const env = { ...process.env, ...(await identity()) };
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
    return jj(ws.path, ["diff", "--git", "--from", ws.baseCommit, "--to", "@"]);
  }

  async changedFiles(_repo: Repo, ws: Workspace): Promise<string[]> {
    if (!existsSync(ws.path)) return [];
    const out = await jj(ws.path, ["diff", "--name-only", "--from", ws.baseCommit, "--to", "@"]);
    return out.split("\n").filter(Boolean);
  }

  async land(_repo: Repo, ws: Workspace, opts: { message: string; bookmark: string; push: boolean }) {
    await jj(ws.path, ["describe", "-m", opts.message]);
    await jj(ws.path, ["bookmark", "set", opts.bookmark, "-r", "@", "--allow-backwards"]);
    if (opts.push) await jj(ws.path, ["git", "push", "--bookmark", opts.bookmark]);
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
