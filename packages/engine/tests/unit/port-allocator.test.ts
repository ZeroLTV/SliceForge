import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "@jest/globals";
import { getPortAllocatorDataRoot, PortAllocator } from "../../src/core/port-allocator";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sliceforge-ports-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("persistent port allocator", () => {
  it("allocates unique leases concurrently and releases them", async () => {
    const allocator = new PortAllocator(temporaryRoot(), 42_000, 42_099);
    const leases = await Promise.all(
      Array.from({ length: 8 }, (_, index) => allocator.acquire(`owner-${index}`, 10_000)),
    );
    expect(new Set(leases.map((lease) => lease.port)).size).toBe(leases.length);
    expect(await allocator.list()).toHaveLength(8);
    await Promise.all(leases.map((lease) => allocator.release(lease.owner)));
    expect(await allocator.list()).toEqual([]);
  });

  it("renews an owner in place and recovers an expired lease", async () => {
    const root = temporaryRoot();
    const allocator = new PortAllocator(root, 43_000, 43_000);
    const first = await allocator.acquire("first", 10_000);
    const renewed = await allocator.acquire("first", 20_000);
    expect(renewed.port).toBe(first.port);
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(first.expiresAt));

    const statePath = path.join(root, "ports.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      leases: Array<{ expiresAt: string }>;
    };
    state.leases[0].expiresAt = new Date(0).toISOString();
    fs.writeFileSync(statePath, JSON.stringify(state));
    const recovered = await allocator.acquire("second", 10_000);
    expect(recovered.port).toBe(first.port);
    expect((await allocator.list()).map((lease) => lease.owner)).toEqual(["second"]);
  });

  it("replaces an active owner lease when the configured range changes", async () => {
    const root = temporaryRoot();
    const original = await new PortAllocator(root, 46_000, 46_000).acquire("same-owner", 10_000);
    const moved = await new PortAllocator(root, 46_001, 46_001).acquire("same-owner", 10_000);
    expect(original.port).toBe(46_000);
    expect(moved.port).toBe(46_001);
    expect(await new PortAllocator(root, 46_001, 46_001).list()).toEqual([moved]);
  });

  it("skips ports already bound by a non-SliceForge process", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => resolve());
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP address.");
      const allocator = new PortAllocator(temporaryRoot(), address.port, address.port);
      await expect(allocator.acquire("blocked", 10_000)).rejects.toThrow(/no available port/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("fails closed on corrupted state and uses OS application data by default", async () => {
    const root = temporaryRoot();
    fs.writeFileSync(
      path.join(root, "ports.json"),
      JSON.stringify({ schemaVersion: 1, leases: {} }),
    );
    await expect(new PortAllocator(root, 44_000, 44_010).list()).rejects.toThrow(
      /state is invalid/i,
    );
    expect(path.isAbsolute(getPortAllocatorDataRoot())).toBe(true);
    expect(path.basename(getPortAllocatorDataRoot())).toBe("SliceForge");
  });
});
