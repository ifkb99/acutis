# Acutis

A local software factory. Acutis takes tickets, gives each one an isolated
[jj](https://jj-vcs.github.io/jj/) workspace and a Claude agent, runs the repo's
checks, and puts the diff in front of you to approve. A dashboard shows each
agent live. From it you can message, redirect, pause or kill an agent, and
answer its permission requests.

See [DESIGN.md](DESIGN.md) for the architecture and roadmap.

## Requirements

Bun, jj, and a logged-in Claude Code (`claude auth status`). Strongly recommended:
`bubblewrap` and `socat` for the sandbox (below). Optional: Chrome or Chromium for
previews and browser checks.

## Sandbox

With the sandbox on, the agent's shell commands, the repo's gates and the preview
server can write only inside the run's workspace. The agent's internet requests
become per-host permission requests. Gates and the preview server get their own empty
network, so worker-written tests and dev servers can't reach the internet, the Acutis API
or anything else listening on TCP on your localhost. Acutis relays the preview's port to the host, so your browser
and the checks still reach it. A preview that needs the internet, such as one that loads fonts from a CDN, won't
get it. Without the sandbox, Acutis still runs,
but its permission checks are guard rails, not a boundary. `acutis serve` prints
which mode you're in.

On Linux:

1. Install the tools:

   ```sh
   sudo apt install bubblewrap socat        # Fedora: sudo dnf install bubblewrap socat
   ```

2. **Ubuntu 23.10+ only:** AppArmor blocks unprivileged user namespaces by default
   (`sysctl kernel.apparmor_restrict_unprivileged_userns` prints `1`). Let bubblewrap
   use them with a profile, then load it:

   ```sh
   sudo tee /etc/apparmor.d/bwrap >/dev/null <<'EOF'
   abi <abi/4.0>,
   include <tunables/global>

   profile bwrap /usr/bin/bwrap flags=(unconfined) {
     userns,

     include if exists <local/bwrap>
   }
   EOF
   sudo apparmor_parser -r /etc/apparmor.d/bwrap
   ```

   Run this in a real terminal, because `sudo` needs to prompt for your password.
   The profile survives reboots. It lets any program use namespaces *through bwrap*,
   which is the trade-off Ubuntu's default avoids. Turning the restriction off
   system-wide with `sysctl` is broader, so don't.

3. Check it works, then (re)start the daemon:

   ```sh
   bwrap --ro-bind / / --dev /dev --unshare-net true && echo ok
   bun src/cli.ts serve          # should print "Sandbox: on (bubblewrap + socat)"
   ```

If `serve` prints `Sandbox: OFF (...)`, the reason says which step is missing.
Under the sandbox, things that need the network or write outside the repo
(`bun install`, `npm ci`, `cargo fetch`) belong in the workflow's `setup:` steps,
which run on the host before the agent starts.

## Quick start

```sh
bun install
bun src/cli.ts repo add ~/Workspace/some-web-app --init-jj   # --init-jj only for plain git repos
bun src/cli.ts serve                                          # prints the dashboard link
```

Open the link `serve` prints. It carries the API token (`#token=…`, kept in `$ACUTIS_HOME/token`),
which every API call needs. `bun src/cli.ts dashboard` prints it again. Then add a ticket in the dashboard (or `bun src/cli.ts ticket add <repo> "Title" --body "..."`)
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
