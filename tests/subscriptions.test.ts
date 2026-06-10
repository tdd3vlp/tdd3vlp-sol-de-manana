import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/config/env.js", () => ({
  config: {
    telegramBotToken: "test-token",
    openaiApiKey: "test-key",
    openaiModel: "gpt-4o",
    databaseUrl: "postgresql://test",
    nodeEnv: "test",
    webappUrl: "",
    adminTelegramIds: ["999"],
  },
}));

vi.mock("../src/db/prisma.js", () => ({
  prisma: {
    chat: { update: vi.fn(), updateMany: vi.fn() },
  },
}));

import { prisma } from "../src/db/prisma.js";
import {
  PLAN_LIMITS,
  isAdminUser,
  getPlanLimit,
  getTodayStartUTC3,
  isNewDay,
} from "../src/subscription/plans.js";
import { consumeDailyMessage, refundDailyMessage } from "../src/db/chatHistory.js";
import { makeChat } from "../src/testing/fixtures.js";

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the conditional increment succeeds (under the limit)
  vi.mocked(prisma.chat.updateMany).mockResolvedValue({ count: 1 });
});

// ── Plan limits ───────────────────────────────────────────────────────────────

describe("PLAN_LIMITS", () => {
  it("free plan has 10 messages", () => {
    expect(PLAN_LIMITS.free).toBe(10);
  });
  it("basic plan has 100 messages", () => {
    expect(PLAN_LIMITS.basic).toBe(100);
  });
  it("premium plan has 300 messages", () => {
    expect(PLAN_LIMITS.premium).toBe(300);
  });
});

describe("getPlanLimit", () => {
  it("returns correct limit for known plans", () => {
    expect(getPlanLimit("free")).toBe(10);
    expect(getPlanLimit("basic")).toBe(100);
    expect(getPlanLimit("premium")).toBe(300);
  });

  it("falls back to free limit for unknown plan", () => {
    expect(getPlanLimit("unknown")).toBe(10);
  });
});

// ── Admin bypass ──────────────────────────────────────────────────────────────

describe("isAdminUser", () => {
  it("returns true for admin ID in config", () => {
    expect(isAdminUser("999")).toBe(true);
  });

  it("returns false for non-admin ID", () => {
    expect(isAdminUser("12345")).toBe(false);
  });
});

// ── Daily reset logic ─────────────────────────────────────────────────────────

