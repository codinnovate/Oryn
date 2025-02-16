import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { getEnv } from "@/lib/env";
import { Public } from "@/modules/auth/decorators/auth.decorators";

@ApiTags("system")
@Controller("health")
export class HealthController {
  @Public()
  @Get()
  @ApiOperation({ summary: "Liveness probe with environment metadata" })
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
