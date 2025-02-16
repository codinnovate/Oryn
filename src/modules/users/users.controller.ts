import { Body, Controller, Delete, Get, HttpCode, Patch } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { ZodValidationPipe } from "@/lib/http/zod-validation.pipe";
import { toPublicUser } from "@/modules/auth/auth.service";
import {
  CurrentUser,
  type AuthenticatedRequest,
} from "@/modules/auth/decorators/auth.decorators";
import { Req } from "@nestjs/common";
import { UsersService } from "@/modules/users/users.service";
import {
  changePasswordSchema,
  notificationPrefsSchema,
  preferencesSchema,
  updateProfileSchema,
  type ChangePasswordDto,
  type NotificationPrefsDto,
  type PreferencesDto,
  type UpdateProfileDto,
} from "@/modules/users/schemas";

@ApiTags("users")
@Controller("users")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get("me")
  @ApiOperation({ summary: "Get the authenticated user's profile" })
  @ApiResponse({ status: 200, description: "Current profile" })
  async me(@CurrentUser() user?: { id: string }) {
    const profile = await this.usersService.getProfile(user!.id);
    return { data: toPublicUser(profile) };
  }

  @Patch("me")
  @ApiOperation({ summary: "Update profile fields (name, avatar)" })
  async updateMe(
    @Body(new ZodValidationPipe(updateProfileSchema)) dto: UpdateProfileDto,
    @CurrentUser() user?: { id: string },
  ) {
    const updated = await this.usersService.updateProfile(user!.id, dto);
    return { data: toPublicUser(updated) };
  }

  @HttpCode(200)
  @Patch("me/password")
  @ApiOperation({
    summary: "Change password; revokes all other sessions",
    description:
      "Requires the current password when one is set. The calling session stays signed in.",
  })
  @ApiResponse({ status: 200, description: "Password changed" })
  async changePassword(
    @Body(new ZodValidationPipe(changePasswordSchema)) dto: ChangePasswordDto,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.usersService.changePassword(
      req.user!.id,
      req.sessionId,
      dto.currentPassword,
      dto.newPassword,
    );
    return { data: { success: true } };
  }

  @Patch("me/preferences")
  @ApiOperation({ summary: "Merge keys into user preferences" })
  async updatePreferences(
    @Body(new ZodValidationPipe(preferencesSchema)) dto: PreferencesDto,
    @CurrentUser() user?: { id: string },
  ) {
    const updated = await this.usersService.updatePreferences(user!.id, dto);
    return { data: { preferences: updated.preferences } };
  }

  @Patch("me/notifications")
  @ApiOperation({
    summary: "Merge notification settings",
    description: "Stored under preferences.notifications.",
  })
  async updateNotifications(
    @Body(new ZodValidationPipe(notificationPrefsSchema)) dto: NotificationPrefsDto,
    @CurrentUser() user?: { id: string },
  ) {
    const updated = await this.usersService.updateNotifications(user!.id, dto);
    return { data: { notifications: (updated.preferences as Record<string, unknown>)?.notifications ?? {} } };
  }

  @HttpCode(200)
  @Delete("me")
  @ApiOperation({
    summary: "Soft-delete the account and revoke all sessions",
  })
  async deleteAccount(
    @CurrentUser() user?: { id: string },
    @Req() req?: AuthenticatedRequest,
  ) {
    void req;
    await this.usersService.deleteAccount(user!.id);
    return { data: { deleted: true } };
  }
}
