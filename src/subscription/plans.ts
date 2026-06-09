import { config } from "../config/env.js";

export const PLAN_LIMITS = {
  free: 10,
  basic: 100,
  premium: 300,
} as const;

export type Plan = keyof typeof PLAN_LIMITS;

export const PLAN_PRICES_STARS: Record<Exclude<Plan, "free">, number> = {
  basic: 150,
  premium: 500,
};

export function isAdminUser(telegramUserId: string): boolean {
  return config.adminTelegramIds.includes(telegramUserId);
}

export function getPlanLimit(plan: string): number {
  return PLAN_LIMITS[plan as Plan] ?? PLAN_LIMITS.free;
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
