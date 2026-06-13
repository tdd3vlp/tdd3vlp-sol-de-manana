import { prisma } from "./prisma.js";
import type { Chat, PracticeSession } from "@prisma/client";
import { CHALLENGE_DAY_LABELS, CHALLENGE_THEMES } from "../conversation/challengeThemes.js";

export type { PracticeSession };

// ─── Date helpers ─────────────────────────────────────────────────────────────

// All date strings use UTC+3 (Moscow) midnight as the day boundary,
// matching consumeDailyMessage in chatHistory.ts.
const UTC3_OFFSET_MS = 3 * 60 * 60 * 1000;

function toUTC3Date(date: Date = new Date()): Date {
  const d = new Date(date.getTime() + UTC3_OFFSET_MS);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

export function getTodayDateStringUTC3(now: Date = new Date()): string {
  return formatDate(toUTC3Date(now));
}

export function getYesterdayDateStringUTC3(now: Date = new Date()): string {
  const d = toUTC3Date(now);
  d.setUTCDate(d.getUTCDate() - 1);
  return formatDate(d);
}

export function getWeekStartDateUTC3(now: Date = new Date()): string {
  const d = toUTC3Date(now);
  // ISO week: Monday = 1, Sunday = 0. Shift so Monday is 0.
  const dayOfWeek = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dayOfWeek);
  return formatDate(d);
}

// ─── Session queries ───────────────────────────────────────────────────────────

export async function getTodaySession(chatId: string): Promise<PracticeSession | null> {
  const today = getTodayDateStringUTC3();
  return prisma.practiceSession.findUnique({
    where: { chatId_date: { chatId, date: today } },
  });
}

export async function createTodaySession(
  chatId: string,
  dayNumber: number,
  theme: string,
): Promise<PracticeSession> {
  const today = getTodayDateStringUTC3();
  return prisma.practiceSession.create({
    data: { chatId, date: today, dayNumber, theme, stepCount: 0, status: "active" },
  });
}

export async function incrementStep(sessionId: string): Promise<PracticeSession> {
  return prisma.practiceSession.update({
    where: { id: sessionId },
    data: { stepCount: { increment: 1 } },
  });
}

export async function decrementStep(sessionId: string): Promise<PracticeSession> {
  return prisma.practiceSession.update({
    where: { id: sessionId },
    data: { stepCount: { decrement: 1 } },
  });
}

export interface PracticeHighlights {
  topic: string;
  subtopics: string[];
  whatWentWell: string;
  focusArea: string;
  encouragement: string;
}

export async function completeSession(
  sessionId: string,
  highlights: PracticeHighlights,
): Promise<PracticeSession> {
  return prisma.practiceSession.update({
    where: { id: sessionId },
    data: {
      status: "completed",
      completedAt: new Date(),
      highlights: JSON.stringify(highlights),
    },
  });
}

// ─── Auto daily-practice tracking (dialogue mode) ─────────────────────────────

export async function resetDailyPracticeIfNewDay(
  chatId: string,
  now: Date = new Date(),
): Promise<Chat> {
  const todayStart = toUTC3Date(now);
  // Only reset if the stored resetAt is before today's UTC+3 midnight.
  await prisma.chat.updateMany({
    where: {
      id: chatId,
      OR: [
        { dailyPracticeResetAt: null },
        { dailyPracticeResetAt: { lt: todayStart } },
      ],
    },
    data: {
      dailyPracticeSentenceCount: 0,
      dailyPracticeCompletedAt: null,
      dailyPracticeResetAt: todayStart,
    },
  });
  return prisma.chat.findUniqueOrThrow({ where: { id: chatId } });
}

export async function incrementDailySentenceCount(
  chatId: string,
  delta: number,
): Promise<Chat> {
  return prisma.chat.update({
    where: { id: chatId },
    data: { dailyPracticeSentenceCount: { increment: delta } },
  });
}

export async function markDailyPracticeCompleted(
  chatId: string,
): Promise<{ marked: boolean }> {
  const result = await prisma.chat.updateMany({
    where: { id: chatId, dailyPracticeCompletedAt: null },
    data: { dailyPracticeCompletedAt: new Date() },
  });
  return { marked: result.count > 0 };
}

// ─── Streak & weekly progress ─────────────────────────────────────────────────

