import { describe, it, expect, vi, beforeEach } from "vitest";

const queueCtorArgs: { name: string; options: Record<string, unknown> }[] = [];
const redisCtorArgs: { url: string; options: Record<string, unknown> }[] = [];
const addCalls: { queue: string; jobName: string; data: unknown }[] = [];

function makeFakeQueue(name: string) {
  return {
    name,
    add: vi.fn(async (jobName: string, data: unknown) => {
      addCalls.push({ queue: name, jobName, data });
      return { id: `${name}-1` };
    }),
    close: vi.fn(async () => undefined),
  };
}

const fakeQueues = new Map<string, ReturnType<typeof makeFakeQueue>>();

vi.mock("bullmq", () => ({
  Queue: class FakeQueue {
    name: string;
    add: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    constructor(name: string, options?: Record<string, unknown>) {
      queueCtorArgs.push({ name, options: options ?? {} });
      this.name = name;
      const fake = makeFakeQueue(name);
      this.add = fake.add;
      this.close = fake.close;
      fakeQueues.set(name, fake);
    }
  },
}));

vi.mock("ioredis", () => ({
  default: class FakeRedis {
    on = vi.fn();
    quit = vi.fn().mockResolvedValue("OK");
    disconnect = vi.fn();
    options: Record<string, unknown>;
    constructor(url: string, options: Record<string, unknown>) {
      redisCtorArgs.push({ url, options });
      this.options = options;
    }
  },
}));

describe("queue registry", () => {
  beforeEach(async () => {
    queueCtorArgs.length = 0;
    redisCtorArgs.length = 0;
    addCalls.length = 0;
    fakeQueues.clear();
    const mod = await import("@/lib/queue/queues");
    await mod.closeQueues();
  });

  it("creates queues lazily and reuses one instance per name", async () => {
    const { getQueue, QUEUE_NAMES } = await import("@/lib/queue/queues");
    expect(queueCtorArgs).toHaveLength(0);

    const first = getQueue(QUEUE_NAMES.emailSync);
    const second = getQueue(QUEUE_NAMES.emailSync);
    expect(first).toBe(second);
    expect(queueCtorArgs).toHaveLength(1);
    const ctor = queueCtorArgs[0]!;
    expect(ctor.name).toBe("email-sync");
    // Each queue gets a dedicated BullMQ connection.
    expect(ctor.options.connection).toBeDefined();
    expect(redisCtorArgs).toHaveLength(1);
  });

  it("queue connections tolerate blocked event loops", async () => {
    const { getQueue, QUEUE_NAMES } = await import("@/lib/queue/queues");
    getQueue(QUEUE_NAMES.emailSync);
    const connection = queueCtorArgs[0]!.options.connection as {
      options: Record<string, unknown>;
    };
    expect(connection.options.maxRetriesPerRequest).toBeNull();
  });

  it("enqueue adds a named job and returns its id", async () => {
    const { enqueue, QUEUE_NAMES } = await import("@/lib/queue/queues");
    const jobId = await enqueue(QUEUE_NAMES.emailSync, "sync-account", {
      emailAccountId: "acc_1",
    });

    expect(jobId).toBe("email-sync-1");
    expect(addCalls).toEqual([
      {
        queue: "email-sync",
        jobName: "sync-account",
        data: { emailAccountId: "acc_1" },
      },
    ]);
  });

  it("applies durable default job options", async () => {
    const { getQueue, enqueue, QUEUE_NAMES } = await import("@/lib/queue/queues");
    getQueue(QUEUE_NAMES.emailSync);
    await enqueue(QUEUE_NAMES.emailSync, "sync-account", {});

    const defaults = queueCtorArgs[0]!.options.defaultJobOptions as {
      attempts: number;
      backoff: unknown;
      removeOnComplete: unknown;
      removeOnFail: unknown;
    };
    expect(defaults.attempts).toBeGreaterThan(0);
    expect(defaults.backoff).toBeDefined();
    expect(defaults.removeOnComplete).toBeDefined();
    expect(defaults.removeOnFail).toBeDefined();
  });

  it("closeQueues closes every created queue and connection exactly once", async () => {
    const { getQueue, closeQueues, QUEUE_NAMES } = await import("@/lib/queue/queues");
    getQueue(QUEUE_NAMES.emailSync);
    await closeQueues();
    expect(fakeQueues.get("email-sync")!.close).toHaveBeenCalledTimes(1);
  });
});
