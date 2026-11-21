# Trials: duke-ml, stahlsenshamädchen, hegel-triangles (2026-11-20)

The second dogfood round, on real repos instead of a toy. The sandbox is on for all of it.

## Setup
- **Clones, not the originals.** Each repo is a jj clone in `~/Workspace/acutis-trials/`:
  - `duke-ml` from the local repo, whose `main` is 13 commits ahead of origin;
  - `stahl` from `feat/slice`, the active line;
  - `hegel-triangles`, a plain copy plus `git init`, since the original has no VCS.

  `repo add --init-jj` on the user's own checkouts was ruled out: `land: trunk` leaves a colocated
  checkout detached, and the user's branches and HEAD must not move. Results go back as one new branch per
  repo, with `git fetch <clone> acutis-trial:acutis/trial`, which moves no checkout. Nothing is pushed to any remote,
  and duke-ml's `main` auto-deploys.
- **Policy commit on a trial bookmark.** The `acutis-trial` bookmark (hegel: `main`) holds `.acutis/workflow.md`.
- **The clones had no identity.** jj had no global user, so I set the repo-level jj user from git config.
- **Baselined every gate on the untouched base, sandboxed, before writing tickets** (`scratchpad/probe.ts`):
  | Repo | Result |
  |---|---|
  | duke-ml | `npm ci --prefer-offline` takes 2s (setup, host). engine, ai and harness tests are green in the sandbox. **The harness `build` script fails on base**: no tsconfig, it's only ever run with tsx. It's left out of the gates. |
  | stahl | `cargo fetch` + `cargo build -p tactics_core --all-targets` takes 27s (setup). `cargo test -p tactics_core --offline` in the sandbox, with a read-only `~/.cargo`: 31 binaries, 0 failed, 55s. **Clippy `--all-targets` fails on base**, with a rust 1.100 `manual_slice_fill` lint in `tests/assault.rs`. `--lib --bins --examples` is clean, so that's the gate. fmt and validate-mods are green. |
  | hegel | **Base doesn't build**: missing `$lib/prompts`, and prettier flags 3 files. The first ticket fixes this, so red gates on base are expected. |
- **What the sandbox didn't break:** cargo offline with a read-only `CARGO_HOME`, npm/vitest/tsx, and bun
  with svelte-check/vite all work inside bubblewrap with no network. Nothing needed `$HOME` writes.
- **Determinism guard for stahl:** the snapshot checksum is *in the gate command* (trunk policy). A workspace
  file holding the hash would be editable by the agent.

## Log
- **Started runs 5–8 together:** duke-ml ×2 (seeded RNG; match CLI), stahl (strict orders file), hegel (offline loop).
  This is the first real use of parallel runs, two of them on one repo.
- **Too many prompts under the sandbox.** Within minutes there were 7 Bash prompts across the runs. All of them were Claude Code
  saying it couldn't statically check a command (heredoc, `( … )` group, `$TMPDIR`, `python3 - <<EOF`). Under the sandbox
  those commands run in bubblewrap anyway, with unsandboxed retries off, so the prompt guards nothing.
  **Fixed:** `canUseTool` allows Bash when the session is sandboxed (and not if `dangerouslyDisableSandbox` is set).
  Network is a separate `SandboxNetworkAccess` request and still asks.
- **A worker asked to load the `claude-api` skill** (hegel, which has to pick a model id). It's a Claude Code
  built-in, and it reached the operator because `Skill` isn't allowlisted. Allowed. A repo's workflow could list allowed skills
  (SDK `skills: [...]`).
- **Daemon restart under load, for real:** I restarted the daemon with 4 runs mid-turn. All 4 came back `paused`
  ("press Resume"), no agent processes were orphaned, and `acutis resume` restarted each session. The killed turns showed
  $0.00, which is the known "killed-turn cost" gap.
- **Sandbox placeholder files.** While a sandboxed command runs, Claude Code mounts empty read-only files over about 20
  config paths in the workspace: `.bashrc`, `.gitconfig`, `.gitmodules`, `.mcp.json`, `.idea`, `.vscode`,
  `.claude/settings.json`, `.claude/hooks` and others. Two workers flagged them as "not mine, don't land". They vanish when the
  command ends, but a jj snapshot taken meanwhile (or after a crash) would record them. **Fixed:** the jj provider
  deletes files that are empty, not owner-writable and untracked in the base (top level and `.claude/`) before
  `diff`, `changedFiles` and `land`. There's a test, which fails with the guard off. A tracked read-only empty file is kept.
