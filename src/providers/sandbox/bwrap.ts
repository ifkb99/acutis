import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { CommandSandbox } from "../../core/types";

/** Credential stores hidden from confined commands when they exist (they can read the rest of the disk). */
const SECRET_DIRS = [".ssh", ".gnupg", ".aws", ".config/gh", ".claude", ".docker", ".kube", ".netrc", ".npmrc", ".pypirc"];

/**
 * Gates and preview servers in bubblewrap: the whole filesystem read-only, the workspace
 * read-write, a private /tmp, a fresh PID namespace (killing bwrap takes everything inside it),
 * and Acutis's data dir plus common credential stores hidden behind empty tmpfs mounts. With
 * `network: "none"` the command also gets an empty network namespace, so it can't reach the
 * internet or the Acutis API on localhost.
 */
export class BwrapSandbox implements CommandSandbox {
  private hidden: string[];

  constructor(opts: { hide?: string[]; home?: string } = {}) {
    const home = opts.home ?? homedir();
    this.hidden = [...(opts.hide ?? []), ...SECRET_DIRS.map((d) => `${home}/${d}`)];
  }

  wrap(command: string, cwd: string, opts: { network: "none" | "host" }): string[] {
    const argv = ["setsid", "bwrap", "--die-with-parent", "--unshare-pid", "--new-session"];
    argv.push("--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp");
    for (const h of this.hidden) {
      if (!existsSync(h)) continue;
      // A file can't take a tmpfs; bind /dev/null over it instead.
      const isDir = statSync(h).isDirectory();
      argv.push(...(isDir ? ["--tmpfs", h] : ["--ro-bind", "/dev/null", h]));
    }
    // After the hides, so a workspace inside Acutis's data dir is mounted back on top.
    argv.push("--bind", cwd, cwd, "--chdir", cwd);
    if (opts.network === "none") argv.push("--unshare-net");
    argv.push("--", "sh", "-c", command);
    return argv;
  }
}
