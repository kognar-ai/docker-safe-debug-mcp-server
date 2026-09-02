import { z } from "zod";
import { ok, err, containerName, filters, type ToolCtx } from "./shared.js";

export function registerContainers({ server, client }: ToolCtx) {
  server.registerTool(
    "docker_ps",
    {
      title: "List containers",
      description:
        "List containers on the host (running by default). Start here to discover container names before using other tools.",
      inputSchema: {
        all: z.boolean().optional().describe("Include stopped containers (docker ps -a)."),
        limit: z.number().int().positive().max(500).optional().describe("Show only the last N containers."),
        filters,
      },
    },
    async ({ all, limit, filters }) => {
      try {
        return ok(await client.ps({ all, limit, filters }));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "docker_inspect",
    {
      title: "Inspect container",
      description:
        "Low-level details of a container (config, mounts, network, state, env). Use for deep debugging of a single container.",
      inputSchema: {
        container: containerName,
        type: z
          .enum(["container", "image", "network", "volume"])
          .optional()
          .describe("Disambiguate the object type if a name is shared."),
      },
    },
    async ({ container, type }) => {
      try {
        return ok(await client.inspect(container, type));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "docker_logs",
    {
      title: "Container logs",
      description:
        "Fetch recent logs of a container. Never follows/streams; bounded by tail and the server output cap.",
      inputSchema: {
        container: containerName,
        tail: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .optional()
          .describe("Number of lines from the end (default 200)."),
        since: z
          .string()
          .max(64)
          .optional()
          .describe("Only logs since this time (e.g. '10m', '1h', or an RFC3339 timestamp)."),
        until: z.string().max(64).optional().describe("Only logs before this time."),
        timestamps: z.boolean().optional().describe("Prefix each line with a timestamp."),
      },
    },
    async ({ container, tail, since, until, timestamps }) => {
      try {
        return ok(
          await client.logs(container, { tail: tail ?? 200, since, until, timestamps }),
        );
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "docker_stats",
    {
      title: "Container resource stats",
      description:
        "One-shot CPU / memory / network / block-io usage snapshot for one or more containers (no live stream).",
      inputSchema: {
        containers: z
          .array(z.string())
          .optional()
          .describe("Containers to inspect. Omit for all running containers."),
      },
    },
    async ({ containers }) => {
      try {
        return ok(await client.stats(containers ?? []));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "docker_top",
    {
      title: "Container processes",
      description: "List the processes running inside a container (docker top).",
      inputSchema: {
        container: containerName,
        ps_options: z
          .string()
          .optional()
          .describe("Optional ps options, letters/dash only (e.g. 'aux')."),
      },
    },
    async ({ container, ps_options }) => {
      try {
        return ok(await client.top(container, ps_options));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "docker_port",
    {
      title: "Container port mappings",
      description: "Show the published port mappings of a container.",
      inputSchema: { container: containerName },
    },
    async ({ container }) => {
      try {
        return ok(await client.port(container));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "docker_diff",
    {
      title: "Container filesystem changes",
      description:
        "List files added/changed/deleted in a container's writable layer versus its image (docker diff).",
      inputSchema: { container: containerName },
    },
    async ({ container }) => {
      try {
        return ok(await client.diff(container));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "docker_exec",
    {
      title: "Run a read-only command in a container",
      description:
        "Run a single inspection command inside a running container. The command is an argv array " +
        "(program + arguments), NOT a shell string — pipes, redirects and chaining are not possible. " +
        "Only read-only binaries are permitted (cat, ls, tail, grep, ps, printenv, netstat, df, ...); " +
        "shells, interpreters and anything that writes/deletes are blocked. " +
        "Example: {\"container\":\"api\",\"command\":[\"tail\",\"-n\",\"50\",\"/var/log/app.log\"]}.",
      inputSchema: {
        container: containerName,
        command: z
          .array(z.string())
          .min(1)
          .describe("argv: program first, then each argument as a separate array element."),
        workdir: z.string().optional().describe("Optional working directory inside the container."),
      },
    },
    async ({ container, command, workdir }) => {
      try {
        return ok(await client.exec(container, command, { workdir }));
      } catch (e) {
        return err(e);
      }
    },
  );
}