- **`tsx` can't run inside Claude Code's sandbox** (`listen EPERM`: it opens an IPC socket). Both duke-ml workers
  hit it and worked around it with `node --import tsx`. Acutis's own gate sandbox allows Unix sockets in its private
  `/tmp`, so the harness gate passes. That's a difference between the agent's sandbox and the gate's sandbox worth knowing about.
- **Run 5 (seeded RNG): $0.46, 1 attempt.** The diff is small (+8/−4 in `minimax.ts`, default `Math.random`, so the web
  worker is unchanged). Four tests: same seed gives the same move, nodes and RNG calls (with `ttClear` between); the RNG really picks the
  tile (0 picks the first, 0.999999 the last); the positional depth still works; `scoreRootMoves` too. **Approved and landed on `acutis-trial`.**
- **Run 6 (match CLI): $0.95, gates green, but it would have broken every later run.** The diff added `@the-duke/ai` to
  the harness's `package.json` without updating `package-lock.json`. The worker said so, but gates don't run `npm ci`, only
  setup does, so the next run's setup would fail. Sent `acutis msg` asking for an offline `--package-lock-only` update.
  - **Correction:** the worker tested this and showed I was wrong. A real offline `npm ci` in temp copies accepts the *old*
    lockfile too, because npm doesn't count a missing `*` workspace dependency as out of sync. It updated the lockfile anyway
    (3 lines, via `npm install --package-lock-only --offline`, no hand edits). A good pushback.
  - **Idea (still valid in general):** a gate that re-runs the setup steps would catch "this change breaks setup".
  - Its measurements: depth 2 beats random 38–2; depth 3 beats depth 2 8–1–1 (10 games, wide interval).
  - It also fixed a real bug: `runMatch` rounded half-point draws before computing the Wilson interval.
  - It also makes the CLI swap in a seeded generator for `Math.random` for the whole match. That's hacky, but it covers the engine's own
    draws too.
- **Run 6 landed through the rebase path, for real:** it was approved after run 5 had moved `acutis-trial`. Acutis rebased it, re-ran
  all 4 gates on the combined tree (all green), then advanced the bookmark. $1.12 total, including the lockfile follow-up.
  - Small UI nit: `watch` labels gates by command, not by their `name:`.
- **Queued run 9:** quiescence search, measured with the match CLI from run 6 and the seeded RNG from run 5. This is the "working with the AI" ticket.
- **Run 7 (stahl strict orders): $0.67, 1 attempt. Approved and landed.**
  - Found something the ticket missed: Cargo doesn't run an example's unit tests by default, so it added `[[example]] test = true`
    and wrote down why.
  - Replaced two `expect` panics with a `thiserror` enum, as stahl's CLAUDE.md asks.
  - Its tests are named as sentences. It also checked the real CLI end to end with a typo'd file (exit 2, names the field and file).
  - **Exit 137 on its first `cargo test`** (3 other runs busy), which the worker read as OOM and retried with `-j 2`. The
    machine has 46 GB (34 available), so that's doubtful. A SIGKILL from the Bash tool's own timeout on a cold build is likelier,
    but unverified. Either way, Acutis has no concurrency limit and no notion of resources. A per-daemon `max_parallel` (or per-repo `concurrency:`)
    and a gate `jobs` hint would help.
- **Run 8 (hegel offline loop): $1.98, 1 attempt. Approved and landed.** The page went from four mis-positioned CSS triangles to an
  SVG triforce: Thesis bottom-left, Antithesis bottom-right, Synthesis on top, inverted pale centre. Text wraps to each
  triangle's shape and is editable in place. Steps are generated in order, and later steps are marked stale when an earlier one changes.
  The server validates input (400s) and has a clearly marked offline mode. The browser gate passed, and its screenshot looks right at 1280x800.
  - It used the preview and browser tools at both sizes, including deliberately bad requests.
  - **It added API settings it couldn't test** (`output_config.effort: low`, `fallbacks: "default"` + `server-side-fallback-2026-07-01`)
    and flagged them as untested. I checked both against the `claude-api` reference before approving: both are real and correctly
    shaped, and `"default"` is the recommended fallback form for `claude-sonnet-5-5`.
  - Removed a `tsconfig.json` `include` override that was hiding SvelteKit's generated `$env` types. That was a real cause of the
    `$env` check failure, and it was explained.
