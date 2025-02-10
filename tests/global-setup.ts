import net from "node:net";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { TEST_DATABASE_URL } from "./config";

/**
 * Boots a dedicated PostgreSQL cluster for the test run if none is reachable
 * at TEST_DATABASE_URL. Uses locally installed Postgres binaries (Homebrew)
 * — no Docker required. Data lives under .test-data/ (gitignored).
 */

const DATA_DIR = path.resolve(process.cwd(), ".test-data/pg");
const LOG_FILE = path.resolve(process.cwd(), ".test-data/pg.log");

// globalSetup runs before setupFiles — provide the env application code expects.
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? TEST_DATABASE_URL;
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ?? "dGVzdC1vbmx5LWVuY3J5cHRpb24ta2V5LTMyLWJ5dGVzIQ==";
process.env.STATE_SECRET = process.env.STATE_SECRET ?? "test-state-secret-do-not-use";

function findPgBin(name: string): string | null {
  const candidates = [
    process.env.PG_BIN_DIR,
    "/opt/homebrew/opt/postgresql@17/bin",
    "/opt/homebrew/opt/postgresql/bin",
    "/usr/local/opt/postgresql@17/bin",
    "/usr/local/opt/postgresql/bin",
  ].filter((p): p is string => Boolean(p));
  for (const dir of candidates) {
    const full = path.join(dir, name);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      // keep looking
    }
  }
  return null;
}

function parseUrl(urlStr: string): URL {
  return new URL(urlStr);
}

async function canConnect(urlStr: string, timeoutMs = 800): Promise<boolean> {
  const url = parseUrl(urlStr);
  // TCP pre-check avoids slow libpq timeouts when nothing listens.
  const portOpen = await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: url.hostname, port: Number(url.port || 5432) });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
  if (!portOpen) return false;
  const client = new pg.Client({ connectionString: urlStr, connectionTimeoutMillis: timeoutMs });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function waitForDb(urlStr: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    if (await canConnect(urlStr, 1500)) {
      return;
    }
    lastErr = new Error("not ready");
    await sleep(500);
  }
  throw new Error(`Postgres did not become ready at ${urlStr}: ${String(lastErr)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let serverProcess: ReturnType<typeof spawn> | null = null;

async function bootLocalCluster(port: number): Promise<void> {
  const initdb = findPgBin("initdb");
  const pgCtl = findPgBin("pg_ctl");
  if (!initdb || !pgCtl) {
    throw new Error(
      "No running Postgres found and no local postgres binaries located. " +
        "Start Postgres (e.g. `docker compose up -d postgres`) or set PG_BIN_DIR.",
    );
  }
  fs.mkdirSync(path.dirname(DATA_DIR), { recursive: true });
  if (!fs.existsSync(path.join(DATA_DIR, "PG_VERSION"))) {
    execFileSync(initdb, ["-D", DATA_DIR, "-U", "oryn", "-A", "trust", "-E", "UTF8"], {
      stdio: "ignore",
    });
  }
  serverProcess = spawn(
    pgCtl,
    [
      "-D",
      DATA_DIR,
      "-l",
      LOG_FILE,
      "-o",
      `-p ${port} -c listen_addresses=127.0.0.1`,
      "start",
    ],
    { stdio: "ignore" },
  );
  const base = new URL(TEST_DATABASE_URL);
  base.pathname = "/postgres";
  await waitForDb(base.toString());
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const url = new URL(TEST_DATABASE_URL);
  const port = Number(url.port || 5432);
  const dbName = url.pathname.replace(/^\//, "");

  let startedByUs = false;
  if (!(await canConnect(TEST_DATABASE_URL))) {
    const base = new URL(TEST_DATABASE_URL);
    base.pathname = "/postgres";
    if (await canConnect(base.toString())) {
      // Server is up but test DB missing — fine, created below.
    } else {
      await bootLocalCluster(port);
      startedByUs = true;
    }
  }

  const adminClient = new pg.Client({ connectionString: (() => { const u = new URL(TEST_DATABASE_URL); u.pathname = "/postgres"; return u.toString(); })() });
  try {
    await adminClient.connect();
    await adminClient.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await adminClient.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await adminClient.end().catch(() => undefined);
  }

  // Apply migrations to the fresh test database.
  const { runMigrations } = await import("@/lib/db/migrate");
  await runMigrations(TEST_DATABASE_URL);

  return async () => {
    if (startedByUs && serverProcess) {
      const pgCtl = findPgBin("pg_ctl");
      if (pgCtl) {
        try {
          execFileSync(pgCtl, ["-D", DATA_DIR, "stop", "-m", "fast"], { stdio: "ignore" });
        } catch {
          // best effort
        }
      }
      serverProcess = null;
    }
  };
}
