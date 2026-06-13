import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/db/prisma.js", () => ({
  prisma: {
    practiceSession: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    chat: {
      update: vi.fn(),
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
    telegramBotToken: "test-token",
    nodeEnv: "test",
  },
}));

import { prisma } from "../src/db/prisma.js";
import {
  getTodayDateStringUTC3,
  getYesterdayDateStringUTC3,
  getWeekStartDateUTC3,
  getTodaySession,
  createTodaySession,
  decrementStep,
  updateStreakAndWeekly,
  computeDayNumber,
  getProgressState,
} from "../src/db/practiceSession.js";
import { isBetaUser, isAdminUser } from "../src/subscription/plans.js";
import { buildDialogueKeyboard } from "../src/bot/handlers.js";
import { makeChat } from "../src/testing/fixtures.js";

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Date helpers ─────────────────────────────────────────────────────────────

describe("getTodayDateStringUTC3", () => {
  it("returns YYYY-MM-DD format", () => {
    const result = getTodayDateStringUTC3();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("uses UTC+3 offset", () => {
    // 23:00 UTC = 02:00 UTC+3 next day
    const utc23 = new Date("2026-06-12T23:00:00Z");
    expect(getTodayDateStringUTC3(utc23)).toBe("2026-06-13");

    // 22:59 UTC = 01:59 UTC+3 (still next day)
    const utc2259 = new Date("2026-06-12T22:59:00Z");
    expect(getTodayDateStringUTC3(utc2259)).toBe("2026-06-13");

    // 20:59 UTC = 23:59 UTC+3 (same day)
    const utc2059 = new Date("2026-06-12T20:59:00Z");
    expect(getTodayDateStringUTC3(utc2059)).toBe("2026-06-12");
  });
});

describe("getYesterdayDateStringUTC3", () => {
  it("returns the day before today in UTC+3", () => {
    const today = new Date("2026-06-13T10:00:00Z");
    expect(getYesterdayDateStringUTC3(today)).toBe("2026-06-12");
  });
});

describe("getWeekStartDateUTC3", () => {
  it("returns the Monday of the current ISO week", () => {
    // 2026-06-13 is a Saturday
    const sat = new Date("2026-06-13T10:00:00Z");
    expect(getWeekStartDateUTC3(sat)).toBe("2026-06-08");

    // 2026-06-08 is a Monday
    const mon = new Date("2026-06-08T10:00:00Z");
    expect(getWeekStartDateUTC3(mon)).toBe("2026-06-08");
  });
});

// ─── Beta gating ──────────────────────────────────────────────────────────────

describe("isBetaUser", () => {
  it("returns true for a user in betaTelegramIds", () => {
    expect(isBetaUser("beta-1")).toBe(true);
  });

  it("returns true for admin users (admin is always beta)", () => {
    expect(isBetaUser("admin-1")).toBe(true);
  });

  it("returns false for regular users", () => {
    expect(isBetaUser("regular-user-999")).toBe(false);
  });
});

describe("buildDialogueKeyboard", () => {
  function buttonTexts(kb: ReturnType<typeof buildDialogueKeyboard>): string[] {
    return kb.keyboard.flat().map((b) => (typeof b === "string" ? b : (b as { text: string }).text));
  }

  it("never includes Практика дня button (removed from keyboard)", () => {
    expect(buttonTexts(buildDialogueKeyboard("free", "beta-1"))).not.toContain("Практика дня");
    expect(buttonTexts(buildDialogueKeyboard("free", "admin-1"))).not.toContain("Практика дня");
    expect(buttonTexts(buildDialogueKeyboard("free", "regular-999"))).not.toContain("Практика дня");
    expect(buttonTexts(buildDialogueKeyboard("premium", undefined))).not.toContain("Практика дня");
  });
});

// ─── Session queries ───────────────────────────────────────────────────────────

describe("getTodaySession", () => {
  it("queries by chatId and today's date", async () => {
    const today = getTodayDateStringUTC3();
    vi.mocked(prisma.practiceSession.findUnique).mockResolvedValue(null);

    await getTodaySession("chat-1");

    expect(prisma.practiceSession.findUnique).toHaveBeenCalledWith({
      where: { chatId_date: { chatId: "chat-1", date: today } },
    });
  });

  it("returns null if no session today", async () => {
    vi.mocked(prisma.practiceSession.findUnique).mockResolvedValue(null);
    const result = await getTodaySession("chat-1");
    expect(result).toBeNull();
  });
});

describe("createTodaySession", () => {
  it("creates a session with today's date, dayNumber, and theme", async () => {
    const today = getTodayDateStringUTC3();
    const mockSession = {
      id: "sess-1",
      chatId: "chat-1",
      date: today,
      dayNumber: 3,
      theme: "supermarket",
      stepCount: 0,
      status: "active",
      highlights: null,
      startedAt: new Date(),
      completedAt: null,
    };
    vi.mocked(prisma.practiceSession.create).mockResolvedValue(mockSession);

    await createTodaySession("chat-1", 3, "supermarket");

    expect(prisma.practiceSession.create).toHaveBeenCalledWith({
      data: {
        chatId: "chat-1",
        date: today,
        dayNumber: 3,
        theme: "supermarket",
        stepCount: 0,
        status: "active",
      },
    });
  });
});

describe("decrementStep", () => {
  it("decrements the practice session step count", async () => {
    const mockSession = {
      id: "sess-1",
      chatId: "chat-1",
      date: getTodayDateStringUTC3(),
      dayNumber: 1,
      theme: "family and introductions",
      stepCount: 2,
      status: "active",
      highlights: null,
      startedAt: new Date(),
      completedAt: null,
    };
    vi.mocked(prisma.practiceSession.update).mockResolvedValue(mockSession);

    await decrementStep("sess-1");

    expect(prisma.practiceSession.update).toHaveBeenCalledWith({
      where: { id: "sess-1" },
      data: { stepCount: { decrement: 1 } },
    });
  });
});

// ─── Streak logic ─────────────────────────────────────────────────────────────

describe("updateStreakAndWeekly", () => {
  const now = new Date("2026-06-13T10:00:00Z"); // 2026-06-13 in UTC+3
  const today = "2026-06-13";
  const yesterday = "2026-06-12";

  it("increments streak on consecutive days", async () => {
    const chat = makeChat({ streakCount: 3, lastStreakDate: yesterday, challengeCompletedCount: 0, weeklyActiveDates: "[]", weeklyResetAt: null });
    vi.mocked(prisma.chat.update).mockResolvedValue({ ...chat, streakCount: 4 });

    await updateStreakAndWeekly(chat, "chat-1", now);

    expect(prisma.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ streakCount: 4, lastStreakDate: today }),
      }),
    );
  });

  it("resets streak to 1 when a day was skipped", async () => {
    // lastStreakDate is 2 days ago, not yesterday
    const twoDaysAgo = "2026-06-11";
    const chat = makeChat({ streakCount: 5, lastStreakDate: twoDaysAgo, challengeCompletedCount: 0, weeklyActiveDates: "[]", weeklyResetAt: null });
    vi.mocked(prisma.chat.update).mockResolvedValue({ ...chat, streakCount: 1 });

    await updateStreakAndWeekly(chat, "chat-1", now);

    expect(prisma.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ streakCount: 1, lastStreakDate: today }),
      }),
    );
  });

  it("does not increment streak if already counted today", async () => {
    const chat = makeChat({ streakCount: 3, lastStreakDate: today });
    await updateStreakAndWeekly(chat, "chat-1", now);
    expect(prisma.chat.update).not.toHaveBeenCalled();
  });

  it("increments challengeCompletedCount when streak reaches 7", async () => {
    const chat = makeChat({ streakCount: 6, lastStreakDate: yesterday, challengeCompletedCount: 0, weeklyActiveDates: "[]", weeklyResetAt: null });
    vi.mocked(prisma.chat.update).mockResolvedValue({ ...chat, streakCount: 7, challengeCompletedCount: 1 });

    await updateStreakAndWeekly(chat, "chat-1", now);

    expect(prisma.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ streakCount: 7, challengeCompletedCount: 1 }),
      }),
    );
  });

  it("does not increment challenge count at non-multiple-of-7 streaks", async () => {
    const chat = makeChat({ streakCount: 3, lastStreakDate: yesterday, challengeCompletedCount: 1, weeklyActiveDates: "[]", weeklyResetAt: null });
    vi.mocked(prisma.chat.update).mockResolvedValue({ ...chat, streakCount: 4 });

    await updateStreakAndWeekly(chat, "chat-1", now);

    expect(prisma.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ challengeCompletedCount: 1 }),
      }),
    );
  });

  it("adds today's date to weeklyActiveDates", async () => {
    const weekStart = "2026-06-08"; // Monday
    const weekStartDate = new Date("2026-06-08T00:00:00Z");
    const chat = makeChat({
      streakCount: 1,
      lastStreakDate: yesterday,
      weeklyActiveDates: JSON.stringify(["2026-06-12"]),
      weeklyResetAt: new Date(weekStartDate.getTime() - 3 * 60 * 60 * 1000),
    });
    vi.mocked(prisma.chat.update).mockResolvedValue(chat);

    await updateStreakAndWeekly(chat, "chat-1", now);

    const call = vi.mocked(prisma.chat.update).mock.calls[0][0];
    const dates = JSON.parse((call.data as Record<string, string>).weeklyActiveDates);
    expect(dates).toContain(today);
    expect(dates).toContain("2026-06-12");
  });

  it("resets weeklyActiveDates when a new week starts", async () => {
    // weeklyResetAt is set to previous week's Monday
    const prevMonday = new Date("2026-06-01T21:00:00Z"); // 2026-06-02 00:00 UTC+3
    const chat = makeChat({
      streakCount: 1,
      lastStreakDate: yesterday,
      weeklyActiveDates: JSON.stringify(["2026-06-05", "2026-06-06"]),
      weeklyResetAt: prevMonday,
    });
    vi.mocked(prisma.chat.update).mockResolvedValue(chat);

    await updateStreakAndWeekly(chat, "chat-1", now);

    const call = vi.mocked(prisma.chat.update).mock.calls[0][0];
    const dates = JSON.parse((call.data as Record<string, string>).weeklyActiveDates);
    expect(dates).toEqual([today]);
  });
});

