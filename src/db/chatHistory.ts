import { prisma } from "./prisma.js";
import type { Chat, Message } from "@prisma/client";
import { isAdminUser, getPlanLimit, isNewDay } from "../subscription/plans.js";
import { pickRandomTheme } from "../conversation/themes.js";

export type { Chat, Message };

export async function getOrCreateChat(
  telegramChatId: string,
  defaultTheme: string
): Promise<Chat> {
  return prisma.chat.upsert({
    where: { telegramChatId },
    update: {},
    create: { telegramChatId, currentTheme: defaultTheme, themeReplyCount: 0 },
  });
}

export async function saveMessage(
  chatId: string,
  role: "user" | "assistant",
  text: string,
  llmJson?: string
): Promise<Message> {
  return prisma.message.create({
    data: { chatId, role, text, llmJson },
  });
}

export async function getRecentMessages(
  chatId: string,
  limit = 15
): Promise<Message[]> {
  const messages = await prisma.message.findMany({
    where: { chatId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return messages.reverse();
}

export async function updateChatTheme(
  chatId: string,
  theme: string,
  count: number
): Promise<Chat> {
  return prisma.chat.update({
    where: { id: chatId },
    data: { currentTheme: theme, themeReplyCount: count },
  });
}

export async function checkAndMaybeReset(
  chat: Chat,
  telegramUserId: string | undefined
): Promise<{ allowed: boolean; chat: Chat }> {
  if (telegramUserId && isAdminUser(telegramUserId)) {
    return { allowed: true, chat };
  }

  let current = chat;

  // Paid plan expired (Stars subscription cancelled or renewal failed) → free.
  // planExpiresAt = null means no expiry (free plan or admin-granted via /setplan).
  if (
    current.plan !== "free" &&
    current.planExpiresAt &&
    current.planExpiresAt < new Date()
  ) {
    current = await prisma.chat.update({
      where: { id: current.id },
      data: { plan: "free", planExpiresAt: null },
    });
  }

  if (isNewDay(current.dailyResetAt)) {
    current = await prisma.chat.update({
      where: { id: current.id },
      data: { dailyMessageCount: 0, dailyResetAt: new Date() },
    });
  }

  const limit = getPlanLimit(current.plan);
  return { allowed: current.dailyMessageCount < limit, chat: current };
}

export async function incrementDailyCount(chatId: string): Promise<void> {
  await prisma.chat.update({
    where: { id: chatId },
    data: { dailyMessageCount: { increment: 1 } },
  });
}

export async function updateChatMode(chatId: string, mode: string): Promise<Chat> {
  return prisma.chat.update({
    where: { id: chatId },
    data: { mode },
  });
}

export async function updateChatThemeAndLock(
  chatId: string,
  theme: string,
  count: number,
  lock: boolean,
): Promise<Chat> {
  return prisma.chat.update({
    where: { id: chatId },
    data: { currentTheme: theme, themeReplyCount: count, lockTheme: lock },
  });
}

export async function upgradeChatPlan(
  telegramChatId: string,
  plan: string,
  expiresAt: Date | null = null
): Promise<Chat> {
  // Upsert: a deep-link payment can arrive before the user has ever
  // started a dialogue, so the Chat row may not exist yet.
  return prisma.chat.upsert({
    where: { telegramChatId },
    update: { plan, planExpiresAt: expiresAt },
    create: {
      telegramChatId,
      currentTheme: pickRandomTheme(),
      themeReplyCount: 0,
      plan,
      planExpiresAt: expiresAt,
    },
  });
}

export async function resetChat(
  telegramChatId: string,
  newTheme: string
): Promise<Chat> {
  const chat = await prisma.chat.findUnique({ where: { telegramChatId } });
  if (chat) {
    await prisma.message.deleteMany({ where: { chatId: chat.id } });
    return prisma.chat.update({
      where: { id: chat.id },
      data: { currentTheme: newTheme, themeReplyCount: 0 },
    });
  }
  return prisma.chat.create({
    data: { telegramChatId, currentTheme: newTheme, themeReplyCount: 0 },
  });
}
