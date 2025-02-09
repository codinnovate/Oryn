import { Test, type TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "@/app.module";
import { PinoLoggerService } from "@/lib/logger";

describe("Health (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ logger: new PinoLoggerService() });
    app.setGlobalPrefix("api/v1");
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/v1/health returns ok envelope", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/v1/health")
      .expect(200);
    expect(res.body).toMatchObject({
      status: "ok",
      service: "oryn-api",
      version: "v1",
      environment: "test",
    });
    expect(typeof res.body.timestamp).toBe("string");
  });

  it("assigns an X-Request-Id header to responses", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/health");
    expect(res.headers["x-request-id"]).toMatch(/^req_/);
  });

  it("honors inbound x-request-id headers", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/v1/health")
      .set("x-request-id", "req_test-correlation-123");
    expect(res.headers["x-request-id"]).toBe("req_test-correlation-123");
  });

  it("renders unknown routes in the standard error envelope", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({
      code: "RESOURCE_NOT_FOUND",
      details: null,
    });
    expect(res.body.error.requestId).toMatch(/^req_/);
  });
});
