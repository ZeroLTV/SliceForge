import * as crypto from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import lockfile from "proper-lockfile";
import { atomicWrite } from "./runtime-store.js";

export interface PortLease {
  owner: string;
  port: number;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

interface PortState {
  schemaVersion: 1;
  leases: PortLease[];
}

export function getPortAllocatorDataRoot(): string {
  const base =
    process.platform === "win32"
      ? (process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"))
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support")
        : (process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"));
  return path.join(base, "SliceForge");
}

function available(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

export class PortAllocator {
  private readonly statePath: string;
  private readonly lockPath: string;

  constructor(
    runtimeRoot: string,
    private readonly start: number,
    private readonly end: number,
  ) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1024 || end > 65535) {
      throw new Error(
        "Port allocator range must contain integer user ports between 1024 and 65535.",
      );
    }
    if (end < start || end - start + 1 > 10_000) {
      throw new Error("Port allocator range must be ordered and contain at most 10000 ports.");
    }
    this.statePath = path.join(runtimeRoot, "ports.json");
    this.lockPath = path.join(runtimeRoot, "ports.lock");
  }

  private read(): PortState {
    if (!fs.existsSync(this.statePath)) return { schemaVersion: 1, leases: [] };
    const value = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as PortState;
    if (
      value.schemaVersion !== 1 ||
      !Array.isArray(value.leases) ||
      !value.leases.every(
        (lease) =>
          lease &&
          typeof lease.owner === "string" &&
          Number.isInteger(lease.port) &&
          typeof lease.expiresAt === "string",
      )
    ) {
      throw new Error(`Port allocator state is invalid: ${this.statePath}`);
    }
    return value;
  }

  private save(state: PortState): void {
    atomicWrite(this.statePath, JSON.stringify(state, null, 2));
  }

  private async locked<T>(action: () => Promise<T>): Promise<T> {
    fs.mkdirSync(this.lockPath, { recursive: true });
    const release = await lockfile.lock(this.lockPath, {
      realpath: false,
      stale: 60_000,
      retries: { retries: 120, factor: 1, minTimeout: 25, maxTimeout: 100 },
    });
    try {
      return await action();
    } finally {
      await release();
    }
  }

  async acquire(owner: string, ttlMs: number): Promise<PortLease> {
    if (!owner || !Number.isFinite(ttlMs) || ttlMs < 1000) {
      throw new Error("Port lease requires an owner and a TTL of at least 1000 ms.");
    }
    return this.locked(async () => {
      const now = Date.now();
      const state = this.read();
      state.leases = state.leases.filter((lease) => Date.parse(lease.expiresAt) > now);
      const existing = state.leases.find(
        (lease) => lease.owner === owner && lease.port >= this.start && lease.port <= this.end,
      );
      if (existing) {
        existing.heartbeatAt = new Date(now).toISOString();
        existing.expiresAt = new Date(now + ttlMs).toISOString();
        this.save(state);
        return existing;
      }
      state.leases = state.leases.filter((lease) => lease.owner !== owner);
      const leased = new Set(state.leases.map((lease) => lease.port));
      const size = this.end - this.start + 1;
      const offset = crypto.createHash("sha256").update(owner).digest().readUInt32BE(0) % size;
      for (let index = 0; index < size; index++) {
        const port = this.start + ((offset + index) % size);
        if (leased.has(port) || !(await available(port))) continue;
        const timestamp = new Date(now).toISOString();
        const lease: PortLease = {
          owner,
          port,
          acquiredAt: timestamp,
          heartbeatAt: timestamp,
          expiresAt: new Date(now + ttlMs).toISOString(),
        };
        state.leases.push(lease);
        this.save(state);
        return lease;
      }
      this.save(state);
      throw new Error(`No available port remains in configured range ${this.start}-${this.end}.`);
    });
  }

  async renew(owner: string, ttlMs: number): Promise<boolean> {
    return this.locked(async () => {
      const now = Date.now();
      const state = this.read();
      state.leases = state.leases.filter((lease) => Date.parse(lease.expiresAt) > now);
      const lease = state.leases.find((candidate) => candidate.owner === owner);
      if (!lease) {
        this.save(state);
        return false;
      }
      lease.heartbeatAt = new Date(now).toISOString();
      lease.expiresAt = new Date(now + ttlMs).toISOString();
      this.save(state);
      return true;
    });
  }

  async release(owner: string): Promise<void> {
    await this.locked(async () => {
      const state = this.read();
      state.leases = state.leases.filter((lease) => lease.owner !== owner);
      this.save(state);
    });
  }

  async list(): Promise<PortLease[]> {
    return this.locked(async () => {
      const now = Date.now();
      const state = this.read();
      state.leases = state.leases.filter((lease) => Date.parse(lease.expiresAt) > now);
      this.save(state);
      return state.leases.map((lease) => ({ ...lease }));
    });
  }
}
