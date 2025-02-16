import { z } from "zod";

/** Scalar validator for a single route parameter. */
export const uuidParamSchema = z.string().uuid("Invalid resource id");

export const idParamSchema = z.object({
  id: z.string().uuid("Invalid resource id"),
});
