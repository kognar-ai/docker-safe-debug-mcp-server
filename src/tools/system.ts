import { z } from "zod";
import { ok, err, type ToolCtx } from "./shared.js";

export function registerSystem({ server, client }: ToolCtx) {
  server.registerTool(
    "docker_version",
    {
      title: "Docker version",
      description: "Client and daemon version information.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await client.version());
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "docker_info",
    {
      title: "Docker system info",
      description: "Daemon-wide info: container/image counts, storage driver, resources, warnings.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await client.info());
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "docker_disk_usage",
    {
      title: "Docker disk usage",
      description: "Disk used by images, containers, volumes and build cache (docker system df).",
      inputSchema: {
        verbose: z.boolean().optional().describe("Per-object breakdown."),
      },
    },
    async ({ verbose }) => {
      try {
        return ok(await client.diskUsage(verbose));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "docker_events",
    {
      title: "Recent Docker events",
      description:
        "Fetch daemon events over a bounded window (e.g. container die/oom/health events). Always terminates.",
      inputSchema: {
        since: z
          .string()
          .max(64)
          .optional()
          .describe("Start of the window (e.g. '30m', '1h', or a timestamp). Default '1h'."),
        until: z.string().max(64).optional().describe("End of the window. Default 'now'."),
      },
    },
    async ({ since, until }) => {
      try {
        return ok(await client.events({ since: since ?? "1h", until }));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "debug_ping",
    {
      title: "Test connectivity",
      description:
        "Verify the SSH connection and that the remote Docker daemon responds. Good first call to confirm setup.",
      inputSchema: {},
    },
    async () => {
      try {
        const version = await client.ping();
        return ok({
          ssh: "ok",
          docker: "ok",
          allow_lifecycle: client.cfg.allowLifecycle,
          exec_enabled: client.cfg.execPolicy.enabled,
          version,
        });
      } catch (e) {
        return err(e);
      }
    },
  );
}
