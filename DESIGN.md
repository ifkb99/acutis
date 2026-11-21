# Acutis — Design

Acutis is a local software factory. It pulls tickets from a board, gives each
ticket its own VCS workspace and agent, verifies the result, and puts a diff in
front of a human for approval. A dashboard shows every agent live and lets the
human pause, redirect, message or kill it.

It is built for web development first, but the webdev parts live in a **pack**
the core never imports.

Status: M0 and M1 implemented, 2026-11-19; the dogfood follow-ups (previews, browser checks, `land: trunk`, setup steps, operator notes, full CLI) landed 2026-11-20 (see §9 and `notes/dogfood-tile-merge.md`). The owner approved running workers on their personal Max login.

---

## 1. Principles

1. **Reusable core, per-repo policy.** Acutis owns the mechanics: tickets,
   workspaces, the agent runner, environments and the dashboard. Each target
   repo owns its policy in `.acutis/`: build gate, verification, roles and the
   definition of done. Customising means editing that folder, not forking
   Acutis. (This is the Yegge "bespoke harness" lesson, scaled down.)
2. **Agents never edit the factory.** Acutis's own source and config are
   outside every worker's writable scope. Gas Town died partly because its
   agents tinkered with the orchestrator instead of doing the work.
3. **Nothing merges without a human.** The end state of a run is
   `awaiting_review`. The human approves; Acutis then lands the change.
4. **The factory owns long-running processes, not the agent.** Dev servers,
   databases and browsers are started, health-checked and reaped by Acutis.
   Agents get URLs. They do not start background servers themselves.
5. **Every run is reconstructable.** All agent and system events are appended
   to SQLite, so a crashed daemon can resume and the dashboard can replay any
   run.

## 2. Architecture

```
                 ┌──────────────────────── acutis daemon (Bun) ────────────────────────┐
 TicketSource ──▶│  Scheduler ──▶ Run (state machine) ──▶ AgentRunner (Claude Agent SDK)│
 (local | gh |   │                    │        │                                        │
  linear ...)    │                    │        ├──▶ WorkspaceProvider (jj | git-wt)     │
                 │                    │        ├──▶ EnvironmentProvider (none | pack)   │
                 │                    │        └──▶ Verifier steps (cmd | pack)         │
                 │  EventLog (SQLite, append-only) ◀── everything                       │
                 │  HTTP + WebSocket API ──▶ Dashboard (browser)                        │
                 └──────────────────────────────────────────────────────────────────────┘
```

Language and runtime: TypeScript on Bun. Storage: `bun:sqlite`. Dashboard:
`Bun.serve` with HTML imports (React), so there is no separate build tool.

### Source layout (planned)

```
src/
  core/         tickets, runs, scheduler, event log, workflow loader, interfaces
  providers/
    workspace/  jj.ts, git-worktree.ts
    agent/      claude-sdk.ts, claude-cli.ts (fallback)
    tickets/    local.ts (SQLite), later github.ts, linear.ts
  packs/
    webdev/     compose env provider, *.localhost router, playwright verifier
  server/       HTTP + WS API
  dashboard/    UI
  cli.ts        `acutis serve | ticket add | run ...`
```

Rule: `core/` imports only interfaces. Providers and packs register themselves
at startup. A lint check enforces that `core/` never imports `packs/`.

## 3. Core interfaces

