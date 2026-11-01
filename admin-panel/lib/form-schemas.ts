import { z } from "zod";

// Zod otherwise probes `new Function` to enable its JIT, which the panel's CSP correctly blocks and reports as a violation.
z.config({ jitless: true });

/**
 * Validation schemas of the two admin forms that use zod. They run in the
 * browser (react-hook-form + zodResolver) and live here, away from the React
 * components, so tests/unit/adminFormSchemas.test.js can exercise the very
 * schemas the forms use. The server validates the same data again independently.
 */

export const broadcastSchema = z.object({
  message: z.string().trim().min(1, "Message is required").max(4096, "Message must be at most 4096 characters"),
  audience: z.enum(["all", "active", "expired", "paying", "custom"]),
  customTelegramIds: z.string().optional(),
  buttons: z
    .array(
      z.object({
        text: z.string().trim().min(1, "Button text is required").max(64, "At most 64 characters"),
        url: z.string().trim().url("Must be a valid URL").refine((value) => /^https:\/\/(t\.me|telegram\.me|telegram\.dog)\//.test(value), "Must be a t.me link"),
      })
    )
    .max(4, "At most 4 buttons"),
});

export const productSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120, "Name must be at most 120 characters"),
  durationDays: z.coerce.number<number>().int().min(1, "Must be at least 1 day").max(3650, "Must be at most 3650 days"),
  /**
   * 0 means unlimited, set by the form's own switch. z.coerce turns a blank input into 0, so a cleared field would become an
   * unlimited product and reach the server as a real zero: blank has to fail here, before it is coerced.
   */
  trafficGb: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? Number.NaN : value),
    z.coerce.number<number>({ error: "Enter the traffic in GB" }).int().min(0, "Cannot be negative").max(10_000, "Must be at most 10,000 GB"),
  ) as unknown as z.ZodType<number, number>,
  priceToman: z.coerce.number<number>().int().min(1, "Price must be positive").max(2_000_000_000, "Price is too large"),
  costToman: z.coerce.number<number>().int().min(0, "Cost cannot be negative").max(2_000_000_000, "Cost is too large"),
  enabled: z.boolean(),
  published: z.boolean(),
  /** Optional custom identifier, only used when creating a plan. */
  productId: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{2,31}$/, "Use 3–32 lowercase letters, digits or _, starting with a letter")
    .optional()
    .or(z.literal("")),
});

/** The bot sells exactly these subscription lengths; the server enforces the same list. Mirrors subscription-durations.ts. */
export const SUBSCRIPTION_DURATION_DAYS = [30, 90, 180, 365] as const;

export type BroadcastFormValues = z.infer<typeof broadcastSchema>;
export type ProductFormValues = z.infer<typeof productSchema>;
