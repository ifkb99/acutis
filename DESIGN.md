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

**Run limit (2026-11-21).** At most `ACUTIS_MAX_RUNS` runs (default 4; 0 = no
limit) hold a slot, i.e. are preparing, running, verifying or landing. A new run
past the limit is `queued` and starts, oldest first, when a run leaves those
states (review, pause, failure, kill). Slots are counted from the store and freed
in one place, `setState`. Queued runs survive a restart. A queued run that can't
start fails rather than blocking the queue. The limit gates only *new* runs:
resume, send-back and approve start at once, so they can briefly exceed it. After
a restart, queued runs take the slots while the old running runs sit paused.

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
    and credential directories hidden, and an empty network namespace. The
    preview's port is bridged out: socat inside the sandbox listens on a Unix
    socket (under `$XDG_RUNTIME_DIR`, outside the workspace) and connects to the
    server's loopback port, and a host-side socat relays 127.0.0.1:port to that
    socket. So the preview can't reach the Acutis API, other TCP services on
    localhost or the internet; a dev server that needs the internet won't get it.
  - **Host Unix sockets (found 2026-11-21; partly closed).** A network
    namespace doesn't cover path sockets, and a read-only mount doesn't stop
    `connect()`. From inside `BwrapSandbox`, `/run/user/$UID/bus` (so
    `systemd-run --user` started a process outside the sandbox) and
    `/var/run/docker.sock` (root, for docker-group users) both accepted
    connections, escaping the filesystem, network and token protections.
    **Stopgap:** `/run` is now an empty tmpfs inside (test: `tests/sandbox.test.ts`,
    fails without it). **Still open:** sockets elsewhere stay reachable. A scan
    of one machine found `~/.cache/ibus`, wezterm's GUI socket, a Codex
    app-server daemon, the Nix daemon and postfix. A full scan took 47s, so
    hiding them one by one doesn't scale. Blocking `AF_UNIX` with seccomp
    would break tools that use sockets in the private `/tmp` (tsx IPC in the
    duke-ml harness gate). The planned fix is a container backend for gates
    and previews (`notes/container-sandbox-plan.md`).
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

### Contracts (2026-11-22, phase 4 of the scouts plan)

- **Declared in the workflow** (trunk policy): `contracts: { name: { files: [globs], consumers?: [globs], check?: command } }`.
  A run *changes* a contract when its diff touches the contract's files (including deleting or adding one). It
  *depends* on a contract when it changes it, or touches its consumers; with no `consumers` listed, every change
  depends on it.
- **Workers are told** the contracts (names and paths), not to edit them unless the ticket asks, and to use
  `request_contract_change` otherwise. That files an open decision in the register (area `contract`) with a held
  "change the contract" ticket. Approving a proposal moves the ticket to todo, and competing proposals are separate
  decisions. Contract decisions stay out of the "operator decisions" prompt section: they're about one ticket, not
  standing policy.
- **Checks.** A contract's `check` runs as an extra gate whenever a run touches the contract or its consumers, at
  verify time and again after a landing rebase.
- **Acceptance.** Approving a run that changes a contract needs `acceptContracts`. That's `acutis approve --contracts`,
  or the dashboard's "I've reviewed the contract change" box. It is computed from the workspace diff at approve time,
  and in trunk mode again under the new trunk's contract list.
- **Staleness** comes from the commits, not a stored fingerprint: a contract is stale for a run when its files
  differ between the run's base and trunk.
  - `land: trunk`: landing stops, the workspace is rebased (as it already was), and the run goes back to its agent
    with the contract's diff (capped). It is re-checked and comes back to review.
  - `land: bookmark`/`push`: nothing is rebased, so a stale contract needs `acceptContracts` instead.
  - When a contract-changing run lands, other live runs in the repo get a `contract.stale` notice: a dashboard flag
    only, no agent message, so nobody hand-applies a change their workspace doesn't have yet.

### Phase 3 of the scouts plan (2026-11-21): more scouts, a better library, the librarian

Ideas from reviewing anima-research's connectome-host and context-manager; see the plan doc.

- **Seven scouts.** Architecture, Security, UI/UX (needs the repo's preview; gets the preview and
  browser tools; its screenshots stay with its run), Domain logic and Docs join Infrastructure and Tests.
  Everything agents file through Acutis is redacted for credential-shaped strings, as is the event
  log of those tool calls.
- **Trust tiers.** Library results say how far to trust them: approved means trunk docs and operator
  decisions, and reviewed means landed runs' worker-written reports. They rank by tier.
- **Library gaps.** `report_library_gap` records questions the docs didn't answer (merged by question,
  capped per run). The Docs scout gets them and can link a ticket; a gap closes when that ticket is accepted.
