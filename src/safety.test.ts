import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shellQuote,
  assertIdentifier,
  assertImageRef,
  assertFilter,
  assertExecAllowed,
  buildExecPolicy,
  SafetyError,
  EXEC_HARD_DENY,
} from "./safety.js";

test("shellQuote leaves safe tokens untouched", () => {
  assert.equal(shellQuote("api"), "api");
  assert.equal(shellQuote("/var/log/app.log"), "/var/log/app.log");
  assert.equal(shellQuote("nginx:1.27"), "nginx:1.27");
});

test("shellQuote neutralises metacharacters", () => {
  assert.equal(shellQuote("a b"), "'a b'");
  assert.equal(shellQuote("; rm -rf /"), "'; rm -rf /'");
  assert.equal(shellQuote("$(whoami)"), "'$(whoami)'");
  // embedded single quote is escaped, not terminated
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test("shellQuote rejects control characters", () => {
  assert.throws(() => shellQuote("a\nb"), SafetyError);
  assert.throws(() => shellQuote("a\0b"), SafetyError);
});

test("assertIdentifier accepts names/ids, rejects injection", () => {
  assert.equal(assertIdentifier("container", "api_worker-1.2"), "api_worker-1.2");
  assert.throws(() => assertIdentifier("container", "api; rm -rf /"), SafetyError);
  assert.throws(() => assertIdentifier("container", "../etc"), SafetyError);
  assert.throws(() => assertIdentifier("container", "a b"), SafetyError);
  assert.throws(() => assertIdentifier("container", "$(x)"), SafetyError);
});

test("assertImageRef allows registry/path/tag/digest", () => {
  assert.equal(assertImageRef("nginx:1.27"), "nginx:1.27");
  assert.equal(
    assertImageRef("registry.example.com/team/app:1.2@sha256:abc"),
    "registry.example.com/team/app:1.2@sha256:abc",
  );
  assert.throws(() => assertImageRef("nginx; echo hi"), SafetyError);
});

test("assertFilter enforces key=value shape", () => {
  assert.equal(assertFilter("status=running"), "status=running");
  assert.throws(() => assertFilter("status=running; rm"), SafetyError);
  assert.throws(() => assertFilter("nonsense"), SafetyError);
});

test("exec policy allows read-only binaries", () => {
  const policy = buildExecPolicy({ enabled: true });
  assert.deepEqual(assertExecAllowed(policy, ["cat", "/etc/hosts"]), ["cat", "/etc/hosts"]);
  assert.deepEqual(assertExecAllowed(policy, ["tail", "-n", "50", "/var/log/app.log"]), [
    "tail",
    "-n",
    "50",
    "/var/log/app.log",
  ]);
  // grep regex containing a pipe stays intact (single arg, shell-quoted later)
  assert.deepEqual(assertExecAllowed(policy, ["grep", "-E", "foo|bar", "/tmp/x"]), [
    "grep",
    "-E",
    "foo|bar",
    "/tmp/x",
  ]);
});

test("exec policy blocks shells, interpreters and writers", () => {
  const policy = buildExecPolicy({ enabled: true });
  for (const bad of [["sh", "-c", "rm -rf /"], ["bash"], ["rm", "-rf", "/"], ["python3"], ["tee", "x"], ["dd"]]) {
    assert.throws(() => assertExecAllowed(policy, bad), SafetyError, `should block ${bad[0]}`);
  }
  // even by absolute path
  assert.throws(() => assertExecAllowed(policy, ["/bin/sh", "-c", "x"]), SafetyError);
});

test("exec policy denies unknown binaries by default", () => {
  const policy = buildExecPolicy({ enabled: true });
  assert.throws(() => assertExecAllowed(policy, ["mytool"]), SafetyError);
});

test("operator can extend allowlist but never past hard-deny", () => {
  const policy = buildExecPolicy({ enabled: true, extraAllow: ["redis-cli"] });
  assert.deepEqual(assertExecAllowed(policy, ["redis-cli", "info"]), ["redis-cli", "info"]);
  assert.throws(() => buildExecPolicy({ enabled: true, extraAllow: ["bash"] }), SafetyError);
});

test("exec disabled rejects everything", () => {
  const policy = buildExecPolicy({ enabled: false });
  assert.throws(() => assertExecAllowed(policy, ["cat", "x"]), SafetyError);
});

test("hard-deny set contains the usual suspects", () => {
  for (const b of ["sh", "bash", "rm", "dd", "python3", "docker", "sudo", "mkfs"]) {
    assert.ok(EXEC_HARD_DENY.has(b), `${b} must be hard-denied`);
  }
});
