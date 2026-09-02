import { z } from "zod";
import { ok, err, filters, type ToolCtx } from "./shared.js";

export function registerImages({ server, client }: ToolCtx) {
  server.registerTool(
    "docker_images",
    {
      title: "List images",
      description: "List images present on the host.",
      inputSchema: {
        all: z.boolean().optional().describe("Include intermediate image layers."),
        filters,
      },
    },
    async ({ all, filters }) => {
      try {
        return ok(await client.images({ all, filters }));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "docker_image_inspect",
    {
      title: "Inspect image",
      description: "Low-level details of an image (layers, config, entrypoint, env, labels).",
      inputSchema: {
        image: z.string().min(1).describe("Image name/tag/id (e.g. 'nginx:1.27' or a sha256 id)."),
      },
    },
    async ({ image }) => {
      try {
        return ok(await client.imageInspect(image));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "docker_image_history",
    {
      title: "Image history",
      description: "Show the build history / layers of an image.",
      inputSchema: {
        image: z.string().min(1).describe("Image name/tag/id."),
      },
    },
    async ({ image }) => {
      try {
        return ok(await client.imageHistory(image));
      } catch (e) {
        return err(e);
      }
    },
  );
}