```ts
interface TicketSource {
  list(filter): Promise<Ticket[]>;
  claim(id): Promise<boolean>;            // transactional; false if taken
  update(id, { status, comment? }): Promise<void>;
}

interface WorkspaceProvider {
  create(repo, ticket): Promise<Workspace>;   // jj: `jj workspace add` + new change + bookmark acutis/<id>
  diff(ws): Promise<string>;
  rebaseOntoTrunk(ws): Promise<{ conflicts: string[] }>;
  land(ws): Promise<void>;                    // push bookmark / open PR
  destroy(ws): Promise<void>;
}

interface AgentRunner {
  start(spec: { cwd, prompt, model, effort, role, permissions }): AgentSession;
}
interface AgentSession {
  events: AsyncIterable<AgentEvent>;          // normalised SDK messages
  send(text, opts?: { priority }): void;      // queued message
  redirect(text): Promise<void>;              // interrupt() then send
  pause(): Promise<void>;                     // interrupt(), hold input
  setPermissionMode(mode): Promise<void>;
  stop(): void;                               // close(), kill process
}

interface EnvironmentProvider {               // see §5
  lease(ws, spec): Promise<Lease>;            // allocate names, ports, DB, env vars
  up(lease): Promise<void>;                   // start + health-check
  urls(lease): Record<string, string>;        // e.g. { web: "http://t-12.web.acutis.localhost:8080" }
  logs(lease, service): AsyncIterable<string>;
  down(lease): Promise<void>;
  release(lease): Promise<void>;              // drop DB, free ports, remove volumes
}

interface Verifier {
  run(ws, lease?): Promise<VerifyResult>;     // pass/fail + artifacts (logs, screenshots)
}
```

### Run state machine

```
queued → preparing (workspace + env) → running → verifying ─┬─▶ awaiting_review → landing → done
             │                            ▲  │              └─▶ running (retry with failures, max N)
             └──────── failed ◀───────────┘  ├─▶ paused ─▶ running (on resume / redirect)
                                             └─▶ cancelled
```

A redirect is `interrupt()` followed by a new user message. The SDK ends the
interrupted response with `error_during_execution`. The run treats that as
expected while a redirect is pending, not as a failure.

## 4. Agent runner and auth

- **Implementation:** `@anthropic-ai/claude-agent-sdk` in streaming-input
  mode. It provides `interrupt()`, `setPermissionMode()`, `setModel()`,
  message `priority` and hooks. These are what make pause, redirect and
  message possible. The fallback is `claude -p --input-format stream-json
  --output-format stream-json` behind the same interface.
- **Auth (verified 2026-11-19):** `claude auth status` reports a claude.ai
  login on a Max (5x) subscription, and there are no `ANTHROPIC_*` env vars.
  An SDK query reported `apiKeySource: "none"` and ran on that login, so work
  draws on subscription usage limits. The `total_cost_usd` in results is an
  API-equivalent estimate, not a charge. Parallel agents consume the
  subscription's rate limits proportionally, so the concurrency cap matters. The daemon refuses to start if `ANTHROPIC_API_KEY` is set, unless
  `--allow-api-billing` is passed, so a stray key cannot silently bill the API.
- **Terms:** the Agent SDK docs say third-party developers may not *offer*
  claude.ai login in their products. Acutis is a personal tool on the owner's
  own login. If it is ever distributed, it must default to API-key auth.
  *Owner's call: confirm before use at scale.*
- **Settings isolation:** sessions run with explicit `settingSources` and an
  appended system prompt built from `.acutis/workflow.md`. Your personal
  `~/.claude` hooks and memory do not leak into workers unless the repo opts in.
- **Roles:** the workflow file maps roles to models, for example
  `implement: opus, review: fable`. M1 has a single `implement` role.

## 5. Running changes in parallel (the environment problem)

A port is only one of the things that parallel copies of a web app share.
What collides, and how Acutis handles each:

