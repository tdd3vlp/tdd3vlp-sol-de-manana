import { config } from "../config/env.js";

export const PLAN_LIMITS = {
  free: 10,
  basic: 100,
  premium: 300,
} as const;

export type Plan = keyof typeof PLAN_LIMITS;

// Fallbacks repeat the env.ts defaults so partial config mocks in tests
// cannot produce an undefined model.
export const PLAN_MODELS: Record<Plan, string> = {
  free: config.openaiModelFree ?? "gpt-4o-mini",
  basic: config.openaiModelPaid ?? "gpt-4o",
  premium: config.openaiModelPaid ?? "gpt-4o",
};

// Admins always get the premium model regardless of their chat's plan.
export function getPlanModel(plan: string, telegramUserId?: string): string {
  if (telegramUserId && isAdminUser(telegramUserId)) return PLAN_MODELS.premium;
  return PLAN_MODELS[plan as Plan] ?? PLAN_MODELS.free;
}

// When changing a price: the WebApp opens static invoice links
// (webapp/index.html, invoiceLinks) that carry the old amount. Pre-checkout
// validates against this table, so a stale link cannot charge the wrong
// price — it just gets rejected. Re-create the links via createInvoiceLink
// and update webapp/index.html in the same change.
export const PLAN_PRICES_STARS: Record<Exclude<Plan, "free">, number> = {
  basic: 200,
  premium: 600,
};

// Telegram provider payments use the minor unit for the selected currency:
// RUB amounts are passed in kopecks.
export const PLAN_PRICES_RUB: Record<Exclude<Plan, "free">, number> = {
  basic: 29900,
  premium: 89900,
};

export function isAdminUser(telegramUserId: string): boolean {
  return config.adminTelegramIds.includes(telegramUserId);
}

export function isBetaUser(telegramUserId: string): boolean {
  return (
    config.betaTelegramIds.includes(telegramUserId) ||
    isAdminUser(telegramUserId)
  );
}

export function getPlanLimit(plan: string): number {
  return PLAN_LIMITS[plan as Plan] ?? PLAN_LIMITS.free;
}

// The plan as it should be applied right now: an expired paid plan counts as
// free even before consumeDailyMessage persists the downgrade to the DB.
// planExpiresAt = null means no expiry (free plan or admin-granted).
export function getEffectivePlan(chat: {
  plan: string;
  planExpiresAt: Date | null;
}): string {
  if (
    chat.plan !== "free" &&
    chat.planExpiresAt &&
    chat.planExpiresAt < new Date()
  ) {
    return "free";
  }
  return chat.plan;
}

// Returns the start of today in UTC, adjusted so that "day boundary" is midnight UTC+3
export function getTodayStartUTC3(): Date {
  const utc3OffsetMs = 3 * 60 * 60 * 1000;
  const nowUTC3 = new Date(Date.now() + utc3OffsetMs);
  nowUTC3.setUTCHours(0, 0, 0, 0);
  return new Date(nowUTC3.getTime() - utc3OffsetMs);
}

export function isNewDay(resetAt: Date): boolean {
  return resetAt < getTodayStartUTC3();
}
