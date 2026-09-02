import { z } from "zod";
import { ok, err, type ToolCtx } from "./shared.js";

export function registerNetworks({ server, client }: ToolCtx) {
  server.registerTool(
    "docker_networks",
    {
      title: "List networks",
      description: "List Docker networks on the host.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await client.networks());
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "docker_network_inspect",
    {
      title: "Inspect network",
      description: "Details of a network, including connected containers and IPAM config.",
      inputSchema: {
        network: z.string().min(1).describe("Network name or id."),
      },
    },
    async ({ network }) => {
      try {
        return ok(await client.networkInspect(network));
      } catch (e) {
        return err(e);
      }
    },
  );
}