| # | Shared thing | Failure | Fix | Milestone |
|---|---|---|---|---|
| 1 | **Many ports, wired to each other** (web, HMR socket, API, DB, Storybook) | Port 3000 is hard-coded in the dev script, Vite proxy target, CORS allowlist and Playwright `baseURL`. Changing one port breaks the others. | **One network namespace per workspace** (a Compose project per lease). Inside it every service keeps its normal port. Only the host-side route differs. | M2 |
| 2 | **Stateful services** (Postgres, Redis, queues, S3/minio) | Branch A runs a migration that branch B's code doesn't expect. Seed data and test runs interfere. | A per-lease database cloned from a template DB (`CREATE DATABASE … TEMPLATE`), or per-lease containers. It is dropped on release. | M2 |
| 3 | **Browser state** | Cookies are scoped by **host, not port**. Logging in on `localhost:3001` logs you in, or out, on `:3002`. | A per-lease hostname via a small reverse proxy: `t-12.web.acutis.localhost`. Browsers resolve `*.localhost` to 127.0.0.1, so each ticket gets its own cookie jar. | M2 |
| 4 | **External singletons** (OAuth redirect URIs, Stripe/webhook targets, email) | Providers allow a fixed list of callback URLs, and one webhook URL points at one server. | Stub or mock by default (declared in the pack config). Optionally one shared tunnel that routes by hostname. Not solved generically: flagged per repo. | M3+ |
| 5 | **Workspace bootstrap** | A new jj workspace has no `node_modules` and no `.env`, because both are gitignored, so the app won't start. | The `.acutis/env.*` config declares a bootstrap step (install using the shared pnpm/bun cache) and which secret files to copy or template in. | M2 |
| 6 | **Machine limits** | This machine's `fs.inotify.max_user_watches` is 65536. Several watchers over `node_modules` exhaust it, and each Next/Vite dev server plus Chromium costs about 0.5–1.5 GB of RAM. | A concurrency cap in the scheduler. Envs start only while a run is verifying or being reviewed. Document raising the inotify limit. | M2 |
| 7 | **Lifecycle and integration** | Killed or redirected agents leave orphan dev servers. Two tickets that each pass alone can break together (lockfile churn, two migrations numbered 0042). | Acutis, not the agent, owns processes (principle 4). On approve, rebase onto the current trunk and **re-run verification on the combined result** before landing. A merge queue comes later. | M2 / M3 |

Core vs pack split: the core knows only that a run may hold an `EnvironmentProvider` lease with URLs, env vars and logs. The **webdev pack** implements it with Docker Compose (`COMPOSE_PROJECT_NAME=acutis-<ticket>`), the `*.localhost` router, DB templating and a Playwright verifier. A non-web repo uses the `none` provider.

## 6. Sandboxing

There are two separate questions: where the agent loop runs, and where the app runs.

- **M1:** the agent loop runs on the host, with Claude Code's sandbox on for
  the session (`sandbox.enabled`, `allowUnsandboxedCommands: false`).
  - The sandbox limits Bash writes to the workspace and temp, and routes
    network through an allowlist proxy.
  - It needs `bubblewrap` and `socat`, and the kernel must allow unprivileged
    user namespaces. Ubuntu's `kernel.apparmor_restrict_unprivileged_userns=1`
    blocks bubblewrap until an AppArmor profile for `/usr/bin/bwrap` is added
    (README, "Sandbox"). Acutis probes for this at startup (`probeSandbox`) and
    reports the reason, instead of failing every run. **Verified 2026-11-20**
    (run 4): writes outside the workspace fail, internet hosts become
    per-host permission requests, and the Acutis API on localhost is unreachable.
  - **Gates and the preview server run worker-written code** (a test file, a
    dev server), so Claude Code's sandbox doesn't cover them. When the sandbox
    is available Acutis runs them in its own bubblewrap wrapper
    (`CommandSandbox`, `providers/sandbox/bwrap.ts`): read-only root, the
    workspace writable, a private `/tmp` and PID namespace, Acutis's data dir
    and credential directories hidden. Gates also get no network at all; the
    preview keeps the host network so the checking browser can reach it.
    Both get the daemon's environment minus credential-looking variables
    (`workerEnv`), sandbox or not. `setup:` steps run on the host: they are
    trunk policy, run before the worker has touched anything, and usually
    need the network.
  - **Bash under the sandbox is auto-approved** in `canUseTool`. Claude Code still raises prompts for
    commands it can't statically check (heredocs, `( … )` groups, variables), but with unsandboxed
    retries off they run in bubblewrap anyway. In the trials those prompts were 7 of the first 7 and
    guarded nothing. Network access is a separate `SandboxNetworkAccess` request and still asks.
  - **Sandbox placeholder files.** While a sandboxed command runs, Claude Code mounts empty read-only
    files over config paths in the workspace (`.bashrc`, `.gitmodules`, `.mcp.json`,
    `.claude/settings.json`…). The jj provider deletes untracked files of exactly that shape
    before diffing or landing, so a snapshot can never record them. They still confuse tools
    that walk the tree (`prettier .` crashed in one run); not mounting them at all is open.
  - The sandbox only wraps shell commands, and it still allows *reads* across
    the machine. Deny-read `~/.ssh`, `~/.aws`, `~/.claude/.credentials.json`
    and other repos.
  - Edit/Write are confined by permissions: `acceptEdits` inside the
    workspace, and `canUseTool` denies anything outside it.
    `bypassPermissions` is off.
