import { SshClient, type ExecResult } from "./ssh.js";
import {
  shellQuote,
  assertIdentifier,
  assertImageRef,
  assertFilter,
  assertPath,
  assertExecAllowed,
  SafetyError,
  type ExecPolicy,
} from "./safety.js";

export class DockerError extends Error {
  constructor(
    message: string,
    public stderr: string,
    public code: number | null,
  ) {
    super(message);
    this.name = "DockerError";
  }
}

export type DockerConfig = {
  useSudo: boolean;
  commandTimeoutMs: number;
  maxOutputBytes: number;
  allowedContainers: Set<string> | null;
  deniedContainers: Set<string>;
  execPolicy: ExecPolicy;
  allowLifecycle: boolean;
};

const JSON_LINE = "{{json .}}";

/** Split a `--format "{{json .}}"` stream into parsed objects (lenient). */
function parseJsonLines(stdout: string): unknown[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { _raw: line };
      }
    });
}

function parseJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

/**
 * High-level, safe wrapper over the remote `docker` CLI. Every method builds
 * its command from validated, typed arguments — the caller never supplies a
 * shell string — and there is deliberately no method that deletes, prunes or
 * otherwise destroys state.
 */
export class DockerClient {
  constructor(
    private ssh: SshClient,
    public cfg: DockerConfig,
  ) {}

  // --- guards ----------------------------------------------------------------

  private assertContainer(name: string): string {
    assertIdentifier("container", name);
    if (this.cfg.deniedContainers.has(name)) {
      throw new SafetyError(`Container ${JSON.stringify(name)} is on the deny list.`);
    }
    if (this.cfg.allowedContainers && !this.cfg.allowedContainers.has(name)) {
      throw new SafetyError(
        `Container ${JSON.stringify(name)} is not on the allow list configured for this server.`,
      );
    }
    return name;
  }

  private assertLifecycle(): void {
    if (!this.cfg.allowLifecycle) {
      throw new SafetyError(
        "Lifecycle actions (start/stop/restart) are disabled on this server " +
          "(started without --allow-lifecycle).",
      );
    }
  }

  // --- execution -------------------------------------------------------------

  private compose(tokens: string[]): string {
    const prefix = this.cfg.useSudo ? ["sudo", "-n"] : [];
    return [...prefix, ...tokens].map(shellQuote).join(" ");
  }

  private run(tokens: string[]): Promise<ExecResult> {
    return this.ssh.exec(this.compose(tokens), {
      timeoutMs: this.cfg.commandTimeoutMs,
      maxOutputBytes: this.cfg.maxOutputBytes,
    });
  }

  private async runChecked(tokens: string[]): Promise<ExecResult> {
    const res = await this.run(tokens);
    if (res.signal === "TIMEOUT") {
      throw new DockerError("Command timed out.", res.stderr.trim(), null);
    }
    if (res.code !== 0) {
      const detail = res.stderr.trim() || res.stdout.trim() || "(no output)";
      throw new DockerError(
        `docker ${tokens[0] === "docker" ? tokens.slice(1, 3).join(" ") : tokens[0]} ` +
          `failed (exit ${res.code ?? "?"})`,
        detail,
        res.code,
      );
    }
    return res;
  }

  private note(res: ExecResult, text: string): string {
    return res.truncated
      ? `${text}\n\n[docker-safe-debug] output truncated at ${this.cfg.maxOutputBytes} bytes.`
      : text;
  }

  // --- connectivity ----------------------------------------------------------

  async ping(): Promise<unknown> {
    const res = await this.runChecked(["docker", "version", "--format", JSON_LINE]);
    return parseJson(res.stdout);
  }

  // --- containers ------------------------------------------------------------

  async ps(opts: { all?: boolean; filters?: string[]; limit?: number }): Promise<unknown[]> {
    const tokens = ["docker", "ps", "--no-trunc"];
    if (opts.all) tokens.push("--all");
    if (typeof opts.limit === "number") tokens.push("--last", String(opts.limit));
    for (const f of opts.filters ?? []) tokens.push("--filter", assertFilter(f));
    tokens.push("--format", JSON_LINE);
    const res = await this.runChecked(tokens);
    return parseJsonLines(res.stdout);
  }

  async inspect(ref: string, type?: string): Promise<unknown> {
    this.assertContainer(ref);
    const tokens = ["docker", "inspect"];
    if (type) tokens.push("--type", type);
    tokens.push(ref);
    const res = await this.runChecked(tokens);
    return parseJson(res.stdout);
  }

