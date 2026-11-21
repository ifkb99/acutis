# Acutis

A local software factory. Acutis takes tickets, gives each one an isolated
[jj](https://jj-vcs.github.io/jj/) workspace and a Claude agent, runs the repo's
checks, and puts the diff in front of you to approve. A dashboard shows each
agent live. From it you can message, redirect, pause or kill an agent, and
answer its permission requests.

See [DESIGN.md](DESIGN.md) for the architecture and roadmap.

## Requirements

Bun, jj, and a logged-in Claude Code (`claude auth status`). Optional:
`bubblewrap` and `socat` turn on the shell sandbox.

## Quick start

```sh
bun install
bun src/cli.ts repo add ~/Workspace/some-web-app --init-jj   # --init-jj only for plain git repos
bun src/cli.ts serve                                          # http://127.0.0.1:7777
```

Then add a ticket in the dashboard (or `bun src/cli.ts ticket add <repo> "Title" --body "..."`)
and press **Start**.

Everything the dashboard does is also on the CLI (`bun src/cli.ts` lists it), e.g.:

```sh
bun src/cli.ts start 3 --watch     # stream the run; exits when it needs you (permission, review)
bun src/cli.ts allow 3 a1b2c3d4     # answer a permission request by id prefix
bun src/cli.ts diff 3 && bun src/cli.ts approve 3
bun src/cli.ts repo notes my-app --set "Prefer the Edit tool over scripts."
```

## Per-repo policy: `.acutis/workflow.md`

Acutis reads this file from the repo's trunk (never from the agent's workspace):

```markdown
---
model: opus            # any Claude Code model alias or ID
effort: high
setup:                 # optional: run in the fresh workspace before the agent starts
  - bun install
preview: bun --port=$PORT ./index.html   # optional: Acutis runs it; the agent gets preview/browser tools
gates:                 # run in the workspace after the agent finishes; failures go back to the agent
  - bun run typecheck
  - bun test
  - browser: { path: /, script: "document.title !== ''" }   # needs preview; screenshot shown in review
permissions:
  allow: ["Bash(bun test:*)", "Bash(bun run:*)"]   # anything else asks you in the dashboard
permission_timeout_s: 900   # optional: auto-deny unanswered prompts
max_attempts: 2
land: bookmark         # bookmark | push | trunk (rebase, re-check, advance the base bookmark)
---
Ticket #{{ticket.id}}: {{ticket.title}}

{{ticket.body}}
```

When you approve a run, Acutis describes the change and sets the bookmark
`acutis/<ticket>-<slug>`. With `land: push`, it also pushes that bookmark. With `land: trunk`, it
rebases onto the current base bookmark (e.g. `main`), re-runs the checks if that moved anything,
and advances the base bookmark, so the next ticket builds on this one.

Headless Chrome (or Chromium) is used for previews and browser checks; set `ACUTIS_CHROME` if it
isn't on `PATH`.