- **M2:** app services run in Compose containers (see §5). The agent reaches
  them by URL.
- **M5 (spike):** the agent loop itself runs in the workspace container by
  pointing `pathToClaudeCodeExecutable` at a wrapper that runs
  `docker exec -i <ctr> claude …`, so the SDK's stdio protocol, and therefore
  redirect, still works. The cost is that login credentials must be mounted
  into the container. Decide after the spike.

## 7. Per-repo policy: `.acutis/`

```
.acutis/
  workflow.md     # front matter (roles/models, gates, concurrency, permissions) + prompt template
  env.compose.yml # webdev pack: services for one lease (optional)
  env.toml        # bootstrap steps, secret files to provision, healthchecks, mocks
```

**Policy is read from trunk, never from the workspace.** `.acutis/` sits inside
the repo the agent edits. Acutis therefore loads gates and permissions from the
trunk revision at run start, and flags any diff that touches `.acutis/` for
explicit human review. Otherwise a worker could loosen its own gates (principle 2).

Example front matter (what is implemented today):

```yaml
model: opus
effort: high
setup:                      # run in a fresh workspace before the agent starts
  - bun install
preview: bun --port=$PORT ./index.html   # Acutis runs it on a free 127.0.0.1 port ($PORT/$BUN_PORT)
gates:
  - bunx tsc --noEmit
  - bun test
  - name: home page works
    browser:                # headless Chrome against the preview; fails on page errors or a falsy script
      path: /
      width: 390
      steps: |              # press <Key> | click <css> | type <text> | wait <ms> | swipe <dir> [css]
        press ArrowLeft
      script: "document.querySelector('#app') !== null"
permissions: { allow: ["Bash(bun test:*)", "Bash(bun run:*)"] }
permission_timeout_s: 900   # auto-deny unanswered prompts (default: wait forever)
max_attempts: 2
land: trunk                 # bookmark | push | trunk
```

`land: trunk` rebases the approved change onto the current trunk bookmark, re-runs every gate on
the combined result if trunk moved, and advances the bookmark (never backwards; conflicts or
failing re-checks put the run back in review). Landings are serialised per repo. It requires the
repo's base to be a plain bookmark.

**Operator notes** are the one policy input that does not come from trunk: free text per repo,
stored in Acutis's database (`acutis repo notes`, or the dashboard), appended to every worker's
system prompt. They live outside every workspace, so workers cannot edit them; they can only add
guidance, not loosen gates or permissions.

## 8. Dashboard

The dashboard lists runs grouped by state. Each run shows:

- a live transcript (text, tool calls, tool results), streamed over WebSocket
  from the event log
- the current diff and verification results, with screenshots once M3 lands
- actions: **Message** (queued), **Redirect** (interrupt, then message),
  **Pause / Resume**, **Kill**, **Approve**, **Reject with note** (sends the
  run back to `running` with the note)

## 9. Milestones

- **M0, setup:** install jj; `jj git init --colocate`; Bun project skeleton;
  `acutis serve` boots with an empty dashboard.
- **M1, one ticket end to end:** a local SQLite ticket goes in; Acutis creates
  a jj workspace; the SDK agent works in it; the dashboard shows it live with
  message, redirect, pause and kill; the human sees the diff and approves; the
  bookmark is created. Verification is the workflow's shell gates only. No
  environment provider yet.