- **Receipts.** `library.search`, `library.read`, `library.overview` and `library.librarian` run events
  record what a run was shown (ids, characters, worker or librarian), and turn results carry the SDK's
  per-model token totals. Reads that bypass the tools (`cat`) aren't counted.
- **Descriptions for finding** (`library.describe`, off by default). A cheap model writes 1-2 line
  descriptions of doc sections. They feed an FTS column used for ranking and the overview, and are shown
  as "about (model-written, check the text)", never as the answer. The rules, from context-manager:
  - one call per file, so a hostile section can only steer its own file;
  - a file's description is written from its raw sections, never from section descriptions;
  - thin sections and all-thin files are skipped;
  - cached by content, prompt version and model, so a new commit pays only for changed sections.

  The model call (`OneShotModel`, `ClaudeSdkOneShot`) has no built-in tools, no settings or MCP, an
  empty cwd, one turn and a spend cap (probe: offered no tools, ignored an injected "write a file"). It runs in the background, one job at a
  time, capped per commit and stopped on shutdown; `acutis library <repo>` shows status and cost.
  **Probe on stahl** (38 docs): 44 calls, 660 sections described and 96 thin, $0.26, about 9 minutes
  sequentially. A later pass after a rebuild reused all 660 from the cache ($0.0003, 3s). Ranking on 10
  questions I wrote, one run, top 1/3/5 for the right wiki page:

  | Search | Top 1 | Top 3 | Top 5 |
  |---|---|---|---|
  | Original | 1 | 2 | 2 |
  | Dropping stop words from queries, indexing file paths (now the default) | 1 | 4 | 5 |
  | Plus descriptions | 3 | 6 | 7 |

  A rebuilt library forgets per-commit describe state, so describing runs again from the cache.
- **`project_overview`**: a table of contents of the docs, at no model cost.
- **`ask_librarian`** (`library.librarian`, on by default since 2026-11-21: it costs nothing until a worker asks; the A/B checks it). A short, synchronous Haiku session with
  only the search, read and overview tools answers one question, marking claims `[SRC: path:line]`,
  `[INF]`, `[GEN]` or ❓. Acutis flags `[SRC]` citations to entries the librarian never opened, and
  adds its cost to the run. It is an Acutis tool rather than a native SDK subagent, because subagents run in
  the background in this Claude Code even with `background: false` (two Haiku probes), so a worker's turn
  could end before the answer.
- **Background subagents (fixed 2026-11-22).** The built-in `general-purpose` agent and custom subagents
  run in the background when the model (or Claude Code) chooses, while `Explore` ran in the foreground. A
  backgrounded subagent ends the agent's turn early ("I've started the agent…"), and the SDK starts a new
  turn when it finishes. The runner now reports the SDK's `background_tasks_changed` as `agent.background`.
  When a turn ends with tasks still running, Acutis waits for the next turn before checking the work (or
  finishing a scout, which deletes its workspace). It checks anyway 60s after the tasks finish if the
  agent doesn't continue, or after 30 minutes if they never finish. Verified with a real worker: it
  backgrounded a subagent, Acutis waited, and the follow-up turn wrote the file the check needed. Probe: one question, $0.002-0.004, a good answer with honest gaps. After the citation fix: 7 cited,
  0 unsourced, 1 only seen in a search excerpt.

- **A/B (2026-11-22), `scripts/ab.ts`.** Baseline (librarian and descriptions off) against treatment
  (both on), on stahl at its latest trunk, real Opus workers, unattended (prompts auto-deny after 2 min).
  - A pilot on a code ticket that names its file (trial ticket 7): the worker never touched the
    library. It cost $0.72, against the trial's $0.67.
  - Three tickets written so the wiki matters: tests for the documented round rules, `validate-mods`
    reporting misspelt fields, and a contributor guide.

    | Ticket | Baseline | Treatment |
    |---|---|---|
    | Round-rules tests | $3.55, 65 turns, passed first try, 1 doc/engine disagreement found | $2.94, 53 turns, passed first try, 2 found (one the baseline missed) |
    | `validate-mods` typos | $1.99, 43 turns, passed first try | $2.94, 47 turns, passed first try; also updated `modding.md` and followed a convention in `DONE.md` |
    | Contributor guide | killed by the $14 cap | killed by the $14 cap |

    The noise repeat was also killed, so run-to-run variation isn't measured.
  - **Result:** `ask_librarian` was called 0 times in 4 treatment runs; workers searched 1-2 times per run
    in both arms and read docs directly. The cost and turn gaps point in opposite directions. So there is
    no detectable effect on workers, from either the librarian or descriptions. Spend: $14.99.

