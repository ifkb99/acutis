# Plan: container backend for gates and previews (draft, 2026-11-21)

Status: **proposal, for review.** Nothing here is built yet.

## Why
- **Unix sockets escape bubblewrap.** A network namespace doesn't cover path sockets, and a
  read-only mount doesn't stop `connect()`. `/run` is now hidden (D-Bus, docker.sock), but one
  machine still had reachable sockets in `~/.cache/ibus`, wezterm's GUI socket, a Codex app-server
  daemon, the Nix daemon and postfix. A full-disk scan took 47s, so hiding them one by one doesn't
  scale. Blocking `AF_UNIX` with seccomp would break tools that use sockets in the private `/tmp`,
  like tsx IPC in the duke-ml harness gate.
- **Containers fix this the right way round.** A container sees only what's mounted into it.
  Nothing on the host is reachable unless Acutis passes it in.
- **Cross-platform.** Today macOS runs with "Sandbox: OFF": `probeSandbox` needs bwrap, so gates and
  previews run unconfined. Docker Desktop, OrbStack and colima make the same backend work there.
- **Not in scope:** the agent's own Bash. The 2026-11-21 probe showed Claude Code's agent sandbox
  already blocks Unix sockets (`listen` gets EPERM) and denies the token, the API and every host
  socket tried. Moving the agent loop into a container stays the separate M5 spike.

## Design
### 1. A `ContainerSandbox` provider (`src/providers/sandbox/container.ts`)
It implements the existing `CommandSandbox` interface, so `runs.ts` and `preview.ts` barely
change. `wrap()` returns a `docker run` / `podman run` argv:

```
<engine> run --rm --init --name acutis-r<run>-<phase>-<n> --label acutis.run=<run>
  --network none --user <uid>:<gid> [--userns=keep-id (podman)]
  --cap-drop ALL --security-opt no-new-privileges
  --memory <m> --cpus <c> --pids-limit <p>
  -v <workspace>:<workspace>:rw -w <workspace>
  --env-file <filtered env>          # workerEnv(): credential-looking variables removed
  <image> sh -c <command>
```

- **Same path inside.** The workspace is mounted at its host path, so error messages, snapshot
  paths and the agent's view all agree.
- **Files stay yours.** `--user` (Docker) or `keep-id` (rootless Podman) means files the gate writes
  are owned by you, not root.
- **Resource limits come for free.** That covers open item #3, the cargo exit 137 with 4
  concurrent runs. The defaults would be workflow fields with global caps.
- **Kill and clean-up go by label.** `kill`, a timeout or `stop()` run `<engine> rm -f` by name. On
  daemon start, Acutis removes any container labelled `acutis.run`. That also fixes today's orphan
  case: on SIGKILL, bwrap dies with its parent but the host-side socat doesn't.

### 2. Engine choice
- **Detection.** `ACUTIS_SANDBOX=container|bwrap|off`, with automatic detection by default. Prefer
  rootless Podman, then Docker.
- **Rootful Docker** is acceptable for the daemon. You're already in the `docker` group, so Acutis
  holds no new privilege. Containers never get the socket, and they run as your UID with all
  capabilities dropped.
- **Startup report.** `acutis serve` says which engine and mode it's using, as it does today for
  the sandbox.

### 3. Images are trunk policy
- **New workflow field:** `container: { image: "rust:1.100" }`, or `container: { build: .acutis/Dockerfile }`.
- **The Dockerfile is read from the trunk commit,** like the workflow, never from the workspace.
  A build runs with network, so a worker-edited Dockerfile would be a network escape. Images are
  tagged by the hash of the trunk Dockerfile, and rebuilt when it changes.
- **No `container:` in the workflow:** fall back to bwrap on Linux, with a dashboard warning that
  bwrap leaves some host sockets reachable. On macOS, gates run unconfined, as today.

### 4. Setup steps and caches
- **Setup moves into the container** with network on, using the same image. It stays trunk policy,
  run before the worker touches anything. That way toolchains and lockfile installs match what the
  gates use.