- **M2, parallel:** scheduler with a concurrency cap; webdev pack environment
  (Compose per lease, `*.localhost` router, DB templating, bootstrap and
  secrets); orphan reaping.
- **M3, verification and integration:** Playwright screenshots in the
  dashboard; re-verify after rebase onto trunk; hand rebase conflicts to an
  agent or to the human.
- **M4, real board:** GitHub Issues or Linear adapter; send CI failures and PR
  review comments back to the owning run.
- **M5, container-sandboxed agent loop** (spike from §6).

### Implementation notes (M1)

- Permission requests the allowlist doesn't cover go to the dashboard (Allow
  once / Allow for this run / Deny). They are not auto-denied.
- The session is closed once a run reaches `awaiting_review`. "Send back" and
  messages to failed or restarted runs resume the same session with
  `resume: session_id`.
- After a daemon restart, live runs become `paused`; Resume reattaches with
  `resume`.
- Workers get **no external MCP servers**: `strictMcpConfig`, and
  `disableClaudeAiConnectors`. The only server is Acutis's own, in-process `acutis` server
  (`preview` and `browser` tools), present only when the repo's workflow declares a `preview`.
  The browser tool takes a path, never a URL. Its headless Chrome fails every request to another
  origin made by the page, its dedicated workers, iframes and popups (browser- and page-level CDP
  `Fetch` interception; new targets are auto-attached paused, and popups are closed), so the
  browser tool can't be used to drive the dashboard on 127.0.0.1:7777. WebSocket handshakes are
  not intercepted; the dashboard's `/ws` refuses foreign origins and is receive-only. This covers
  the browser tool only: any local process can call the API with the `x-acutis` header (the CLI
  relies on that), so with the sandbox off, code run by an allowlisted command such as `bun test`
  could still approve a run. With the sandbox on, the agent's commands and gates can't reach
  localhost; the preview server still can (it shares the host network). Without these, a worker picked up the
  owner's claude.ai connectors a few seconds into the session (verified
  2026-11-19).
- There is no blanket `Read` allow. Reads inside the workspace are automatic,
  reads outside ask the operator, and credential paths (`~/.ssh`, `~/.aws`,
  gh, Claude credentials…) are hard-denied. Verified with a real-agent probe
  on 2026-11-19.

### Implementation notes (dogfood follow-ups, 2026-11-20)

- **Cost:** the SDK's `total_cost_usd` is a running total per `query()` (and a resumed session
  continues from its saved total). Runs add the delta per result, not the total.
- **Sandbox off:** a PreToolUse hook sends any Bash command that names a user-writable path
  outside the workspace (`/tmp`, `$HOME`, `../…`) to the operator, even if the command is
  allowlisted (verified: a hook `ask` overrides an `allowedTools` match). It is a heuristic:
  allowlisted commands that run code (`bun test`, `bun run`) can still touch anything.
- **Previews** are owned by the daemon (principle 4): one per run, started on demand by the
  agent's `preview`/`browser` tools, a browser gate, or the reviewer's "Open preview"; killed on
  approve, discard, kill, failure and daemon shutdown. This is the minimal, Compose-free slice of
  §5; ports, DBs and hostnames per lease are still M2.
- **Artifacts** (check screenshots, agent screenshots, note images) are PNGs stored under
  `$ACUTIS_HOME/artifacts/run-N/` with server-generated names and served as `image/png` with
  `nosniff`. Worker-written text renders in the dashboard as React elements only (a small
  Markdown subset; no raw HTML, http(s) links only, no images).
- **Notifications:** `notify-send` if installed (`ACUTIS_NOTIFY=off` to disable) and/or a POST to
  `ACUTIS_NOTIFY_URL`, on permission requests, review and failure. The tab title shows pending
  permission requests.

## 10. Open questions

1. Auth/terms: confirm running workers on the personal Claude login (§4).
2. Dogfood target: which existing web repo do we test M1 and M2 against?
3. Landing default: push a jj bookmark only, or open a GitHub PR (needs `gh`,
   which isn't installed)?
