import { Controller, Get } from "@nestjs/common";
import { getEnv } from "@/lib/env";

@Controller("health")
export class HealthController {
  @Get()
  getHealth() {
    let environment: string = "unknown";
    try {
      environment = getEnv().NODE_ENV;
    } catch {
      // env invalid — still report liveness so orchestrators see the process.
    }
    return {
      status: "ok",
      service: "oryn-api",
      version: "v1",
      environment,
      timestamp: new Date().toISOString(),
    };
  }
}