export async function updateStreakAndWeekly(
  chat: Chat,
  chatId: string,
  now: Date = new Date(),
): Promise<void> {
  const today = getTodayDateStringUTC3(now);
  if (chat.lastStreakDate === today) return; // already counted today

  const yesterday = getYesterdayDateStringUTC3(now);
  const newStreak = chat.lastStreakDate === yesterday ? chat.streakCount + 1 : 1;
  const newChallengeCount =
    newStreak % 7 === 0
      ? chat.challengeCompletedCount + 1
      : chat.challengeCompletedCount;

  const weekStart = getWeekStartDateUTC3(now);
  const storedWeekStart = chat.weeklyResetAt
    ? formatDate(toUTC3Date(chat.weeklyResetAt))
    : null;

  let activeDates: string[];
  if (storedWeekStart === weekStart) {
    activeDates = JSON.parse(chat.weeklyActiveDates) as string[];
    if (!activeDates.includes(today)) activeDates.push(today);
  } else {
    activeDates = [today];
  }

  // Parse weekStart back to a Date at UTC+3 midnight → store as UTC
  const weekStartDateUTC = new Date(
    new Date(weekStart + "T00:00:00Z").getTime() - UTC3_OFFSET_MS,
  );

  await prisma.chat.update({
    where: { id: chatId },
    data: {
      streakCount: newStreak,
      lastStreakDate: today,
      weeklyActiveDates: JSON.stringify(activeDates),
      weeklyResetAt: weekStartDateUTC,
      challengeCompletedCount: newChallengeCount,
    },
  });
}

// ─── Challenge day ─────────────────────────────────────────────────────────────

// Returns which day (1-7) the user should practice next.
// Based on current streakCount: after N completed days, the next is day N%7+1.
export function computeDayNumber(chat: Chat): number {
  return (chat.streakCount % 7) + 1;
}

// ─── Progress state for Mini App ──────────────────────────────────────────────

export interface ProgressState {
  streak: number;
  challengeCompletedCount: number;
  currentDayNumber: number;
  weeklyActiveDates: string[];
  today: {
    status: "none" | "active" | "completed";
    dayNumber: number;
    dayLabel: string;
    sentenceCount: number;
    highlights?: PracticeHighlights;
  };
}

export function getProgressState(
  chat: Chat,
  todaySession: PracticeSession | null,
): ProgressState {
  const dayNumber = computeDayNumber(chat);
  let todayStatus: "none" | "active" | "completed" = "none";
  let highlights: PracticeHighlights | undefined;

  const today = getTodayDateStringUTC3();
  const autoCompletedToday =
    chat.dailyPracticeCompletedAt !== null &&
    getTodayDateStringUTC3(chat.dailyPracticeCompletedAt) === today;

  if (todaySession?.status === "completed") {
    todayStatus = "completed";
    if (todaySession.highlights) {
      try {
        highlights = JSON.parse(todaySession.highlights) as PracticeHighlights;
      } catch {
        // ignore malformed JSON
      }
    }
  } else if (autoCompletedToday) {
    // Auto-completed via dialogue; highlights appear once background upsert finishes.
    todayStatus = "completed";
    if (todaySession?.highlights) {
      try {
        highlights = JSON.parse(todaySession.highlights) as PracticeHighlights;
      } catch {
        // ignore malformed JSON
      }
    }
  } else if (chat.dailyPracticeSentenceCount > 0) {
    todayStatus = "active";
  } else if (todaySession?.status === "active") {
    todayStatus = "active";
  }

  return {
    streak: chat.streakCount,
    challengeCompletedCount: chat.challengeCompletedCount,
    currentDayNumber: dayNumber,
    weeklyActiveDates: JSON.parse(chat.weeklyActiveDates) as string[],
    today: {
      status: todayStatus,
      dayNumber: todaySession?.dayNumber ?? dayNumber,
      dayLabel:
        CHALLENGE_DAY_LABELS[todaySession?.dayNumber ?? dayNumber] ??
        `День ${todaySession?.dayNumber ?? dayNumber}`,
      sentenceCount: chat.dailyPracticeSentenceCount,
      highlights,
    },
  };
}

export function getThemeForDay(dayNumber: number): string {
  return CHALLENGE_THEMES[dayNumber] ?? CHALLENGE_THEMES[7];
}
