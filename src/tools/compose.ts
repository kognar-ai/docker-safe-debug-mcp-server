import { z } from "zod";
import { ok, err, type ToolCtx } from "./shared.js";

const composeTarget = {
  project_directory: z
    .string()
    .optional()
    .describe("Directory containing the compose file (docker compose --project-directory)."),
  file: z.string().optional().describe("Path to a specific compose file (-f)."),
  project_name: z.string().optional().describe("Compose project name (-p)."),
};

export function registerCompose({ server, client }: ToolCtx) {
  server.registerTool(
    "docker_compose_ps",
    {
      title: "Compose services status",
      description: "List the services of a Docker Compose project and their state.",
      inputSchema: {
        ...composeTarget,
        all: z.boolean().optional().describe("Include stopped services."),
      },
    },
    async ({ project_directory, file, project_name, all }) => {
      try {
        return ok(
          await client.composePs({
            projectDirectory: project_directory,
            file,
            projectName: project_name,
            all,
          }),
        );
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "docker_compose_logs",
    {
      title: "Compose logs",
      description: "Fetch recent logs for a Compose project or a single service. Never follows.",
      inputSchema: {
        ...composeTarget,
        service: z.string().optional().describe("Restrict to one service."),
        tail: z.number().int().min(1).max(10000).optional().describe("Lines from the end (default 200)."),
        timestamps: z.boolean().optional().describe("Prefix each line with a timestamp."),
      },
    },
    async ({ project_directory, file, project_name, service, tail, timestamps }) => {
      try {
        return ok(
          await client.composeLogs({
            projectDirectory: project_directory,
            file,
            projectName: project_name,
            service,
            tail: tail ?? 200,
            timestamps,
          }),
        );
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "docker_compose_config",
    {
      title: "Compose resolved config",
      description: "Show the fully-resolved compose configuration (or just the service names).",
      inputSchema: {
        ...composeTarget,
        services_only: z.boolean().optional().describe("List only the service names."),
      },
    },
    async ({ project_directory, file, project_name, services_only }) => {
      try {
        return ok(
          await client.composeConfig({
            projectDirectory: project_directory,
            file,
            projectName: project_name,
            servicesOnly: services_only,
          }),
        );
      } catch (e) {
        return err(e);
      }
    },
  );
}
