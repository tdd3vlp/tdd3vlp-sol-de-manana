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
    chat: { update: vi.fn() },
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
import { checkAndMaybeReset, incrementDailyCount } from "../src/db/chatHistory.js";
import { makeChat } from "../src/testing/fixtures.js";

beforeEach(() => vi.clearAllMocks());

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

// ── checkAndMaybeReset ────────────────────────────────────────────────────────

describe("checkAndMaybeReset", () => {
  it("allows message when count is below limit", async () => {
    const chat = makeChat({ plan: "free", dailyMessageCount: 5, dailyResetAt: new Date() });
    const result = await checkAndMaybeReset(chat, "12345");
    expect(result.allowed).toBe(true);
  });

  it("blocks message when count equals limit", async () => {
    const chat = makeChat({ plan: "free", dailyMessageCount: 10, dailyResetAt: new Date() });
    const result = await checkAndMaybeReset(chat, "12345");
    expect(result.allowed).toBe(false);
  });

  it("blocks at 101 for basic plan", async () => {
    const chat = makeChat({ plan: "basic", dailyMessageCount: 100, dailyResetAt: new Date() });
    const result = await checkAndMaybeReset(chat, "12345");
    expect(result.allowed).toBe(false);
  });

  it("allows admin user even when over limit", async () => {
    const chat = makeChat({ plan: "free", dailyMessageCount: 999, dailyResetAt: new Date() });
    const result = await checkAndMaybeReset(chat, "999");
    expect(result.allowed).toBe(true);
    expect(prisma.chat.update).not.toHaveBeenCalled();
  });

  it("resets counter when resetAt is from a previous day", async () => {
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const chat = makeChat({ plan: "free", dailyMessageCount: 10, dailyResetAt: yesterday });
    vi.mocked(prisma.chat.update).mockResolvedValue({
      ...chat,
      dailyMessageCount: 0,
      dailyResetAt: new Date(),
    });

    const result = await checkAndMaybeReset(chat, "12345");

    expect(prisma.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ dailyMessageCount: 0 }),
      })
    );
    expect(result.allowed).toBe(true);
    expect(result.chat.dailyMessageCount).toBe(0);
  });

  it("does not reset when resetAt is today", async () => {
    const chat = makeChat({ plan: "free", dailyMessageCount: 3, dailyResetAt: new Date() });
    await checkAndMaybeReset(chat, "12345");
    expect(prisma.chat.update).not.toHaveBeenCalled();
  });
});

// ── incrementDailyCount ───────────────────────────────────────────────────────

describe("incrementDailyCount", () => {
  it("calls prisma.chat.update with increment: 1", async () => {
    vi.mocked(prisma.chat.update).mockResolvedValue(makeChat());
    await incrementDailyCount("chat-1");
    expect(prisma.chat.update).toHaveBeenCalledWith({
      where: { id: "chat-1" },
      data: { dailyMessageCount: { increment: 1 } },
    });
  });
});
