# Dogfood: building a slide-and-merge tile puzzle (2048-style) with Acutis

Date: 2026-11-20. Operator: Claude (driving Acutis via CLI + HTTP API).
Target repo: `~/Workspace/tile-merge` (fresh git repo, `.acutis/workflow.md` committed to `main` first).
Acutis commit: a1756c3. Sandbox: off on this machine (AppArmor userns restriction, known — DESIGN §6).

## Log

1. **Repo registration.** `repo add` without `--init-jj` refused with a clear, actionable message;
   with `--init-jj` it colocated jj and auto-detected `main` as base. Smooth.
   - jj identity is unset in this repo (`(no email set)` on the new working-copy change). I assumed
     Acutis's `JJ_USER`/`JJ_EMAIL` fallback would cover this at land time. **Superseded by #15: it
     didn't.** `repo add` doesn't check or mention it.
2. **Daemon start.** `serve` created `~/.local/share/acutis` on first run and printed the exact
   sandbox-off reason. Good.
3. **Ticket + start via CLI.** `ticket add` / `start` worked and printed a deep link to the run.
   Run 1 went preparing → running in ~1s; workflow correctly loaded from `main@78fb200a`.
4. **First tool call needed approval.** The worker's very first command was a compound
   `git ls-files && cat ... ; bun --version`, and it blocked on the operator ~5s into the run.
   Either `git ls-files` or `bun --version` triggered it (both are outside `DEFAULT_ALLOW`); I can't
   tell which. A prompt has no timeout, notification or fallback, so an unattended run stalls there
   until someone answers. *Correction (see #7a): not every non-allowlisted command prompts.*
5. **Operating headless.** No CLI for permissions / diff / approve / message: I had to write
   `curl` + `jq` scripts against `/api/runs/:id` and poll it (no CLI `watch`/`tail` command; the
   WS feed is the only push channel).
6. **Dashboard (headless Chrome screenshot of `/#run-1`).** Clean and readable. Nits: ticket body
   rendered as raw markdown (`**`, backticks); the long body pushes the activity log below the fold;
   repo `<select>` truncates to "tile-mer"; cost shows `≈$0.00` until a turn finishes.
7. **Allowlist escape (sandbox off).** Event #29, run 1: a single compound command
   `printf 'dist/\n' >> .gitignore && ... && bun build ./src/main.ts --outdir /tmp/tm-check`
   ran with **no prompt** and wrote `/tmp/tm-check/main.js` outside the workspace. Prefix rules like
   `Bash(bun build:*)` don't constrain arguments, so "Edit/Write confined to the workspace" doesn't
   hold for Bash. Harmless here, but it means the allowlist is not a write boundary without bwrap.
   The worker then asked to `rm -rf /tmp/tm-check` (prompted, because the path is outside cwd) —
   so the asymmetry is: creating outside files is silent, cleaning them up asks.
   - **7a. The effective auto-allow set is wider than the allowlist (mechanism unconfirmed).** These
     ran **unprompted** although they're not in `DEFAULT_ALLOW` or the repo allowlist:
     `printf ... >> .gitignore` (#29), `rm -rf dist` inside the workspace (#108), plus
     `git status --short` chained after them. These **prompted**: the first command (#6), `rm -rf
     /tmp/tm-check` (#31, outside cwd, `blockedPath` set) and `python3 - <<EOF` (#62). My guess is
     Claude Code's `acceptEdits` mode auto-approves some file-manipulating shell commands inside cwd,
     but I didn't confirm that. Either way, the daemon's banner "any other command asks you in the
     dashboard" overstates the protection, and Acutis has no record of *why* a command was
     auto-allowed.
8. **First pass result.** 13 turns, 229s, ≈$0.68 API-equivalent. Gate `bun test` passed in 43ms →
   `awaiting_review`. Diff: 7 files, ~1180 lines. The worker's closing summary was honest and
   useful: it said it **could not play-test the UI because it isn't allowed to start a dev server**
   and that nothing type-checked the code (no `tsc` without deps). That's the real ceiling on quality
   today: gates are shell-only and the worker can't see the app (known: DESIGN §5/M2 env provider,
   M3 screenshots — but this run shows it bites even for a zero-dependency static page).
9. **My own verification (outside Acutis).** Re-ran tests + build in the workspace; served the
   built `dist/` and drove 64 key presses through headless Chrome: board changed on 60–64/64 moves,
   score/best update, best persists in localStorage, no JS errors, layout fine at 390px. Not
   exercised: touch swipes, win/game-over overlays (logic covered by unit tests). Acutis had no
   place to attach this evidence (screenshots, notes) to the run.
10. **Send back with a note** (POST `/message` while `awaiting_review`): resumed the same session
    (`agent.init` again, state `awaiting_review → running "session resumed"`), worker picked up the
    review request immediately with full context. Works well. CLI has no command for it.
11. **Pause / resume.** Pause mid-edit → interrupted turn ended `error_during_execution`, run went
    `paused` (not failed), session stayed live; Resume sent "Continue working on the ticket." and it
    carried on. Clean.
12. **BUG: cost is over-counted.** `runs.ts` does `cost_usd: run.cost_usd + ev.cost_usd` for every
    `agent.result`, but the SDK's `total_cost_usd` is *cumulative* within a `query()` and a resumed
    session "continues from the total its transcript saved" (sdk.d.ts ~L6265). After pausing the
    resumed session, the result said $0.738 (which already includes the first $0.68) and Acutis
    stored $1.42. Every resume and every gate-retry turn inflates the figure. Fix: track the last
    seen total per session and add only the delta (or store max per session_id).
13. **Deny with a message works.** Event #63: worker tried a `python3 - <<EOF` heredoc to bulk-rewrite
    `tests/game.test.ts` (prompted — python isn't allowlisted). I denied with "use the Edit tool so the
    operator can review edits"; it immediately switched to Edit (#66–#78, ~7 sequential edits). Good
    steering. Gaps: (a) the operator has to read a truncated heredoc in the prompt to judge it — the
    dashboard/API shows the full input but there's no "this writes files X" summary; (b) there's no
    way to make that guidance durable ("prefer Edit over scripts") short of editing the workflow
    template on trunk — a per-repo "operator notes" or learned-rules list would help.
14. **Undo pass result.** 26 turns, 86s, SDK running total $1.08 (Acutis shows **$2.50** =
    0.68+0.74+1.08 — confirms #12). 34 tests (6 new), gate passed. Worker listed the judgment calls
    it made beyond the spec (undo restores win/over flags, works from the Game-over overlay, best
    never decreases) — exactly what a reviewer wants. I verified Undo in headless Chrome (disabled at
    start, enabled after move, U restores board+score, disabled after use, button works, no errors).
15. **Approve/land.** `approve` → `done`, bookmark `acutis/1-build-the-tile-merge-puzzle-game`
    (visible to git as a branch), workspace dir removed. 7 files, +1267.
    - **BUG: landed commit has an empty identity.** `git log` shows author *and* committer
      `JJ_EMPTY_STRING <JJ_EMPTY_STRING>`. Root cause: `identity()` in
      `src/providers/workspace/jj.ts` runs `jj config get user.*` in the *daemon's* cwd (the Acutis
      checkout, which has a repo-level jj identity), not in the target repo, and caches the result
      process-wide. In `tile-merge` jj has no identity, so no `JJ_USER/JJ_EMAIL` fallback was applied.
      Fix: resolve identity per repo (`.cwd(repo.path)`) and cache per repo; or have `repo add` check
      and offer to set `jj config set --repo user.*` from git.
    - **Trunk doesn't move.** `main` stays at the scaffold commit; the work lives only on the bookmark.
      Expected per design (`land: bookmark`), but it means a second ticket would branch from old
      `main` and not see this work. There's no "merge into trunk" / "advance base" land mode, and
      `land: push` only pushes the bookmark. For a multi-ticket project the operator must merge by hand
      between tickets.
    - The run record keeps `workspace_path` after the directory is deleted (stale field; minor).
16. **Kill + discard** (throwaway ticket #2, run 2): kill right after `agent.init` → `cancelled`,
    workspace kept; discard → workspace dir removed, jj workspace forgotten, change abandoned, ticket
    back to `todo`. Clean. Killed run shows cost $0 — spend on a turn that never produced a `result`
    is invisible. Cancelling the ticket needed the API (no CLI command).
17. **Dashboard after landing.** Header shows the inflated `≈$2.50` right next to the last turn's
    `≈$1.082`. Agent summaries also render as raw markdown. The cancelled ticket #2 and its run are
    **not listed** — the sidebar only has Review / In progress / Todo / Done. The run is still
    reachable by direct URL (`/#run-2` renders its log fine), but there's no way to find it.

## Summary

Outcome: a working, tested, original-looking 4×4 slide-and-merge game ("Tile Merge", 2048 rules,
plus a one-step Undo added via send-back) on bookmark `acutis/1-build-the-tile-merge-puzzle-game` in
`~/Workspace/tile-merge`. 2 worker passes, roughly 40 turns and 5–6 min of agent time, ~$1.08
API-equivalent (Acutis reports $2.50). Landed bookmark re-verified from a `git archive` export:
34 tests pass, build succeeds. Operator interventions: 3 permission prompts (2 allowed, 1 denied with
guidance), 1 review note, 1 pause/resume.

### Works well
- **The core loop is solid.** Ticket → workspace → agent → gate → review → bookmark worked first time
  with no Acutis errors. State transitions are clear and visible in the log.
- **Session continuity.** Send back with a note and pause/resume both reuse the same session, so the
  worker keeps full context. The pause interrupt was handled as expected, not as a failure
  (redirect uses the same mechanism but wasn't exercised).
- **Policy from trunk** loaded correctly and was shown in the log with its commit hash.
- **Deny with a message** steers the worker well (it switched to Edit immediately).
- **Workspace hygiene.** Approve and discard both clean up jj workspaces properly; parallel-safe paths.
- **Setup ergonomics.** `repo add` errors are actionable; base auto-detected; sandbox reason printed.
- **Worker summaries** (driven by the system prompt) are honest about what wasn't verified.
- **Dashboard** looks clean and the activity log is easy to follow (based on static screenshots only).

### Bugs found
1. **Cost over-counting** (`src/core/runs.ts`, `agent.result` handler): sums the SDK's cumulative
   `total_cost_usd`. It inflates on every resume and every gate retry. Fix: add the delta from the
   previous result in the same session.
2. **Empty commit identity on land** (`src/providers/workspace/jj.ts` `identity()`): checks jj config
   in the daemon's cwd, not the target repo, and caches it globally. Landed commit author/committer =
   `JJ_EMPTY_STRING`.
3. **Cancelled tickets/runs aren't listed in the dashboard** (no column for them; direct URL only).

### Hard / missing (in rough priority order)
1. **The worker can't see what it built.** No dev server, no browser and no screenshot gate, so UI
   behaviour went unverified until I tested it by hand in headless Chrome. Even a static page needs
   this. Known roadmap item (M2/M3), but it's the biggest quality lever: a minimal `serve: bun
   ./index.html` + Playwright/headless-Chrome screenshot gate, with no Compose needed, would have
   caught most UI issues.
2. **Unattended runs stall on permission prompts.** With the sandbox off, a prompted command blocks
   until someone answers (the very first, read-only call did). Meanwhile some non-allowlisted commands
   are auto-allowed (#7a), so the prompting is both too eager and not a real boundary. Ideas: a read-only
   auto-allow tier, notifications (desktop/ntfy), a timeout → auto-deny with a message, and
   "Allow for this repo" that writes back a suggested `permissions.allow` diff to trunk.
3. **Allowlist is not a write boundary without bwrap.** `Bash(bun build:*)` let the worker write to
   `/tmp`. Document clearly, or check `--outdir`/redirect targets, or treat "sandbox off" as
   "prompt for all non-read-only Bash".
4. **No headless operator surface.** The CLI covers `ticket add/ls` and `start` only. Missing:
   `watch/tail <run>`, `perms`/`allow`/`deny`, `diff`, `msg`/`send-back`, `approve`, `kill`, `discard`,
   `ticket cancel`. I had to write curl/jq scripts and poll. (This also matters for driving Acutis
   from another agent.)
5. **Trunk never advances.** Multi-ticket projects need a land mode that merges or rebases onto trunk
   (with re-verify, which is M3), or at least a `repo advance` command. Otherwise ticket 2 can't build
   on ticket 1.
6. **No type-check gate possible in a zero-dependency repo.** The worker couldn't run `tsc`. Consider
   letting the workflow declare a bootstrap step (known: DESIGN §5 row 5) so `bun install` +
   `bunx tsc` can be a gate.
7. **No place to attach reviewer evidence.** Screenshots or test notes from the human or another agent
   can't be added to a run. Review comments are only chat messages.
8. **Operator guidance isn't durable.** "Prefer Edit over python scripts" had to be said live; there's
   no per-repo learned-rules list short of editing the trunk workflow template.
9. **Dashboard polish.** Render ticket bodies and agent text as markdown; collapse the ticket body so
   the log stays above the fold; widen the repo select; show live cost; add a Cancelled/All filter.

Not exercised this session: Redirect (mid-turn interrupt plus new instruction), gate-failure retry
(the gate never failed), daemon restart recovery, parallel runs, `land: push`. The dashboard was only
checked through three static headless screenshots: its permission-prompt UI, Diff tab, buttons and
live WebSocket updates weren't used. Every operator action went through the HTTP API.

---

## Follow-up: fixes (2026-11-20, same day)

Verified with `bun test` (50 tests, 6 files, after the review round below; `FakeRunner`, plus real headless Chrome for the
browser driver), `bunx tsc --noEmit`, two cheap Haiku SDK probes, and a second real ticket on
`tile-merge` (run 3, "Add a moves counter": 21 turns, 104s, ≈$0.59; landed on `main` via
`land: trunk`; all 40 game tests pass on trunk).

### Bugs
| # | Finding | Status | How verified |
|---|---|---|---|
| 1 | Cost over-counted | **Fixed.** `costDelta()` adds the change in the SDK's running total, per live session, handling resumed sessions and resets. The event keeps the SDK total and adds `turn_cost_usd`. Run 1's stored cost corrected to $1.08 in the DB. | Unit + integration test (gate retry, then resume). Run 3 showed `+$0.595` for its turn. |
| 2 | Empty commit identity | **Fixed.** `identityFor(cwd)` resolves jj/git identity in the directory jj runs in, cached per directory. `repo add` now warns when neither has an identity. The tile-merge commit was rewritten with `jj metaedit --update-author`. | Test asserts the landed author equals git's email; confirmed it **fails** with the old lookup and passes with the new one. Run 3's trunk commit has the right author. |
| 3 | Cancelled tickets not listed | **Fixed.** Collapsible "Cancelled" column. | Screenshot. |

### Hard / missing
| # | Item | Status | Notes |
|---|---|---|---|
| 1 | Worker can't see what it built | **Done (minimal slice of M2/M3).** Workflow `preview:` (Acutis-owned dev server on a free 127.0.0.1 port). In-process `acutis` MCP tools `preview` and `browser` (path only; headless Chrome via CDP over Bun's WebSocket, no new deps; blocks every other origin and closes popups). `browser:` gates. Screenshots stored as artifacts and shown in review. "Open preview" for the reviewer. | Run 3: the worker screenshotted at 390px, saw the header overflow, fixed the CSS and re-checked. The browser gate passed and its screenshot shows in the dashboard. Real-Chrome tests prove a page can't reach a stand-in dashboard by fetch, image, popup or navigation. Compose, DBs and per-lease hostnames are still M2. |
| 2 | Permission prompts stall / not a boundary | **Partly done.** A PreToolUse hook sends Bash commands that name user-writable paths outside the workspace to the operator, even when allowlisted (probe: a hook `ask` overrides `allowedTools`). More read-only defaults (`git ls-files/show`, `pwd`, `which`…). `permission_timeout_s` auto-denies with an explanation. Notifications via notify-send and/or `ACUTIS_NOTIFY_URL`. Tab title shows the pending count, plus a "needs you" chip. The banner now says it's not a boundary. Prompts show the hook's reason. | Run 1's real commands are fixtures (#29 and #31 flagged; #18, #108 and `2>/dev/null` not). Run 3's first command (same shape as run 1's) didn't prompt. **Not done:** "allow for this repo" rules, and recording *why* a command was auto-allowed. Still a heuristic: `bun test` can do anything. notify-send isn't installed here, so desktop notifications are untested. |
| 3 | No headless operator surface | **Done.** `watch` (WebSocket; exits 2 on a permission, 0 on review), `show`, `runs`, `perms`, `allow`/`deny` by id prefix, `diff`, `msg`, `redirect`, `pause`, `resume`, `kill`, `approve`, `discard`, `note`, `preview`, `ticket cancel`, `ticket add --body-file`, `repo notes`. | Run 3 was driven entirely by the CLI. Bug found and fixed on the way: `watch` reported "lost connection" when it closed its own socket on a permission request. |
| 4 | Trunk never advances | **Done.** `land: trunk`: rebase onto the base bookmark, re-run all gates if trunk moved, advance without `--allow-backwards`. Conflicts or failing re-checks put the run back in review. Serialised per repo. Requires the base to be a bookmark (`repo add` notes it). | Tests: two tickets from the same base (the second re-checked after rebase), conflict case, non-bookmark base. Run 3 landed on `main`. In a colocated repo the main checkout ends up detached on the old trunk with a clean tree; the run log says how to catch up. |
| 5 | No type-check in zero-dep repos | **Done (mechanism).** `setup:` steps run in the fresh workspace before the agent, and a failing step fails the run. | Tests. tile-merge itself stays dependency-free by choice, so its worker still reports "no tsc". Adding `setup: [bun add -d typescript]` would change that. |
| 6 | No place for reviewer evidence | **Done.** Run notes with optional PNG (dashboard paste or `acutis note --image`). Gate and agent screenshots saved automatically. PNG-only, server-generated names, `image/png` + `nosniff`. | Server tests (including SVG rejected with 415 and path traversal returning 404). |
| 7 | Operator guidance not durable | **Done.** Per-repo operator notes in Acutis's DB, added to every worker's system prompt (dashboard editor, `acutis repo notes`). | Test. Set for tile-merge before run 3; the worker used Edit throughout and checked at 390px as the notes asked. |
| 8 | Dashboard polish | **Done.** Markdown (React elements only: no raw HTML, http(s) links only, no images). Collapsible ticket body. Wider repo select. Turn deltas. Permission reasons. Composer fills its row. | Screenshots of runs 3 and 2. |

### Review round: holes found and fixed before reporting
- **`land: trunk` could land a conflicted commit.** After a stopped landing the change already sat
  on trunk, so a second approve skipped the conflict check. `rebase()` now always checks `@` for
  conflicts. The run's base also moves with the rebase, so diffs, policy flags and policy loading
  stay relative to the new trunk, and the re-check runs under the *new* trunk's workflow. Test:
  approve twice after a conflict; `main` is untouched both times and the diff is still the run's own.
- **Preview double start.** Two concurrent `ensure()` calls could spawn two servers and leak one.
  Starts in flight are now shared. Test: two concurrent starts give one server, and stop kills its PID.
- **Browser lock: popups escaped.** A popup opened by a trusted click reached another origin before
  it could be closed (reproduced: the stand-in server got the hit). Fixed with browser-level
  `Fetch` interception plus auto-attach (`waitForDebuggerOnStart`) for popups, workers and
  iframes; `Page.bringToFront` before the screenshot (the popup had hidden the page and the
  screenshot hung). Tests: trusted-click popup and a Worker's fetch are both blocked; 12 of 12
  passed under 4× parallel load. WebSockets are not intercepted (test documents it). The server's
  Origin check refuses them.
- **Orphaned Chrome.** If a check was interrupted hard, Chrome (in its own session) survived; I found 32
  stray processes from my own timed-out runs. Live browsers are now tracked and killed on exit and on
  daemon shutdown. SIGKILL of the daemon can still orphan them.
- **`waitfor <selector>` step** added (agents and gates no longer need fixed sleeps).
- **Real-runner probe** (Haiku, real `ClaudeSdkRunner`, sandbox off): the `acutis` tool was
  approved in `canUseTool` by server source (`sdk`), with no SDK "shadowed" warning; an allowlisted
  `echo hi > /tmp/…` reached the operator with reason "names paths outside the workspace" and the
  file was not written.
- **End-to-end test** (live server + fake agent + real Chrome): `acutis watch` exits 2 with the
  allow hint, then 0 at review; the dashboard's permission card "Allow once", notes editor,
  "Add note", markdown rendering and "Open preview" all work.

### Still open
- **API reach (not fixed):** any local process can call the API with `x-acutis: 1` and no Origin;
  that's how the CLI works. With the sandbox off, code run by an allowlisted command (`bun test`,
  `bun run`) could approve its own run. The browser lock only closes the browser-tool path. A fix
  would be a per-daemon token the CLI reads from `$ACUTIS_HOME` (outside workspaces) and the
  dashboard gets from its page.
- Redirect, daemon-restart recovery with the new tools, parallel runs and `land: push` weren't run for real (they're covered by `FakeRunner` tests where those exist).
- Spend on killed turns is still invisible (no `result` is sent), and there's still no live cost mid-turn.
- `npx --no-install tsc` prompted in run 3. That's correct behaviour, but a read-only "version/check" tier for common tools would reduce prompts further.
- DESIGN.md is updated. Two principles changed wording: workers now get Acutis's own in-process MCP server (no external ones), and operator notes are a policy input that lives outside trunk (they can add guidance, not loosen gates or permissions).

## Sandbox on (2026-11-20, later)
The sandbox had been off because Ubuntu's `kernel.apparmor_restrict_unprivileged_userns=1` blocked
bubblewrap (`setting up uid map: Permission denied`). After an AppArmor profile was added for
`/usr/bin/bwrap` (`userns`, unconfined, same shape as the claude-desktop one), `probeSandbox()`
passed and the daemon reported `Sandbox: on`.

Run 4 on tile-merge was a probe ticket. The agent ran a fixed list of commands and reported the results ($0.26, 27s):
| Probe | Result |
|---|---|
| write inside the workspace | works |
| write `/tmp`, `$HOME`, `~/Workspace/Acutis` | `Read-only file system` (checked on the host: no files) |
| `curl https://example.com` | surfaced to the operator as a `SandboxNetworkAccess {"host":"example.com"}` permission. Denied, so curl timed out. |
| `curl 127.0.0.1:7777/api/state` (the Acutis API) | `Couldn't connect`: the network namespace hides host localhost, and no prompt appears |
| `bun test` | works (40 pass) |

- **API reach is closed for the agent's own commands while the sandbox is on.** That claim was too broad at first.
  Gates and the preview server were still spawned straight on the host with the daemon's full environment. A worker
  could write a test that calls the API or reads `ANTHROPIC_API_KEY`, and the gate would run it unconfined.
  **Fixed:** a `CommandSandbox` (bubblewrap) now confines gates (no network, workspace-only writes, private /tmp
  and PID namespace, Acutis data and credential directories hidden). The preview gets the same filesystem limits
  but keeps the host network. Both get credential-looking environment variables removed. Test:
  `tests/sandbox.test.ts`, where a worker-written `evil.ts` gate gets "api unreachable, write refused,
  key=none". The same test fails with the sandbox removed ("api reached, wrote outside").
  **Still open:** the preview server can reach localhost, so the token fix is still needed for that path and for
  sandbox-off machines.
- **Network goes through the permission flow, per host.** That gives a reasonable "allow this registry" story. A
  per-repo allowed-hosts list in the workflow would avoid repeated prompts.
- **The agent's preview/browser tools still work under the sandbox.** They run in the Acutis process, outside it.
