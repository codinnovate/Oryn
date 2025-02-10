/** Shared constants for the test harness. */
export const PG_PORT = Number(process.env.TEST_PG_PORT ?? 54329);
export const PG_HOST = "127.0.0.1";
export const PG_USER = "oryn";
export const PG_PASSWORD = "oryn";
export const TEST_DB_NAME = "oryn_test";
export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  `postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${TEST_DB_NAME}`;
