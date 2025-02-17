import { z } from "zod";

export const slugify = (value: string): string =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

const nameSchema = z.string().trim().min(2, "Name is too short").max(80);

export const createWorkspaceSchema = z.object({
  name: nameSchema,
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "Slug may contain lowercase letters, digits and dashes")
    .min(2)
    .max(48)
    .optional(),
});

export const updateWorkspaceSchema = z
  .object({
    name: nameSchema.optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

export const SYSTEM_ROLE_KEYS = ["owner", "admin", "member", "viewer"] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

export const roleKeySchema = z.enum(SYSTEM_ROLE_KEYS);

export const updateMemberSchema = z
  .object({
    status: z.enum(["active", "suspended"]).optional(),
    roleKey: roleKeySchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

export const inviteMemberSchema = z.object({
  email: z.email().max(320),
  roleKey: roleKeySchema.default("member"),
});

export type CreateWorkspaceDto = z.infer<typeof createWorkspaceSchema>;
export type UpdateWorkspaceDto = z.infer<typeof updateWorkspaceSchema>;
export type UpdateMemberDto = z.infer<typeof updateMemberSchema>;
export type InviteMemberDto = z.infer<typeof inviteMemberSchema>;
