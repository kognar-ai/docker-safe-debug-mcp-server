import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Client, type ConnectConfig } from "ssh2";

export class SshError extends Error {
  constructor(
    message: string,
    public detail?: unknown,
  ) {
    super(message);
    this.name = "SshError";
  }
}

export type SshConfig = {
  host: string;
  port: number;
  username: string;
  privateKeyPath?: string;
  privateKeyData?: string;
  passphrase?: string;
  password?: string;
  readyTimeoutMs?: number;
};

export type ExecResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal?: string;
  truncated: boolean;
};

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return `${homedir()}/${p.slice(2)}`;
  return p;
}

/**
 * Thin promise wrapper around ssh2 with a single, lazily-established,
 * reused connection. Every exec is bounded by a timeout and the captured
 * output is capped, so a hung or noisy command can never wedge the server.
 */
export class SshClient {
  private cfg: SshConfig;
  private conn: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(cfg: SshConfig) {
    this.cfg = cfg;
  }

  private buildConnectConfig(): ConnectConfig {
    const base: ConnectConfig = {
      host: this.cfg.host,
      port: this.cfg.port,
      username: this.cfg.username,
      readyTimeout: this.cfg.readyTimeoutMs ?? 20_000,
      keepaliveInterval: 15_000,
    };

    let privateKey: string | Buffer | undefined;
    if (this.cfg.privateKeyData) {
      privateKey = this.cfg.privateKeyData.includes("\\n")
        ? this.cfg.privateKeyData.replace(/\\n/g, "\n")
        : this.cfg.privateKeyData;
    } else if (this.cfg.privateKeyPath) {
      try {
        privateKey = readFileSync(expandHome(this.cfg.privateKeyPath));
      } catch (e) {
        throw new SshError(
          `Could not read private key at ${this.cfg.privateKeyPath}`,
          e instanceof Error ? e.message : e,
        );
      }
    }

    if (privateKey) {
      base.privateKey = privateKey;
      if (this.cfg.passphrase) base.passphrase = this.cfg.passphrase;
    } else if (this.cfg.password) {
      base.password = this.cfg.password;
    } else if (process.env.SSH_AUTH_SOCK) {
      base.agent = process.env.SSH_AUTH_SOCK;
    } else {
      throw new SshError(
        "No SSH auth available: set a private key, a password, or run an SSH agent.",
      );
    }
    return base;
  }

  private connect(): Promise<Client> {
    if (this.conn) return Promise.resolve(this.conn);
    if (this.connecting) return this.connecting;

    const connectConfig = this.buildConnectConfig();
    this.connecting = new Promise<Client>((resolve, reject) => {
      const client = new Client();
      const onError = (err: Error) => {
        this.conn = null;
        this.connecting = null;
        reject(new SshError(`SSH connection failed: ${err.message}`, err));
      };
      client
        .once("ready", () => {
          client.removeListener("error", onError);
          client.on("error", () => {
            // Drop the cached connection so the next call reconnects cleanly.
            this.conn = null;
          });
          client.on("close", () => {
            this.conn = null;
          });
          this.conn = client;
          this.connecting = null;
          resolve(client);
        })
        .once("error", onError)
        .connect(connectConfig);
    });
    return this.connecting;
  }

  async exec(
    command: string,
    opts: { timeoutMs: number; maxOutputBytes: number },
  ): Promise<ExecResult> {
    const client = await this.connect();

    return new Promise<ExecResult>((resolve, reject) => {
      client.exec(command, { pty: false }, (err, stream) => {
        if (err) {
          reject(new SshError(`Failed to start command: ${err.message}`, err));
          return;
        }

        let stdout = "";
        let stderr = "";
        let truncated = false;
        let settled = false;
        const cap = opts.maxOutputBytes;

        const append = (buf: string, chunk: Buffer) => {
          if (buf.length >= cap) {
            truncated = true;
            return buf;
          }
          const next = buf + chunk.toString("utf8");
          if (next.length > cap) {
            truncated = true;
            return next.slice(0, cap);
          }
          return next;
        };

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          truncated = true;
          stream.close();
          resolve({
            stdout,
            stderr:
              stderr +
              `\n[docker-safe-debug] command timed out after ${opts.timeoutMs}ms and was terminated.`,
            code: null,
            signal: "TIMEOUT",
            truncated: true,
          });
        }, opts.timeoutMs);

        stream
          .on("close", (code: number | null, signal?: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ stdout, stderr, code, signal, truncated });
          })
          .on("data", (chunk: Buffer) => {
            stdout = append(stdout, chunk);
          });
        stream.stderr.on("data", (chunk: Buffer) => {
          stderr = append(stderr, chunk);
        });
      });
    });
  }

  dispose(): void {
    if (this.conn) {
      this.conn.end();
      this.conn = null;
    }
  }
}