describe("getTodayStartUTC3", () => {
  it("returns a date in the past (start of current day)", () => {
    const start = getTodayStartUTC3();
    expect(start.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("returns midnight UTC-equivalent for UTC+3 day", () => {
    const start = getTodayStartUTC3();
    // The timestamp mod 86400000 should equal (24 - 3) hours in ms when UTC+3 day starts
    const utc3Ms = 3 * 60 * 60 * 1000;
    const adjusted = new Date(start.getTime() + utc3Ms);
    expect(adjusted.getUTCHours()).toBe(0);
    expect(adjusted.getUTCMinutes()).toBe(0);
  });
});

describe("isNewDay", () => {
  it("returns true when resetAt is before today's start", () => {
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000);
    expect(isNewDay(yesterday)).toBe(true);
  });

  it("returns false when resetAt is today (just now)", () => {
    expect(isNewDay(new Date())).toBe(false);
  });
});

// ── consumeDailyMessage ───────────────────────────────────────────────────────

describe("consumeDailyMessage", () => {
  it("consumes atomically with a conditional increment under the plan limit", async () => {
    const chat = makeChat({ plan: "free", dailyMessageCount: 5, dailyResetAt: new Date() });
    const result = await consumeDailyMessage(chat, "12345");

    expect(prisma.chat.updateMany).toHaveBeenCalledWith({
      where: { id: chat.id, dailyMessageCount: { lt: 10 } },
      data: { dailyMessageCount: { increment: 1 } },
    });
    expect(result.allowed).toBe(true);
    expect(result.consumed).toBe(true);
    expect(result.chat.dailyMessageCount).toBe(6);
  });

  it("blocks when the conditional increment matches no row (limit reached)", async () => {
    vi.mocked(prisma.chat.updateMany).mockResolvedValue({ count: 0 });
    const chat = makeChat({ plan: "free", dailyMessageCount: 10, dailyResetAt: new Date() });

    const result = await consumeDailyMessage(chat, "12345");

    expect(result.allowed).toBe(false);
    expect(result.consumed).toBe(false);
  });

  it("uses the basic plan limit in the increment condition", async () => {
    const chat = makeChat({ plan: "basic", dailyMessageCount: 50, dailyResetAt: new Date() });
    await consumeDailyMessage(chat, "12345");
    expect(prisma.chat.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ dailyMessageCount: { lt: 100 } }),
      })
    );
  });

  it("allows admin user without touching the counter", async () => {
    const chat = makeChat({ plan: "free", dailyMessageCount: 999, dailyResetAt: new Date() });
    const result = await consumeDailyMessage(chat, "999");
    expect(result.allowed).toBe(true);
    expect(result.consumed).toBe(false);
    expect(prisma.chat.update).not.toHaveBeenCalled();
    expect(prisma.chat.updateMany).not.toHaveBeenCalled();
  });

  it("resets counter when resetAt is from a previous day", async () => {
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const chat = makeChat({ plan: "free", dailyMessageCount: 10, dailyResetAt: yesterday });
    vi.mocked(prisma.chat.update).mockResolvedValue({
      ...chat,
      dailyMessageCount: 0,
      dailyResetAt: new Date(),
    });

    const result = await consumeDailyMessage(chat, "12345");

    expect(prisma.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ dailyMessageCount: 0 }),
      })
    );
    expect(result.allowed).toBe(true);
    expect(result.chat.dailyMessageCount).toBe(1);
  });

  it("does not reset when resetAt is today", async () => {
    const chat = makeChat({ plan: "free", dailyMessageCount: 3, dailyResetAt: new Date() });
    await consumeDailyMessage(chat, "12345");
    expect(prisma.chat.update).not.toHaveBeenCalled();
  });

  it("downgrades to free when paid plan has expired", async () => {
    const expired = new Date(Date.now() - 60 * 60 * 1000);
    const chat = makeChat({
      plan: "basic",
      planExpiresAt: expired,
      dailyMessageCount: 50,
      dailyResetAt: new Date(),
    });
    vi.mocked(prisma.chat.update).mockResolvedValue({
      ...chat,
      plan: "free",
      planExpiresAt: null,
    });
    // 50 messages is over the free limit of 10 → conditional update matches nothing
    vi.mocked(prisma.chat.updateMany).mockResolvedValue({ count: 0 });

    const result = await consumeDailyMessage(chat, "12345");

    expect(prisma.chat.update).toHaveBeenCalledWith({
      where: { id: chat.id },
      data: { plan: "free", planExpiresAt: null },
    });
    expect(prisma.chat.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ dailyMessageCount: { lt: 10 } }),
      })
    );
    expect(result.allowed).toBe(false);
    expect(result.chat.plan).toBe("free");
  });

  it("keeps paid plan while subscription is active", async () => {
    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    const chat = makeChat({
      plan: "basic",
      planExpiresAt: future,
      dailyMessageCount: 50,
      dailyResetAt: new Date(),
    });

    const result = await consumeDailyMessage(chat, "12345");

    expect(prisma.chat.update).not.toHaveBeenCalled();
    expect(result.allowed).toBe(true);
  });

  it("treats null planExpiresAt as non-expiring (admin-granted plan)", async () => {
    const chat = makeChat({
      plan: "premium",
      planExpiresAt: null,
      dailyMessageCount: 200,
      dailyResetAt: new Date(),
    });

    const result = await consumeDailyMessage(chat, "12345");

    expect(prisma.chat.update).not.toHaveBeenCalled();
    expect(result.allowed).toBe(true);
  });
});

// ── refundDailyMessage ────────────────────────────────────────────────────────

describe("refundDailyMessage", () => {
  it("decrements the counter only when it is above zero", async () => {
    await refundDailyMessage("chat-1");
    expect(prisma.chat.updateMany).toHaveBeenCalledWith({
      where: { id: "chat-1", dailyMessageCount: { gt: 0 } },
      data: { dailyMessageCount: { decrement: 1 } },
    });
  });
});