  async logs(
    container: string,
    opts: { tail: number; since?: string; until?: string; timestamps?: boolean },
  ): Promise<string> {
    this.assertContainer(container);
    const tokens = ["docker", "logs", "--tail", String(opts.tail)];
    if (opts.since) tokens.push("--since", opts.since);
    if (opts.until) tokens.push("--until", opts.until);
    if (opts.timestamps) tokens.push("--timestamps");
    tokens.push(container);
    // docker logs never exits non-zero for a running container; capture both streams.
    const res = await this.run(tokens);
    if (res.code !== 0 && !res.stdout && res.stderr) {
      throw new DockerError(`docker logs failed (exit ${res.code ?? "?"})`, res.stderr.trim(), res.code);
    }
    const merged = [res.stdout, res.stderr].filter((s) => s.length).join("\n");
    return this.note(res, merged || "(no log output)");
  }

  async stats(containers: string[]): Promise<unknown[]> {
    const tokens = ["docker", "stats", "--no-stream", "--format", JSON_LINE];
    for (const c of containers) tokens.push(this.assertContainer(c));
    const res = await this.runChecked(tokens);
    return parseJsonLines(res.stdout);
  }

  async top(container: string, psOptions?: string): Promise<string> {
    this.assertContainer(container);
    const tokens = ["docker", "top", container];
    if (psOptions) {
      if (!/^[a-zA-Z-]{1,16}$/.test(psOptions)) {
        throw new SafetyError(`Invalid ps options ${JSON.stringify(psOptions)} (letters/dash only).`);
      }
      tokens.push(psOptions);
    }
    const res = await this.runChecked(tokens);
    return this.note(res, res.stdout.trim() || "(no processes)");
  }

  async port(container: string): Promise<string> {
    this.assertContainer(container);
    const res = await this.runChecked(["docker", "port", container]);
    return res.stdout.trim() || "(no published ports)";
  }

  async diff(container: string): Promise<string> {
    this.assertContainer(container);
    const res = await this.runChecked(["docker", "diff", container]);
    return this.note(res, res.stdout.trim() || "(no filesystem changes)");
  }

  async exec(
    container: string,
    argv: string[],
    opts: { workdir?: string } = {},
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string; truncated: boolean }> {
    this.assertContainer(container);
    assertExecAllowed(this.cfg.execPolicy, argv);
    const tokens = ["docker", "exec"];
    if (opts.workdir) tokens.push("--workdir", assertPath(opts.workdir));
    tokens.push(container, ...argv);
    const res = await this.run(tokens);
    return {
      exitCode: res.signal === "TIMEOUT" ? null : res.code,
      stdout: res.stdout,
      stderr:
        res.stderr +
        (res.truncated ? `\n[docker-safe-debug] output truncated at ${this.cfg.maxOutputBytes} bytes.` : ""),
      truncated: res.truncated,
    };
  }

  // --- images ----------------------------------------------------------------

  async images(opts: { all?: boolean; filters?: string[] }): Promise<unknown[]> {
    const tokens = ["docker", "images"];
    if (opts.all) tokens.push("--all");
    for (const f of opts.filters ?? []) tokens.push("--filter", assertFilter(f));
    tokens.push("--format", JSON_LINE);
    const res = await this.runChecked(tokens);
    return parseJsonLines(res.stdout);
  }

  async imageInspect(ref: string): Promise<unknown> {
    assertImageRef(ref);
    const res = await this.runChecked(["docker", "image", "inspect", ref]);
    return parseJson(res.stdout);
  }

  async imageHistory(ref: string): Promise<unknown[]> {
    assertImageRef(ref);
    const res = await this.runChecked([
      "docker",
      "history",
      "--no-trunc",
      "--format",
      JSON_LINE,
      ref,
    ]);
    return parseJsonLines(res.stdout);
  }

  // --- networks --------------------------------------------------------------

  async networks(): Promise<unknown[]> {
    const res = await this.runChecked(["docker", "network", "ls", "--format", JSON_LINE]);
    return parseJsonLines(res.stdout);
  }

  async networkInspect(ref: string): Promise<unknown> {
    assertIdentifier("network", ref);
    const res = await this.runChecked(["docker", "network", "inspect", ref]);
    return parseJson(res.stdout);
  }

  // --- volumes ---------------------------------------------------------------

