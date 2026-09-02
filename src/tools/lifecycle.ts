import { z } from "zod";
import { ok, err, containerName, type ToolCtx } from "./shared.js";

/**
 * Lifecycle tools are only registered when the server is started with
 * --allow-lifecycle. They can restart/stop/start a container but — by design —
 * there is still no tool anywhere in this server that removes or prunes
 * anything, so the worst case is a stopped container, never data loss.
 */
export function registerLifecycle({ server, client }: ToolCtx) {
  server.registerTool(
    "docker_restart",
    {
      title: "Restart container",
      description:
        "Restart a container. Requires the server to be started with lifecycle actions enabled.",
      inputSchema: {
        container: containerName,
        timeout: z
          .number()
          .int()
          .min(0)
          .max(300)
          .optional()
          .describe("Seconds to wait for graceful stop before killing (default: docker default)."),
      },
    },
    async ({ container, timeout }) => {
      try {
        return ok(await client.restart(container, timeout));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "docker_stop",
    {
      title: "Stop container",
      description:
        "Gracefully stop a running container. Requires lifecycle actions to be enabled. " +
        "The container is not removed and can be started again.",
      inputSchema: {
        container: containerName,
        timeout: z.number().int().min(0).max(300).optional().describe("Grace period in seconds."),
      },
    },
    async ({ container, timeout }) => {
      try {
        return ok(await client.stop(container, timeout));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "docker_start",
    {
      title: "Start container",
      description: "Start a stopped container. Requires lifecycle actions to be enabled.",
      inputSchema: { container: containerName },
    },
    async ({ container }) => {
      try {
        return ok(await client.start(container));
      } catch (e) {
        return err(e);
      }
    },
  );
}