- **Real runs of the Tests, Security and UI/UX scouts (2026-11-22)**, with the librarian on, $2.78 in total.

  | Scout | Repo | Cost | Filed |
  |---|---|---|---|
  | Tests | stahl | $1.17 | 5 tickets |
  | Security | duke-ml | $0.70 | 1 ticket |
  | UI/UX | hegel | $0.91 | 5 tickets and 1 question, with an "undo" ticket held on it |

  The UI/UX scout used the preview and browser 8 times. Spot checks:
  - Security: true. One job has no `permissions` block, and actions are pinned to tags, not SHAs.
  - Tests: one true and subtle (the save test covers a save with an extra mod, not a game with a mod the save
    lacks); one plausible (no test covers mines running out).

  No scout used library search or the librarian, the same as workers.

### Scouts and the decision register (2026-11-21, phase 2 of the scouts plan)

- **A scout run is a run with `kind = scout`**, fixed at `start()` from its ticket: each repo has one
  hidden runner ticket per scout type (`source: scout-run:<type>`), back to `todo` after every run.
  It reuses the run machinery (slots, queue, permissions, live cost, kill, events). Its workspace at
  trunk is scratch: it may build and make throwaway edits, nothing lands, and the workspace is removed
  on any ending. `launch()` and the success path branch on the row's kind, so a scout resumed after a
  restart keeps its prompt and tools and finishes as `done` without checks or review. Landed-run
  summaries in the library are work runs only.
- **Trunk results first.** Setup steps and the declared command checks run through the real paths
  before the scout starts (its shell differs from the check sandbox), and their results go into its
  prompt. For a scout, a failure there is a finding, not a run failure.
- **Lenses live in Acutis** (`core/scouts.ts`): Infrastructure and Tests so far. The workflow's
  `scouts:` only turns them on or off and sets `focus`, `budget_usd` (default $2) and `auto_tickets`.
- **Filing.** `propose_ticket` goes to todo at high confidence unless `auto_tickets: never`, otherwise
  to Proposed. `depends_on` holds it on an open decision. Titles are matched at write time against every
  ticket in the repo, so a duplicate or a ticket the operator rejected isn't filed again. A noticed
  report turned into a ticket is marked ticketed only when the ticket is accepted. The limits are 5 tickets
  and 5 questions per run. Budget: the live-cost poll finishes a scout that goes over mid-turn, keeping
  what it filed, and the SDK's `maxBudgetUsd` is a hard backstop (set to what's left of the budget;
  its `error_max_budget_usd` result finishes the scout rather than failing it). A done ticket doesn't
  block filing the same problem again.