  async volumes(): Promise<unknown[]> {
    const res = await this.runChecked(["docker", "volume", "ls", "--format", JSON_LINE]);
    return parseJsonLines(res.stdout);
  }

  async volumeInspect(ref: string): Promise<unknown> {
    assertIdentifier("volume", ref);
    const res = await this.runChecked(["docker", "volume", "inspect", ref]);
    return parseJson(res.stdout);
  }

  // --- system ----------------------------------------------------------------

  async info(): Promise<unknown> {
    const res = await this.runChecked(["docker", "info", "--format", JSON_LINE]);
    return parseJson(res.stdout);
  }

  async version(): Promise<unknown> {
    const res = await this.runChecked(["docker", "version", "--format", JSON_LINE]);
    return parseJson(res.stdout);
  }

  async diskUsage(verbose?: boolean): Promise<string> {
    const tokens = ["docker", "system", "df"];
    if (verbose) tokens.push("--verbose");
    const res = await this.runChecked(tokens);
    return this.note(res, res.stdout.trim());
  }

  async events(opts: { since: string; until?: string }): Promise<unknown[]> {
    const tokens = [
      "docker",
      "events",
      "--since",
      opts.since,
      "--until",
      opts.until ?? "now",
      "--format",
      JSON_LINE,
    ];
    const res = await this.runChecked(tokens);
    return parseJsonLines(res.stdout);
  }

  // --- compose ---------------------------------------------------------------

  private composeGlobals(opts: {
    projectDirectory?: string;
    file?: string;
    projectName?: string;
  }): string[] {
    const tokens = ["docker", "compose"];
    if (opts.file) tokens.push("--file", assertPath(opts.file));
    if (opts.projectDirectory)
      tokens.push("--project-directory", assertPath(opts.projectDirectory));
    if (opts.projectName) tokens.push("--project-name", assertIdentifier("project", opts.projectName));
    return tokens;
  }

  async composePs(opts: {
    projectDirectory?: string;
    file?: string;
    projectName?: string;
    all?: boolean;
  }): Promise<unknown> {
    const tokens = this.composeGlobals(opts);
    tokens.push("ps");
    if (opts.all) tokens.push("--all");
    tokens.push("--format", "json");
    const res = await this.runChecked(tokens);
    // compose ps --format json emits either a JSON array or one object per line.
    const trimmed = res.stdout.trim();
    if (trimmed.startsWith("[")) return parseJson(trimmed);
    return parseJsonLines(trimmed);
  }

  async composeLogs(opts: {
    projectDirectory?: string;
    file?: string;
    projectName?: string;
    service?: string;
    tail: number;
    timestamps?: boolean;
  }): Promise<string> {
    const tokens = this.composeGlobals(opts);
    tokens.push("logs", "--no-color", "--no-log-prefix", "--tail", String(opts.tail));
    if (opts.timestamps) tokens.push("--timestamps");
    if (opts.service) tokens.push(assertIdentifier("service", opts.service));
    const res = await this.runChecked(tokens);
    return this.note(res, res.stdout.trim() || res.stderr.trim() || "(no log output)");
  }

  async composeConfig(opts: {
    projectDirectory?: string;
    file?: string;
    projectName?: string;
    servicesOnly?: boolean;
  }): Promise<string> {
    const tokens = this.composeGlobals(opts);
    tokens.push("config");
    if (opts.servicesOnly) tokens.push("--services");
    const res = await this.runChecked(tokens);
    return this.note(res, res.stdout.trim());
  }

  // --- lifecycle (gated) -----------------------------------------------------

  async restart(container: string, timeout?: number): Promise<string> {
    this.assertLifecycle();
    this.assertContainer(container);
    const tokens = ["docker", "restart"];
    if (typeof timeout === "number") tokens.push("--time", String(timeout));
    tokens.push(container);
    const res = await this.runChecked(tokens);
    return `Restarted: ${res.stdout.trim() || container}`;
  }

  async stop(container: string, timeout?: number): Promise<string> {
    this.assertLifecycle();
    this.assertContainer(container);
    const tokens = ["docker", "stop"];
    if (typeof timeout === "number") tokens.push("--time", String(timeout));
    tokens.push(container);
    const res = await this.runChecked(tokens);
    return `Stopped: ${res.stdout.trim() || container}`;
  }

  async start(container: string): Promise<string> {
    this.assertLifecycle();
    this.assertContainer(container);
    const res = await this.runChecked(["docker", "start", container]);
    return `Started: ${res.stdout.trim() || container}`;
  }
}