- **Caches are named volumes per repo,** e.g. `cache: { cargo: /usr/local/cargo/registry, npm: /home/node/.npm }`.
- **Setup mounts caches read-write; gates mount them read-only.** Worker code can't poison a cache
  that later runs trust. Build outputs (`target/`, `node_modules/`) live in the workspace as now.

### 5. Previews
`--network none` can't publish ports, and Docker internal networks don't support `-p`. Options:
- **(a) Relay sidecar (recommended).** Each run gets an internal network (`--internal`, so no
  gateway and no route to the host). The preview container joins only that network. A tiny
  relay container (pinned `alpine/socat`) joins it plus the default bridge, and publishes
  `-p 127.0.0.1:P:P`, forwarding to `preview:P`. The relay only accepts inbound connections, so the
  preview has no way out. This approach is engine-native, works on Docker Desktop, and needs nothing
  in the repo's image.
- **(b) Reuse today's Unix-socket bridge.** Mount the socket directory into the container. This
  needs `socat` inside the repo's image, so it's rejected as a requirement on every image.

Either way, headless Chrome stays on the host and connects to `127.0.0.1:P`.

### 6. Narrowing the gap between agent and gate
The agent's Bash runs on the host toolchain while gates run in the image, so "passes for the agent,
fails in the gate" gets more likely. Two mitigations:
- **The worker prompt names the gate image.** For example: "gates run in `rust:1.100` with no
  network; your shell uses the host toolchain."
- **A new in-process MCP tool `gate_env`.** It runs one command in a fresh gate container (no
  network, caches read-only) and returns the output. That lets the agent reproduce a gate failure
  exactly. It's the same trust level as running a gate, which agents already trigger by finishing.

## Phases
| # | Scope | Done when |
|---|---|---|
| P1 | `ContainerSandbox` for gates, `container.image`, label clean-up, limits | Today's `tests/sandbox.test.ts` expectations run against both backends (parametrized): workspace writable, outside read-only, secrets hidden, API unreachable, **no host sockets, even ones in `$HOME`** (new test), kill takes everything. They also pass on the three trial repos. |
| P2 | Previews through the relay sidecar | The browser-gate, large-response and API-unreachable tests pass against containers. |
| P3 | Setup in the container, cache volumes (read-write in setup, read-only in gates), `container.build` from trunk | The stahl gate runs warm in about 1 minute, comparable to today's 55s with a read-only `~/.cargo`. A worker-edited Dockerfile has no effect. |
| P4 | macOS: Docker Desktop or OrbStack for gates and previews. Probe Claude Code's Seatbelt sandbox for the agent and report it | The tile-merge dogfood runs on a Mac with gates confined. |
| P5 | `gate_env` MCP tool and worker prompt text | A duke-ml run uses it to reproduce a gate failure. |

Tests that need an engine skip when none is available, as the bwrap tests skip without bwrap.

## What we give up
- **Per-repo image upkeep.** Today gates use whatever toolchain is installed on the host, and that
  stops working. Each repo needs a `container:` entry, for example a Rust version for stahl and a
  Node/SvelteKit image for hegel.
- **First-run cost.** Image pulls and builds, and cold caches until setup warms them.
- **macOS file I/O.** Bind mounts go through the VM's file sharing, which makes `cargo` and
  `node_modules` work noticeably slower there. On Linux the overhead is small.
- **A container engine becomes a soft dependency.** bwrap stays as the Linux fallback.

## Questions for you
1. **Default engine:** rootless Podman when present, else Docker? Or Docker first, since it's what you use?
2. **Repos without `container:`:** fall back to bwrap with a warning (proposed), or refuse to run gates?
3. **Default images:** should Acutis ship a few (bun, node, rust) that repos can name, or always use upstream images?
4. **Previews:** is the relay sidecar acceptable? It adds one small container per running preview.
