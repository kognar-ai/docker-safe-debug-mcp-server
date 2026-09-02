import { z } from "zod";
import { ok, err, type ToolCtx } from "./shared.js";

export function registerVolumes({ server, client }: ToolCtx) {
  server.registerTool(
    "docker_volumes",
    {
      title: "List volumes",
      description: "List Docker volumes on the host.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await client.volumes());
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "docker_volume_inspect",
    {
      title: "Inspect volume",
      description: "Details of a volume (driver, mountpoint, labels, options).",
      inputSchema: {
        volume: z.string().min(1).describe("Volume name."),
      },
    },
    async ({ volume }) => {
      try {
        return ok(await client.volumeInspect(volume));
      } catch (e) {
        return err(e);
      }
    },
  );
}
