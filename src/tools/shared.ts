import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DockerClient, DockerError } from "../docker.js";
import { SafetyError } from "../safety.js";
import { SshError } from "../ssh.js";

export type ToolCtx = { client: DockerClient; server: McpServer };

export function ok(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

export function err(e: unknown) {
  let message: string;
  if (e instanceof SafetyError) {
    message = `Blocked by safety policy: ${e.message}`;
  } else if (e instanceof DockerError) {
    message = `${e.message}\n${e.stderr}`;
  } else if (e instanceof SshError) {
    message = `SSH error: ${e.message}${e.detail ? `\n${JSON.stringify(e.detail)}` : ""}`;
  } else if (e instanceof Error) {
    message = e.message;
  } else {
    message = String(e);
  }
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

export const containerName = z
  .string()
  .min(1)
  .describe("Container name or id (as shown by docker_ps).");

export const filters = z
  .array(z.string())
  .optional()
  .describe("Optional docker filters, each 'key=value' (e.g. ['status=running','name=api']).");
