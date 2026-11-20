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

## Per-repo policy: `.acutis/workflow.md`

Acutis reads this file from the repo's trunk (never from the agent's workspace):

```markdown
---
model: opus            # any Claude Code model alias or ID
effort: high
gates:                 # run in the workspace after the agent finishes; failures go back to the agent
  - bun run typecheck
  - bun test
permissions:
  allow: ["Bash(bun test:*)", "Bash(bun run:*)"]   # anything else asks you in the dashboard
max_attempts: 2
land: bookmark         # bookmark | push
---
Ticket #{{ticket.id}}: {{ticket.title}}

{{ticket.body}}
```

When you approve a run, Acutis describes the change and sets the bookmark
`acutis/<ticket>-<slug>`. With `land: push`, it also pushes that bookmark.
