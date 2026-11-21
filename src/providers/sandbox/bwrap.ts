import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { CommandSandbox } from "../../core/types";

/** Credential stores hidden from confined commands when they exist (they can read the rest of the disk). */
const SECRET_DIRS = [".ssh", ".gnupg", ".aws", ".config/gh", ".claude", ".docker", ".kube", ".netrc", ".npmrc", ".pypirc"];

/**
 * Gates and preview servers in bubblewrap: the whole filesystem read-only, the workspace
 * read-write, a private /tmp, a fresh PID namespace (killing bwrap takes everything inside it),
 * Acutis's data dir plus common credential stores hidden behind empty tmpfs mounts, and an empty
 * network namespace, so the command can't reach the internet or the Acutis API on localhost.
 *
 * An exposed port (the preview) is bridged out through a Unix socket: socat inside the sandbox
 * listens on the socket and connects to 127.0.0.1:port in the sandbox's own loopback. The socket
 * is a file, so the host can connect to it across the network namespace.
 */
export class BwrapSandbox implements CommandSandbox {
  private hidden: string[];

  constructor(opts: { hide?: string[]; home?: string } = {}) {
    const home = opts.home ?? homedir();
    this.hidden = [...(opts.hide ?? []), ...SECRET_DIRS.map((d) => `${home}/${d}`)];
  }

  wrap(command: string, cwd: string, opts: { expose?: { port: number; socket: string } } = {}): string[] {
    const argv = ["setsid", "bwrap", "--die-with-parent", "--unshare-pid", "--new-session", "--unshare-net"];
    argv.push("--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp");
    for (const h of this.hidden) {
      if (!existsSync(h)) continue;
      // A file can't take a tmpfs; bind /dev/null over it instead.
      const isDir = statSync(h).isDirectory();
      argv.push(...(isDir ? ["--tmpfs", h] : ["--ro-bind", "/dev/null", h]));
    }
    // After the hides, so a workspace inside Acutis's data dir is mounted back on top.
    argv.push("--bind", cwd, cwd, "--chdir", cwd);
    const ex = opts.expose;
    if (!ex) {
      argv.push("--", "sh", "-c", command);
      return argv;
    }
    // Only the socket's directory is writable; it is the caller's, outside the workspace, so a
    // jj snapshot never sees the socket. `exec` keeps bwrap's exit tied to the server's.
    const dir = dirname(ex.socket);
    argv.push("--bind", dir, dir);
    const bridge = `socat UNIX-LISTEN:${quote(ex.socket)},fork,unlink-early TCP:127.0.0.1:${ex.port} &`;
    argv.push("--", "sh", "-c", `${bridge} exec sh -c "$1"`, "sh", command);
    return argv;
  }
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
