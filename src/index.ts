#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SshClient, type SshConfig } from "./ssh.js";
import { DockerClient, type DockerConfig } from "./docker.js";
import { buildExecPolicy } from "./safety.js";
import { registerContainers } from "./tools/containers.js";
import { registerImages } from "./tools/images.js";
import { registerNetworks } from "./tools/networks.js";
import { registerVolumes } from "./tools/volumes.js";
import { registerSystem } from "./tools/system.js";
import { registerCompose } from "./tools/compose.js";
import { registerLifecycle } from "./tools/lifecycle.js";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    let key: string;
    let val: string | undefined;
    if (eq !== -1) {
      key = a.slice(2, eq);
      val = a.slice(eq + 1);
    } else {
      key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        val = next;
        i++;
      } else {
        val = "true";
      }
    }
    out[key.replace(/-/g, "_")] = val;
  }
  return out;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const HELP = `docker-safe-debug-mcp-server

Safe, read-only-by-default MCP server for debugging remote Docker containers over SSH.

Usage:
  npx @kognar/docker-safe-debug-mcp-server --host <host> --user <user> [--private-key <path>]

SSH connection (CLI flag / env var):
  --host             SSH_HOST                 host running Docker            (required)
  --port             SSH_PORT                 SSH port                       (default 22)
  --user             SSH_USER                 SSH username                   (required)
  --private-key      SSH_PRIVATE_KEY          path to a private key file
  --private-key-data SSH_PRIVATE_KEY_DATA     inline private key (\\n escaped)
  --passphrase       SSH_PASSPHRASE           passphrase for the private key
  --password         SSH_PASSWORD             password auth (key is preferred)
  (with no key/password, the local SSH agent at $SSH_AUTH_SOCK is used)

Safety / behaviour:
  --allow-lifecycle  ALLOW_LIFECYCLE          enable start/stop/restart tools (default off)
  --no-exec / ALLOW_EXEC=false                disable the guarded docker_exec tool
  --exec-allowlist   EXEC_ALLOWLIST           extra binaries for docker_exec (comma list)
  --containers       ALLOWED_CONTAINERS       only these containers may be touched (comma list)
  --deny-containers  DENIED_CONTAINERS        never touch these containers (comma list)
  --use-sudo         USE_SUDO                 prefix docker commands with 'sudo -n'
  --command-timeout  COMMAND_TIMEOUT_MS       per-command timeout ms          (default 30000)
  --max-output       MAX_OUTPUT_BYTES         truncate output to N bytes       (default 1000000)
  --help, -h                                  show this help

This server can never delete, prune or remove containers, images or volumes —
those operations are intentionally not implemented.
`;

type Resolved = {
  ssh: SshConfig;
  docker: Omit<DockerConfig, "execPolicy"> & { allowExec: boolean; execAllowlist: string[] };
};

function resolveConfig(): Resolved {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h) {
    console.error(HELP);
    process.exit(0);
  }

  const host = args.host ?? process.env.SSH_HOST;
  const user = args.user ?? args.username ?? process.env.SSH_USER;

  const missing = [
    !host && "--host / SSH_HOST",
    !user && "--user / SSH_USER",
  ].filter(Boolean);
  if (missing.length) {
    console.error(
      `[docker-safe-debug] Missing required config: ${missing.join(", ")}\nRun with --help for usage.`,
    );
    process.exit(1);
  }

  const port = Number(args.port ?? process.env.SSH_PORT ?? "22");
  const commandTimeoutMs = Number(
    args.command_timeout ?? process.env.COMMAND_TIMEOUT_MS ?? "30000",
  );
  const maxOutputBytes = Number(args.max_output ?? process.env.MAX_OUTPUT_BYTES ?? "1000000");

  const allowedList = parseList(args.containers ?? process.env.ALLOWED_CONTAINERS);
  const deniedList = parseList(args.deny_containers ?? process.env.DENIED_CONTAINERS);

  // --no-exec always wins; then an explicit --allow-exec; then env; default on.
  const allowExec = args.no_exec
    ? false
    : args.allow_exec !== undefined
      ? parseBool(args.allow_exec, true)
      : parseBool(process.env.ALLOW_EXEC, true);

  return {
    ssh: {
      host: host!,
      port: Number.isFinite(port) ? port : 22,
      username: user!,
      privateKeyPath: args.private_key ?? args.key ?? process.env.SSH_PRIVATE_KEY,
      privateKeyData: args.private_key_data ?? process.env.SSH_PRIVATE_KEY_DATA,
      passphrase: args.passphrase ?? process.env.SSH_PASSPHRASE,
      password: args.password ?? process.env.SSH_PASSWORD,
    },
    docker: {
      useSudo: args.use_sudo ? parseBool(args.use_sudo, true) : parseBool(process.env.USE_SUDO, false),
      commandTimeoutMs: Number.isFinite(commandTimeoutMs) ? commandTimeoutMs : 30000,
      maxOutputBytes: Number.isFinite(maxOutputBytes) ? maxOutputBytes : 1000000,
      allowedContainers: allowedList.length ? new Set(allowedList) : null,
      deniedContainers: new Set(deniedList),
      allowLifecycle: args.allow_lifecycle
        ? parseBool(args.allow_lifecycle, true)
        : parseBool(process.env.ALLOW_LIFECYCLE, false),
      allowExec,
      execAllowlist: parseList(args.exec_allowlist ?? process.env.EXEC_ALLOWLIST),
    },
  };
}

async function main() {
  const cfg = resolveConfig();

  const execPolicy = buildExecPolicy({
    enabled: cfg.docker.allowExec,
    extraAllow: cfg.docker.execAllowlist,
  });

  const ssh = new SshClient(cfg.ssh);
  const dockerConfig: DockerConfig = {
    useSudo: cfg.docker.useSudo,
    commandTimeoutMs: cfg.docker.commandTimeoutMs,
    maxOutputBytes: cfg.docker.maxOutputBytes,
    allowedContainers: cfg.docker.allowedContainers,
    deniedContainers: cfg.docker.deniedContainers,
    allowLifecycle: cfg.docker.allowLifecycle,
    execPolicy,
  };
  const client = new DockerClient(ssh, dockerConfig);

  const server = new McpServer({
    name: "docker-safe-debug-mcp-server",
    version: "0.1.0",
  });

  const ctx = { server, client };
  registerContainers(ctx);
  registerImages(ctx);
  registerNetworks(ctx);
  registerVolumes(ctx);
  registerSystem(ctx);
  registerCompose(ctx);
  if (dockerConfig.allowLifecycle) registerLifecycle(ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const mode = [
    "read-only",
    dockerConfig.allowLifecycle && "lifecycle",
    execPolicy.enabled ? "exec:on" : "exec:off",
    dockerConfig.useSudo && "sudo",
  ]
    .filter(Boolean)
    .join(", ");
  console.error(
    `[docker-safe-debug] ready on stdio → ${cfg.ssh.username}@${cfg.ssh.host}:${cfg.ssh.port} (${mode})`,
  );

  const shutdown = () => {
    ssh.dispose();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("[docker-safe-debug] fatal:", e);
  process.exit(1);
});