- **Run 10 (stahl planner field): $0.95, 1 attempt. Approved and landed.** The best-reasoned run so far.
  - It read both sites and showed they mean the same thing (one site's own comment says it's priced "exactly as" the other).
    So it used one field, and named it `objective_arrival` because the value is a reward step, not a reach.
  - It added the value to `mod.json` (an existing test requires base data to equal the defaults), and a `validate-mods` warning
    for negative values.
  - It **checked that its test catches the old behaviour by putting the literal back at each site** and watching the test fail at that site.
  - The snapshot is byte-identical, enforced by the checksum gate. No rebase was needed (it started after run 7 landed).
- **Queued run 12:** stahl heatmap strict flags (`--game 4` is silently ignored today).
- **Run 11 (hegel recursive dialectic): $2.62, 1 attempt. Approved and landed.** Each level is drawn inside the previous synthesis,
  and the camera zooms so the current triad is always full size. The parent's base peeks in underneath ("↓ Back to level n"),
  there's a level bar, and `[`/`]` keys. The chain is in the URL fragment so links can be shared. Stale marking cascades down the chain, and an
  "Update n out of date" button regenerates top-down. A synthesis and the next thesis are *one* statement, not a copy. It was
  checked with 8 levels, a reload restore, and 390x844. Screenshots look right.
  - **The placeholders bite tools too:** its `prettier .` crashed on the sandbox's unreadable mounted dotfiles, so it linted the real
    files directly. The gate (Acutis's sandbox, no placeholders) ran `bun run lint` green. A cleaner fix than pruning afterwards would be
    for Acutis to give Claude Code's sandbox a config that doesn't mount over the workspace, or to put the workspace's
    `.claude/` etc. on an ignore list the tools respect. Open.
- **Run 12 (stahl heatmap strict flags): $1.61, 1 attempt. Approved and landed.** `--game 4` now gets "unknown flag `--game` (did
  you mean `--games`?)" and exit 2 in about 1 ms, with nothing loaded. There's one `FLAGS` table for both the parser and the usage text, plus a test that the
  doc comment and parser agree. All 18 existing flags were kept; the doc comment had been missing 3 of them.
  - It found **two more silent fallbacks** the ticket didn't name: an unknown `--planner` silently ran utility while the title
    printed the typo, and an unknown `--vehicle` counted nothing.
  - It went stricter than asked (refuses flags the chosen mode wouldn't read; single-value flags given twice) and asked whether that's wanted.
    That's a design call for the user.
  - It's a 1.1k-line diff, mostly moving the battle code into `battles()`. A reviewer has to trust the tests plus the gates here. A behaviour
    diff of a short real heatmap run, before and after, would be a nice gate for instrument refactors.
- **Run 9 (duke-ml quiescence): $4.27 for the first turn. Real AI research.**
  - **Noisy moves:** captures, strikes, and *capturing commands*, plus all evasions when in check (so it finds mates a ply earlier).
    It has a stand-pat bound, MVV ordering and a cap of 6 extra plies. Quiescence TT entries are stored at depth 0, so they never overwrite deeper ones.
  - **Strength at equal depth vs the old search:** 0.92 / 0.94 / 0.84 / 0.81 / 0.84 / 0.80 at depths 1–6 (400 games per row down to 64),
    with plain-vs-plain controls at 0.49. **At roughly equal time** (q:d vs plain:d+1) the edge shrinks: 0.79 → 0.71 → 0.55 (not significant at 5 vs 6).
  - **It found and fixed two existing bugs:** (1) the aspiration window kept searching the root with an inverted window after a fail,
    which wrote bad TT entries, so `findBestMove` sometimes missed a forced mate that `scoreRootMoves` found; (2) Float32 TT scores caused 16
    mismatches in 150 games, so they're now Float64.
  - It checked that its tests catch the old behaviour (dropping capturing commands from the noisy set fails the command test).
  - **It turned quiescence on by default, which I pushed back on.** That changes the live web AI (depth 6, about 0.2 s/move to about 1 s) and the
    minimax that generates training data, for a gain its own equal-time numbers don't show at depth 6. I sent `msg` asking for it off
    by default, with everything else kept. Shipping it is the owner's call.
  - **The workflow is good at this.** The seeded RNG (run 5) plus the match CLI (run 6) turned "is it stronger?" into a table with
    confidence intervals and controls, which is objective evidence a reviewer can act on.
- **Run 9 follow-up ($0.54 more, $4.81 total):** quiescence is now off by default, with a test pinning it, and the `minimax-rng` tests are restored
  unchanged. `minimax:<d>` follows the default. Kept: the option, the `-q`/`-noq` specs, both bug fixes and the quiescence tests. Landed.

## Results
| Run | Repo | Ticket | Cost | Attempts | Outcome |
|---|---|---|---|---|---|
| 5 | duke-ml | seeded RNG for minimax draws | $0.46 | 1 | landed |
| 6 | duke-ml | minimax agent + match CLI | $1.12 | 1 (+1 msg) | landed via rebase onto run 5 |
| 9 | duke-ml | quiescence search, measured | $4.81 | 1 (+1 msg) | landed, off by default |
| 7 | stahl | strict orders file | $0.67 | 1 | landed |
| 10 | stahl | `objective_arrival` planner field | $0.95 | 1 | landed, snapshot identical |
| 12 | stahl | heatmap strict flags + `--help` | $1.61 | 1 | landed |
| 8 | hegel | offline dialectic loop (SVG) | $1.98 | 1 | landed |
| 11 | hegel | recursive dialectic | $2.62 | 1 | landed |

**8 of 8 landed, all with gates green on the first attempt; $14.22 total.** Two runs got a reviewer `msg`. One was a lockfile question,
where the worker showed my concern was wrong. The other was a default I reversed for owner-decision reasons. No run needed a retry.

**Delivered:** `acutis/trial` was fetched into `~/Workspace/duke-ml` (on top of local `main`) and `~/Workspace/stahlsenshamädchen` (on top of
`feat/slice`). Nothing was pushed, and checkouts are unchanged. hegel-triangles has no VCS, so the result lives in `~/Workspace/acutis-trials/hegel-triangles`
(jj/git, `main`).

## What this round says about Acutis
- **Works:** sandboxed agents and gates across Rust, npm/TS and SvelteKit with no network; parallel runs, including two on one repo
  landing through rebase and re-check; daemon restart and resume mid-turn; `msg` for review follow-ups; the gate as policy
  (the stahl snapshot checksum held, and every worker respected it); and screenshots as review evidence (hegel).
- **Fixed during the round:** gates and previews were unsandboxed; Bash prompts under the sandbox guarded nothing; sandbox placeholder
  files could land.
- **Open, by priority:**
  1. ~~**The preview server can reach the Acutis API** (host network). Needs the per-daemon token.~~
     **Done (2026-11-21):** the API needs a token, and sandboxed previews get their own network namespace with the port relayed out.
  0. **New, highest (2026-11-21): host Unix sockets are reachable from gates and previews.** Inside `BwrapSandbox`,
     the session D-Bus (`systemd-run --user` runs a process outside the sandbox) and `/var/run/docker.sock` both connected.
     `/run` is now hidden (stopgap); sockets under `$HOME` and elsewhere remain. See `notes/container-sandbox-plan.md`.
  2. **Placeholder files still confuse tree-walking tools** inside the agent's sandbox (`prettier .`). Find a way not to mount them.
  3. ~~**No concurrency or resource limits**~~ **Run limit done (2026-11-21):** `ACUTIS_MAX_RUNS` (default 3), extra runs queue.
     The exit 137 wasn't an OOM kill: there's no kernel OOM record for Nov 20, so it was likely the Bash tool's timeout. Resource limits (memory, CPU) are still open.
  4. ~~**Killed-turn cost** is still invisible~~ **Done (2026-11-21):** cost is polled live, before a kill, and after a resume.
  5. ~~**Agent sandbox vs gate sandbox differ**~~ **Documented (2026-11-21):** the worker prompt says the agent's shell has no Unix
     sockets (Claude Code blocks them) and to use `node --import tsx`. The two sandboxes still differ.
  6. **The reviewer still has to judge "owner decisions"** (run 9's default). A workflow field like `ask_before:` ("changing
     defaults that affect the web app or training") could make workers stop and ask instead.
  7. Small: `watch` labels gates by command, not name; a "re-run setup" gate would catch setup-breaking changes.
