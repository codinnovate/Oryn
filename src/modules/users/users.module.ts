import { Module } from "@nestjs/common";
import { AuthModule } from "@/modules/auth/auth.module";
import { UsersController } from "@/modules/users/users.controller";
import { UsersService } from "@/modules/users/users.service";
import { SessionsController } from "@/modules/users/sessions.controller";

@Module({
  imports: [AuthModule],
  controllers: [UsersController, SessionsController],
  providers: [UsersService],
})
export class UsersModule {}
