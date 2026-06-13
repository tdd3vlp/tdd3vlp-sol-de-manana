import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/db/prisma.js", () => ({
  prisma: {
    chat: {
      updateMany: vi.fn(),
      update: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    practiceSession: {
      upsert: vi.fn(),
    },
  },
}));

vi.mock("../src/config/env.js", () => ({
  config: {
    adminTelegramIds: ["admin-1"],
    betaTelegramIds: ["beta-1"],
    openaiModelFree: "gpt-4o-mini",
    openaiModelPaid: "gpt-4o",
    openaiModelTranslate: "gpt-4o-mini",
    openaiModelDialogue: "gpt-4o-mini",
    openaiModelHighlights: "gpt-4o-mini",
    openaiModelPremiumHighlights: "gpt-4o",
    telegramBotToken: "test-token",
    nodeEnv: "test",
  },
}));

import { prisma } from "../src/db/prisma.js";
import {
  resetDailyPracticeIfNewDay,
  incrementDailySentenceCount,
  markDailyPracticeCompleted,
} from "../src/db/practiceSession.js";
import { makeChat } from "../src/testing/fixtures.js";

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── resetDailyPracticeIfNewDay ────────────────────────────────────────────────

describe("resetDailyPracticeIfNewDay", () => {
  it("calls updateMany with correct where clause", async () => {
    const freshChat = makeChat({ dailyPracticeSentenceCount: 0 });
    vi.mocked(prisma.chat.updateMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.chat.findUniqueOrThrow).mockResolvedValue(freshChat);

    await resetDailyPracticeIfNewDay("chat-1");

    expect(prisma.chat.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "chat-1" }),
        data: expect.objectContaining({
          dailyPracticeSentenceCount: 0,
          dailyPracticeCompletedAt: null,
        }),
      }),
    );
  });

  it("returns fresh chat from findUniqueOrThrow", async () => {
    const freshChat = makeChat({ dailyPracticeSentenceCount: 0 });
    vi.mocked(prisma.chat.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(prisma.chat.findUniqueOrThrow).mockResolvedValue(freshChat);

    const result = await resetDailyPracticeIfNewDay("chat-1");
    expect(result).toEqual(freshChat);
  });
});

// ─── incrementDailySentenceCount ──────────────────────────────────────────────

describe("incrementDailySentenceCount", () => {
  it("increments by the given delta", async () => {
    const updatedChat = makeChat({ dailyPracticeSentenceCount: 5 });
    vi.mocked(prisma.chat.update).mockResolvedValue(updatedChat);

    await incrementDailySentenceCount("chat-1", 3);

    expect(prisma.chat.update).toHaveBeenCalledWith({
      where: { id: "chat-1" },
      data: { dailyPracticeSentenceCount: { increment: 3 } },
    });
  });

  it("returns updated chat", async () => {
    const updatedChat = makeChat({ dailyPracticeSentenceCount: 7 });
    vi.mocked(prisma.chat.update).mockResolvedValue(updatedChat);

    const result = await incrementDailySentenceCount("chat-1", 2);
    expect(result.dailyPracticeSentenceCount).toBe(7);
  });
});

// ─── markDailyPracticeCompleted ───────────────────────────────────────────────

describe("markDailyPracticeCompleted", () => {
  it("returns marked=true when updateMany affected a row", async () => {
    vi.mocked(prisma.chat.updateMany).mockResolvedValue({ count: 1 });

    const result = await markDailyPracticeCompleted("chat-1");
    expect(result.marked).toBe(true);
  });

  it("returns marked=false when no row was updated (idempotency)", async () => {
    vi.mocked(prisma.chat.updateMany).mockResolvedValue({ count: 0 });

    const result = await markDailyPracticeCompleted("chat-1");
    expect(result.marked).toBe(false);
  });

  it("calls updateMany with dailyPracticeCompletedAt: null guard", async () => {
    vi.mocked(prisma.chat.updateMany).mockResolvedValue({ count: 1 });

    await markDailyPracticeCompleted("chat-1");

    expect(prisma.chat.updateMany).toHaveBeenCalledWith({
      where: { id: "chat-1", dailyPracticeCompletedAt: null },
      data: { dailyPracticeCompletedAt: expect.any(Date) },
    });
  });
});
