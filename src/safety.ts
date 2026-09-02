/**
 * Safety layer.
 *
 * This is the whole point of the server: give an LLM enough access to debug
 * production containers while making a catastrophic action structurally
 * impossible rather than merely discouraged.
 *
 * The guarantees enforced here are:
 *   1. Every docker command is built by us from typed parameters. The model
 *      never supplies a raw shell string, so there is nothing to inject.
 *   2. Every argument that does reach the remote shell is single-quoted by
 *      {@link shellQuote}, so metacharacters are inert data, never operators.
 *   3. `docker exec` runs an argv, never a shell. Its first token (the binary)
 *      must pass an allowlist, and a hard-deny set of shells / interpreters /
 *      writers can never be allowed, even by the operator.
 *   4. Destructive docker verbs (rm, prune, kill, down, volume rm, ...) have no
 *      tool at all. The server literally cannot delete anything.
 *   5. Optional allow/deny lists scope which containers can be touched.
 */

export class SafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafetyError";
  }
}

/**
 * Docker names: `[a-zA-Z0-9][a-zA-Z0-9_.-]*`. We also accept raw ids (hex) and
 * compose-style names. The regex intentionally forbids slashes, spaces and any
 * shell metacharacter so an id can never carry a payload.
 */
const IDENTIFIER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

/**
 * Image references, which unlike container names may contain a registry host,
 * path, tag and digest: `registry.example.com/team/app:1.2@sha256:abc...`.
 * Still no whitespace or shell metacharacter is permitted.
 */
const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,255}$/;