// ─── Challenge day computation ─────────────────────────────────────────────────

describe("computeDayNumber", () => {
  it("returns 1 when streakCount is 0 (no streak)", () => {
    const chat = makeChat({ streakCount: 0 });
    expect(computeDayNumber(chat)).toBe(1);
  });

  it("returns 2 when streakCount is 1", () => {
    const chat = makeChat({ streakCount: 1 });
    expect(computeDayNumber(chat)).toBe(2);
  });

  it("returns 7 when streakCount is 6", () => {
    const chat = makeChat({ streakCount: 6 });
    expect(computeDayNumber(chat)).toBe(7);
  });

  it("wraps back to 1 when streakCount is 7 (new cycle)", () => {
    const chat = makeChat({ streakCount: 7 });
    expect(computeDayNumber(chat)).toBe(1);
  });

  it("handles mid-cycle correctly", () => {
    const chat = makeChat({ streakCount: 10 }); // 10 % 7 = 3, +1 = 4
    expect(computeDayNumber(chat)).toBe(4);
  });
});

// ─── Progress state ────────────────────────────────────────────────────────────

describe("getProgressState", () => {
  it("treats stale dailyPracticeResetAt as zeroed (new day before first message)", () => {
    // User completed 10 sentences yesterday; resetAt is from yesterday.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const chat = makeChat({
      dailyPracticeSentenceCount: 10,
      dailyPracticeCompletedAt: yesterday,
      dailyPracticeResetAt: yesterday,
    });
    const state = getProgressState(chat, null);

    expect(state.today.status).toBe("none");
    expect(state.today.sentenceCount).toBe(0);
  });

  it("returns zeroed state when no session today and no sentence count", () => {
    const chat = makeChat({ streakCount: 3, challengeCompletedCount: 1, weeklyActiveDates: '["2026-06-12"]' });
    const state = getProgressState(chat, null);

    expect(state.streak).toBe(3);
    expect(state.challengeCompletedCount).toBe(1);
    expect(state.today.status).toBe("none");
    expect(state.today.sentenceCount).toBe(0);
    expect(state.weeklyActiveDates).toEqual(["2026-06-12"]);
  });

  it("returns active status when sentenceCount > 0 without a PracticeSession", () => {
    // dailyPracticeResetAt must be today so data is not treated as stale
    const chat = makeChat({ streakCount: 2, dailyPracticeSentenceCount: 5, dailyPracticeResetAt: new Date() });
    const state = getProgressState(chat, null);

    expect(state.today.status).toBe("active");
    expect(state.today.sentenceCount).toBe(5);
  });

  it("returns completed status when dailyPracticeCompletedAt is today, even without a PracticeSession", () => {
    const now = new Date();
    const chat = makeChat({ dailyPracticeSentenceCount: 12, dailyPracticeCompletedAt: now, dailyPracticeResetAt: now });
    const state = getProgressState(chat, null);

    expect(state.today.status).toBe("completed");
    expect(state.today.sentenceCount).toBe(12);
  });

  it("returns active status for a legacy active session", () => {
    const chat = makeChat({ streakCount: 2, dailyPracticeSentenceCount: 0 });
    const session = {
      id: "sess-1",
      chatId: "chat-1",
      date: "2026-06-13",
      dayNumber: 3,
      theme: "supermarket",
      stepCount: 2,
      status: "active",
      highlights: null,
      startedAt: new Date(),
      completedAt: null,
    };
    const state = getProgressState(chat, session);

    expect(state.today.status).toBe("active");
    expect(state.today.dayNumber).toBe(3);
    expect(state.today.dayLabel).toBe("Супермаркет");
    expect(state.today.sentenceCount).toBe(0);
  });

  it("returns completed status and highlights for a completed session", () => {
    const chat = makeChat({ streakCount: 3, dailyPracticeSentenceCount: 8, dailyPracticeResetAt: new Date() });
    const highlights = {
      summary: "Сегодня говорили о том, как спрашивать дорогу в городе.",
      mistakes: ["написал al playa → правильно a la playa"],
      usefulPhrases: [],
      whatWentWell: "Хорошо использовал предлоги",
      focusArea: "Поработать над произношением",
      encouragement: "Отлично!",
    };
    const session = {
      id: "sess-1",
      chatId: "chat-1",
      date: "2026-06-13",
      dayNumber: 4,
      theme: "asking for directions",
      stepCount: 8,
      status: "completed",
      highlights: JSON.stringify(highlights),
      startedAt: new Date(),
      completedAt: new Date(),
    };
    const state = getProgressState(chat, session);

    expect(state.today.status).toBe("completed");
    expect(state.today.highlights).toEqual(highlights);
    expect(state.today.sentenceCount).toBe(8);
  });
});