- **Decision register**, not a question queue: a scout's question (open) and the operator's answer
  (decided) are one row; a decided row is never edited, only superseded. Open questions are ranked by
  the tickets held on them, then age. Scouts can update, withdraw or merge open questions of their
  own type, and every edit bumps a version an answer must match. The operator writes the decision text,
  to stand alone, because only that text goes into every worker's and scout's prompt (under "written by
  the human operator"); the scout's question is not repeated there. In the library a decision carries its
  question, labelled as the scout's. Other scout-written text (tickets, noticed reports, open questions)
  reaches a scout only as labelled data in its first message. When deciding, held tickets the operator keeps go to
  todo, those explicitly dropped are cancelled, and any others (say, one filed after they looked) go to
  Proposed, so nothing is dropped unseen. A restart during a scout's preparation releases its runner ticket.
- **First real run** (copy of stahl with its full workflow, $0.98 of a $2 budget, 30 turns). All five
  checks passed on trunk. The scout filed `clippy --all-targets` failing at four exact places (high,
  straight to todo), unused `bevy_rand`/`rand_core` in the game crate (proposed), and asked whether to
  pin the Rust toolchain, holding a ticket on it. All three were re-checked by hand and are true.

### Project library and noticed reports (2026-11-21, phase 1 of the scouts plan)

- **Library.** When a run starts, the repo's docs at its base commit are indexed into SQLite FTS5
  (`core/library.ts`), once per commit. Candidates are the files jj tracks at that commit, read
  from the fresh workspace *before* setup steps run, so neither setup output nor the worker's edits
  get in. Only plain files whose real path is inside the workspace are read (a tracked symlink to
  `~/.ssh` or the API token would otherwise be served by a tool that runs outside the sandbox),
  up to 256 KB, not binary. Markdown is chunked by heading, at most 2,000 characters (over-long lines are split), and keeps its start line.
  `library:` in the workflow sets the include/exclude globs, or `false` turns it off. Indexed
  commits that no live run uses are pruned. Indexing failure warns and never fails the run.
- **What else is in it.** The ticket and final report of landed runs, labelled as worker-written.
  Not operator notes (already in every worker's prompt) and not review notes (documented as never
  reaching the agent).
- **Tools.** `search_project` returns at most 10 excerpts within about 6,000 characters, with `path:line`.
  `read_project_entry` opens one. Probe on a copy of stahl (38 docs, 757 sections): the worker
  searched unprompted, once; the result was 2,818 characters and pointed it at the two wiki pages it
  then read whole with `cat` (never `read_project_entry`). Docs were about 45k characters of its
  reading against about 89k of code and other output. That meets phase 1b's trigger ("search alone leaves workers
  reading whole files"), but one run with no control can't show whether summaries would cut it:
  1b is undecided.
- **Noticed reports.** `report_noticed` records a problem outside the ticket (title, detail,
  evidence, kind), capped at 10 per run. Reports with the same normalised title in a repo merge and
  count, whatever the earlier one's status: a dismissed or ticketed problem isn't reopened by the next
  worker, unless its ticket is done. They outlive their run. The operator dismisses one or makes a ticket of it (dashboard
  panel, `acutis noticed`), and the ticket says the text is worker-written and unchecked, since it
  becomes a future worker's prompt. The probe's worker filed a real-looking bug: `VehicleDef` has no
  `deny_unknown_fields`, so `validate-mods` accepts misspelt fields.

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
  (`search_project`, `read_project_entry` and `report_noticed` always; `preview` and `browser`
  when the repo's workflow declares a `preview`).
  The browser tool takes a path, never a URL. Its headless Chrome fails every request to another
  origin made by the page, its dedicated workers, iframes and popups (browser- and page-level CDP
  `Fetch` interception; new targets are auto-attached paused, and popups are closed), so the
  browser tool can't be used to drive the dashboard on 127.0.0.1:7777. WebSocket handshakes are
  not intercepted; the dashboard's `/ws` refuses foreign origins and is receive-only. This covers
  the browser tool only. Without the MCP restrictions, a worker picked up the owner's claude.ai
  connectors a few seconds into the session (verified 2026-11-19).
- **The API needs a token.** Every `/api` and `/ws` request carries the daemon's token
  (`$ACUTIS_HOME/token`, 0600, persisted): the CLI reads the file, and the dashboard gets it once
  from the link `acutis serve` prints (`#token=…`) and keeps it in `localStorage`, which is scoped
  per port. It is not a cookie: cookies ignore the port, so the browser would send one to the
  worker-written preview on "Open preview". Gates and previews run with `$ACUTIS_HOME` hidden, the
  agent's file tools and sandbox (`filesystem.denyRead`, `Read(//…)`) deny the token file, and the
  token never goes into the environment. **Verified 2026-11-21** with a real-agent probe ($0.16): Read
  and `cat` of the token are denied, and the API is unreachable. Every host Unix socket tried (session/system
  D-Bus, docker.sock, ibus, wezterm, nix-daemon) is refused: Claude Code's agent sandbox blocks Unix sockets
  outright (`listen` gets EPERM). So the socket hole below is in Acutis's gate/preview sandbox only. **Limit:** with the sandbox off, worker code runs as you and can read the file
  without naming it (`bun test` running a test that opens it), so there the token raises the bar
  but is not a boundary.
- There is no blanket `Read` allow. Reads inside the workspace are automatic,
  reads outside ask the operator, and credential paths (`~/.ssh`, `~/.aws`,
  gh, Claude credentials…) are hard-denied. Verified with a real-agent probe
  on 2026-11-19.

### Implementation notes (dogfood follow-ups, 2026-11-20)

- **Cost:** the SDK's `total_cost_usd` is a running total per `query()` (and a resumed session
  continues from its saved total). Runs add the delta per result, not the total.
- **Live and killed-turn cost (2026-11-21).** Results only arrive when a turn ends, so a killed turn
  (and the turn cut off by a restart) showed $0.00. The session is now polled for its running total
  (`AgentSession.totalCost`): at most every 5s while it emits events, once more before a kill closes
  it (capped at 2s), and right after a resumed session starts. The SDK has no stable call for this.
  `totalCost` uses `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` (verified on 0.3.329:
  about 150ms mid-turn, the same running total results carry). If it breaks, cost goes back to
  updating per turn. The last total seen is stored per run (`session_cost`), because a resumed session's
  restored total includes spend after our last look: a probe polled $0.00013, closed mid-turn, and
  resumed at $0.0119. Comparing with `session_cost` counts that tail once, and it is logged as
  "spent in an earlier, interrupted turn". A poll reply that a turn result overtook is ignored, and
  a resumed session's first total that comes back *below* what was counted rebaselines without adding.
  Each turn's `turn_cost_usd` still covers the whole turn. A kill only waits for the poll while the
  agent is mid-turn (`running`): in any other state, waiting would let a killed check be reported
  as a failure. **Verified 2026-11-21 with the real runner:** cost rose live ($0.09 → $0.11) and a
  killed run kept it. A daemon SIGTERM'd mid-turn at $0.098 resumed, recovered $0.007, and ended at
  $0.143, equal to the session's own total.
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