/** Docker filter tokens like `status=running` or `label=app=api`. */
const FILTER_RE = /^[a-zA-Z][a-zA-Z0-9_.-]*=[^\s'"`$;&|<>\\]{0,256}$/;

/** Absolute-ish path used as a working directory / compose project dir. */
const PATH_RE = /^[a-zA-Z0-9_./@:+-]{1,512}$/;

/**
 * POSIX-safe single quoting. A token made only of these characters is already
 * safe and passes through untouched (keeps commands readable in logs);
 * everything else is wrapped in single quotes with embedded quotes escaped as
 * `'\''`. The result can be concatenated into a remote command string with no
 * risk of word-splitting, globbing or metacharacter interpretation.
 */
export function shellQuote(token: string): string {
  if (token.length === 0) return "''";
  if (/[\0\r\n]/.test(token)) {
    throw new SafetyError("Argument contains a control character (NUL/CR/LF).");
  }
  if (/^[a-zA-Z0-9_./:=@%+-]+$/.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/** Validate a container / image / network / volume reference. Throws on abuse. */
export function assertIdentifier(kind: string, value: string): string {
  if (!IDENTIFIER_RE.test(value)) {
    throw new SafetyError(
      `Invalid ${kind} reference ${JSON.stringify(value)}: must match ${IDENTIFIER_RE}.`,
    );
  }
  return value;
}

export function assertImageRef(value: string): string {
  if (!IMAGE_RE.test(value)) {
    throw new SafetyError(
      `Invalid image reference ${JSON.stringify(value)}: must match ${IMAGE_RE}.`,
    );
  }
  return value;
}

export function assertFilter(value: string): string {
  if (!FILTER_RE.test(value)) {
    throw new SafetyError(
      `Invalid filter ${JSON.stringify(value)}: expected key=value (e.g. status=running).`,
    );
  }
  return value;
}

export function assertPath(value: string): string {
  if (!PATH_RE.test(value)) {
    throw new SafetyError(
      `Invalid path ${JSON.stringify(value)}: contains characters that are not allowed.`,
    );
  }
  return value;
}

/**
 * Binaries that can never run inside `docker exec`, even if the operator adds
 * them to the allowlist. These enable arbitrary writes, spawn a shell, run an
 * interpreter that can do anything, or exfiltrate/modify state. Matching is by
 * basename so `/bin/sh` and `sh` are both blocked.
 */
export const EXEC_HARD_DENY = new Set<string>([
  // shells & interpreters (would defeat the argv-only model)
  "sh", "bash", "zsh", "ksh", "dash", "ash", "csh", "tcsh", "fish", "busybox",
  "env", // `env FOO=bar sh` style escapes; reading env is done via printenv
  "perl", "python", "python2", "python3", "ruby", "node", "nodejs", "php",
  "lua", "luajit", "awk", "gawk", "mawk", "sed", "ed", "expect", "tclsh",
  // editors (write files, shell out)
  "vi", "vim", "nvim", "nano", "emacs", "pico", "ex",
  // file writers / destroyers
  "rm", "rmdir", "unlink", "shred", "mv", "cp", "install", "ln", "dd",
  "truncate", "tee", "mkfs", "mke2fs", "mkdir", "touch", "chmod", "chown",
  "chgrp", "chattr", "setfacl", "patch", "tar", "unzip", "gzip", "gunzip",
  // process / system control
  "kill", "killall", "pkill", "reboot", "shutdown", "halt", "poweroff",
  "init", "telinit", "systemctl", "service", "mount", "umount", "swapoff",
  "sysctl", "modprobe", "insmod", "rmmod",
  // package managers
  "apt", "apt-get", "aptitude", "dpkg", "yum", "dnf", "rpm", "apk", "pip",
  "pip3", "npm", "npx", "yarn", "pnpm", "gem", "cargo", "go",
  // network exfil / lateral movement / privilege
  "wget", "nc", "ncat", "netcat", "socat", "telnet", "ssh", "scp", "sftp",
  "rsync", "ftp", "tftp", "git", "svn", "docker", "podman", "kubectl", "crictl",
  "crontab", "at", "batch", "useradd", "usermod", "userdel", "passwd", "su",
  "sudo", "doas", "setcap", "iptables", "nft", "ip6tables", "visudo", "chpasswd",
]);

/**
 * Binaries allowed inside `docker exec` by default. All are read-only
 * inspection tools. The operator can extend this via EXEC_ALLOWLIST, but the
 * hard-deny set above always wins.
 */
export const EXEC_DEFAULT_ALLOW = new Set<string>([
  "cat", "ls", "stat", "head", "tail", "wc", "nl", "cut", "sort", "uniq",
  "tr", "comm", "join", "column", "fold", "rev", "tac", "zcat",
  "grep", "egrep", "fgrep", "zgrep", "printenv", "echo", "printf",
  "ps", "top", "pgrep", "pidof", "free", "uptime", "vmstat", "iostat",
  "mpstat", "pidstat", "df", "du", "lsof", "fuser",
  "hostname", "uname", "date", "id", "whoami", "groups", "getent", "locale",
  "ss", "netstat", "ip", "ifconfig", "route", "arp", "nslookup", "dig",
  "host", "getconf", "ulimit", "nproc",
  "readlink", "realpath", "dirname", "basename", "pwd", "find", "which",
  "type", "file", "strings", "xxd", "od", "hexdump", "cmp",
  "md5sum", "sha1sum", "sha256sum", "cksum", "base64", "jq", "yq",
  "lsblk", "blkid", "mountpoint", "true", "false", "sleep", "seq", "yes",
]);

export type ExecPolicy = {
  enabled: boolean;
  allow: Set<string>;
};

export function buildExecPolicy(opts: {
  enabled: boolean;
  extraAllow?: string[];
}): ExecPolicy {
  const allow = new Set(EXEC_DEFAULT_ALLOW);
  for (const raw of opts.extraAllow ?? []) {
    const bin = raw.trim();
    if (!bin) continue;
    if (EXEC_HARD_DENY.has(basename(bin))) {
      throw new SafetyError(
        `Refusing to allow ${JSON.stringify(bin)} in docker exec: it is on the permanent hard-deny list.`,
      );
    }
    allow.add(bin);
  }
  return { enabled: opts.enabled, allow };
}

function basename(bin: string): string {
  const parts = bin.split("/");
  return parts[parts.length - 1] || bin;
}

/**
 * Validate an argv for `docker exec`. Returns the argv unchanged on success.
 * The binary is matched by basename against allow/deny; arguments are only
 * checked for control characters (real injection defence is {@link shellQuote}
 * plus the argv-not-shell execution model, so we do NOT reject metacharacters
 * inside arguments — a grep regex like `a|b` must keep working).
 */
export function assertExecAllowed(policy: ExecPolicy, argv: string[]): string[] {
  if (!policy.enabled) {
    throw new SafetyError(
      "docker exec is disabled on this server (started without exec permission).",
    );
  }
  if (argv.length === 0) {
    throw new SafetyError("Empty command: provide the program to run and its arguments.");
  }
  const bin = argv[0];
  const base = basename(bin);
  if (EXEC_HARD_DENY.has(base)) {
    throw new SafetyError(
      `Command ${JSON.stringify(bin)} is permanently blocked: shells, interpreters, ` +
        `writers and privilege tools are never allowed inside docker exec.`,
    );
  }
  if (!policy.allow.has(bin) && !policy.allow.has(base)) {
    throw new SafetyError(
      `Command ${JSON.stringify(bin)} is not in the read-only exec allowlist. ` +
        `Allowed by default: inspection tools like cat, ls, tail, grep, ps, env (printenv), ` +
        `netstat, df. Ask the operator to extend EXEC_ALLOWLIST if you need more.`,
    );
  }
  for (let i = 0; i < argv.length; i++) {
    if (/[\0]/.test(argv[i])) {
      throw new SafetyError(`Argument ${i} contains a NUL byte.`);
    }
  }
  return argv;
}
