import { describe, it, expect, vi, beforeEach } from "vitest";

type RedisOptions = Record<string, unknown>;

const constructed: { url: string; options: RedisOptions }[] = [];
const instances: {
  on: ReturnType<typeof vi.fn>;
  ping: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}[] = [];

vi.mock("ioredis", () => ({
  default: class FakeRedis {
    on = vi.fn();
    ping = vi.fn().mockResolvedValue("PONG");
    quit = vi.fn().mockResolvedValue("OK");
    disconnect = vi.fn();
    constructor(url: string, options: RedisOptions) {
      constructed.push({ url, options });
      instances.push(this as never);
    }
  },
}));

describe("shared redis connection", () => {
  beforeEach(async () => {
    constructed.length = 0;
    instances.length = 0;
    await close();
  });

  async function close() {
    const mod = await import("@/lib/redis/redis");
    await mod.closeRedis();
  }

  it("lazily creates a single shared connection from REDIS_URL", async () => {
    const { getRedis } = await import("@/lib/redis/redis");
    expect(constructed).toHaveLength(0);

    const first = getRedis();
    const second = getRedis();
    expect(first).toBe(second);
    expect(constructed).toHaveLength(1);
    const ctor = constructed[0]!;
    expect(ctor.url).toBe(process.env.REDIS_URL);
    expect(ctor.options.lazyConnect).toBe(true);
  });

  it("registers an error handler so idle errors do not crash the process", async () => {
    const { getRedis } = await import("@/lib/redis/redis");
    getRedis();
    expect(instances[0]!.on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("pingRedis reports PONG as healthy", async () => {
    const { getRedis, pingRedis } = await import("@/lib/redis/redis");
    getRedis();
    await expect(pingRedis()).resolves.toBe(true);
    expect(instances[0]!.ping).toHaveBeenCalledTimes(1);
  });

  it("pingRedis reports unhealthy instead of throwing when down", async () => {
    const { getRedis, pingRedis } = await import("@/lib/redis/redis");
    getRedis();
    (instances[0]!.ping as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("connection refused"),
    );
    await expect(pingRedis()).resolves.toBe(false);
  });

  it("closeRedis quits and drops the singleton", async () => {
    const { getRedis, closeRedis, pingRedis } = await import("@/lib/redis/redis");
    getRedis();
    await closeRedis();
    expect(instances[0]!.quit).toHaveBeenCalled();

    // A fresh client is created after close.
    getRedis();
    await pingRedis();
    expect(constructed).toHaveLength(2);
  });

  it("closeRedis force-disconnects when quit fails", async () => {
    const { getRedis, closeRedis } = await import("@/lib/redis/redis");
    getRedis();
    (instances[0]!.quit as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("not connected"),
    );
    await expect(closeRedis()).resolves.toBeUndefined();
    expect(instances[0]!.disconnect).toHaveBeenCalled();
  });
});
