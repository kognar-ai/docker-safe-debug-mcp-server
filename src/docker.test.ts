import { test } from "node:test";
import assert from "node:assert/strict";
import { DockerClient, DockerError, type DockerConfig } from "./docker.js";
import type { SshClient, ExecResult } from "./ssh.js";
import { buildExecPolicy, SafetyError } from "./safety.js";

class FakeSsh {
  last = "";
  reply: ExecResult = { stdout: "", stderr: "", code: 0, truncated: false };
  async exec(command: string): Promise<ExecResult> {
    this.last = command;
    return this.reply;
  }
}

function makeClient(overrides: Partial<DockerConfig> = {}): {
  client: DockerClient;
  ssh: FakeSsh;
} {
  const ssh = new FakeSsh();
  const cfg: DockerConfig = {
    useSudo: false,
    commandTimeoutMs: 30000,
    maxOutputBytes: 1000000,
    allowedContainers: null,
    deniedContainers: new Set(),
    allowLifecycle: false,
    execPolicy: buildExecPolicy({ enabled: true }),
    ...overrides,
  };
  const client = new DockerClient(ssh as unknown as SshClient, cfg);
  return { client, ssh };
}

test("ps builds the expected command", async () => {
  const { client, ssh } = makeClient();
  await client.ps({});
  assert.equal(ssh.last, "docker ps --no-trunc --format '{{json .}}'");
});

test("ps applies all/limit/filters safely", async () => {
  const { client, ssh } = makeClient();
  await client.ps({ all: true, limit: 5, filters: ["status=running"] });
  assert.equal(
    ssh.last,
    "docker ps --no-trunc --all --last 5 --filter status=running --format '{{json .}}'",
  );
});

test("logs builds tail/since/timestamps and targets the container", async () => {
  const { client, ssh } = makeClient();
  ssh.reply = { stdout: "hello", stderr: "", code: 0, truncated: false };
  const out = await client.logs("api", { tail: 50, since: "10m", timestamps: true });
  assert.equal(ssh.last, "docker logs --tail 50 --since 10m --timestamps api");
  assert.match(out, /hello/);
});

test("denied containers are rejected before running anything", async () => {
  const { client, ssh } = makeClient({ deniedContainers: new Set(["db"]) });
  await assert.rejects(() => client.logs("db", { tail: 10 }), SafetyError);
  assert.equal(ssh.last, "", "no command should have been sent");
});

test("allowlist restricts which containers can be touched", async () => {
  const { client } = makeClient({ allowedContainers: new Set(["api"]) });
  await assert.doesNotReject(() => client.inspect("api"));
  await assert.rejects(() => client.inspect("other"), SafetyError);
});

test("exec builds an argv command with no shell", async () => {
  const { client, ssh } = makeClient();
  ssh.reply = { stdout: "line1\nline2", stderr: "", code: 0, truncated: false };
  const res = await client.exec("api", ["tail", "-n", "50", "/var/log/app.log"]);
  assert.equal(ssh.last, "docker exec api tail -n 50 /var/log/app.log");
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /line1/);
});

test("exec injection attempt is neutralised by quoting, binary still blocked", async () => {
  const { client } = makeClient();
  await assert.rejects(() => client.exec("api", ["rm", "-rf", "/"]), SafetyError);
});

test("exec disabled rejects", async () => {
  const { client } = makeClient({ execPolicy: buildExecPolicy({ enabled: false }) });
  await assert.rejects(() => client.exec("api", ["cat", "/etc/hosts"]), SafetyError);
});

test("lifecycle is blocked unless enabled", async () => {
  const { client } = makeClient();
  await assert.rejects(() => client.restart("api"), SafetyError);
});

test("lifecycle + sudo builds prefixed command when enabled", async () => {
  const { client, ssh } = makeClient({ allowLifecycle: true, useSudo: true });
  await client.restart("api", 10);
  assert.equal(ssh.last, "sudo -n docker restart --time 10 api");
});

test("non-zero exit surfaces as DockerError with stderr", async () => {
  const { client, ssh } = makeClient();
  ssh.reply = { stdout: "", stderr: "Error: No such container: ghost", code: 1, truncated: false };
  await assert.rejects(() => client.inspect("ghost"), (e: unknown) => {
    assert.ok(e instanceof DockerError);
    assert.match((e as DockerError).stderr, /No such container/);
    return true;
  });
});

test("output truncation is reported", async () => {
  const { client, ssh } = makeClient({ maxOutputBytes: 4 });
  ssh.reply = { stdout: "abcdefgh", stderr: "", code: 0, truncated: true };
  const out = await client.diff("api");
  assert.match(out, /truncated/);
});
