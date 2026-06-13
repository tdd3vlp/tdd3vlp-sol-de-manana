import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/db/prisma.js", () => ({
  prisma: {
    chat: {
      upsert: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
    },
    message: {
      create: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
  },
}));

import { prisma } from "../src/db/prisma.js";
import {
  getOrCreateChat,
  saveMessages,
  getRecentMessages,
  saveTurn,
  resetChat,
} from "../src/db/chatHistory.js";

const mockChat = {
  id: "chat-1",
  telegramChatId: "123",
  currentTheme: "supermarket",
  themeReplyCount: 3,
  plan: "free",
  planExpiresAt: null,
  mode: "dialogue",
  lockTheme: false,
  dailyMessageCount: 0,
  dailyResetAt: new Date(),
  customerEmail: null,
  pendingPaymentPlan: null,
  streakCount: 0,
  lastStreakDate: null,
  weeklyActiveDates: "[]",
  weeklyResetAt: null,
  challengeCompletedCount: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockMessage = {
  id: "msg-1",
  chatId: "chat-1",
  role: "user",
  text: "Hola",
  llmJson: null,
  createdAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getOrCreateChat", () => {
  it("upserts with correct data and returns chat", async () => {
    vi.mocked(prisma.chat.upsert).mockResolvedValue(mockChat);
    const result = await getOrCreateChat("123", "supermarket");
    expect(prisma.chat.upsert).toHaveBeenCalledWith({
      where: { telegramChatId: "123" },
      update: {},
      create: { telegramChatId: "123", currentTheme: "supermarket", themeReplyCount: 0 },
    });
    expect(result).toEqual(mockChat);
  });

  it("returns existing chat without modifying it", async () => {
    const existingChat = { ...mockChat, currentTheme: "cafe or restaurant" };
    vi.mocked(prisma.chat.upsert).mockResolvedValue(existingChat);
    const result = await getOrCreateChat("123", "different-theme");
    expect(result.currentTheme).toBe("cafe or restaurant");
  });
});

describe("saveMessages", () => {
  it("creates a single message with role and text", async () => {
    vi.mocked(prisma.message.create).mockResolvedValue(mockMessage);
    await saveMessages("chat-1", [{ role: "user", text: "Hola" }]);
    expect(prisma.message.create).toHaveBeenCalledWith({
      data: { chatId: "chat-1", role: "user", text: "Hola", llmJson: undefined },
    });
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });

  it("writes the user/assistant pair in one transaction", async () => {
    vi.mocked(prisma.message.create).mockResolvedValue(mockMessage);
    await saveMessages("chat-1", [
      { role: "user", text: "Hola" },
      { role: "assistant", text: "Buenas.", llmJson: "{}" },
    ]);
    expect(prisma.message.create).toHaveBeenCalledWith({
      data: { chatId: "chat-1", role: "user", text: "Hola", llmJson: undefined },
    });
    expect(prisma.message.create).toHaveBeenCalledWith({
      data: { chatId: "chat-1", role: "assistant", text: "Buenas.", llmJson: "{}" },
    });
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });
});

describe("getRecentMessages", () => {
  it("queries with limit of 15 by default", async () => {
    vi.mocked(prisma.message.findMany).mockResolvedValue([]);
    await getRecentMessages("chat-1");
    expect(prisma.message.findMany).toHaveBeenCalledWith({
      where: { chatId: "chat-1" },
      orderBy: { createdAt: "desc" },
      take: 15,
    });
  });

  it("respects custom limit", async () => {
    vi.mocked(prisma.message.findMany).mockResolvedValue([]);
    await getRecentMessages("chat-1", 5);
    expect(prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5 })
    );
  });

  it("returns messages in chronological order (reversed from desc query)", async () => {
    const descMessages = [
      { ...mockMessage, id: "msg-3", text: "C", createdAt: new Date(3000) },
      { ...mockMessage, id: "msg-2", text: "B", createdAt: new Date(2000) },
      { ...mockMessage, id: "msg-1", text: "A", createdAt: new Date(1000) },
    ];
    vi.mocked(prisma.message.findMany).mockResolvedValue(descMessages);
    const result = await getRecentMessages("chat-1");
    expect(result[0].text).toBe("A");
    expect(result[2].text).toBe("C");
  });
});

describe("saveTurn", () => {
  it("writes theme state and the message pair in one transaction", async () => {
    vi.mocked(prisma.chat.update).mockResolvedValue({
      ...mockChat,
      currentTheme: "cafe or restaurant",
      themeReplyCount: 0,
    });
    vi.mocked(prisma.message.create).mockResolvedValue(mockMessage);

    await saveTurn("chat-1", "cafe or restaurant", 0, [
      { role: "user", text: "Hola" },
      { role: "assistant", text: "Buenas.", llmJson: "{}" },
    ]);

    expect(prisma.chat.update).toHaveBeenCalledWith({
      where: { id: "chat-1" },
      data: { currentTheme: "cafe or restaurant", themeReplyCount: 0 },
    });
    expect(prisma.message.create).toHaveBeenCalledWith({
      data: { chatId: "chat-1", role: "user", text: "Hola", llmJson: undefined },
    });
    expect(prisma.message.create).toHaveBeenCalledWith({
      data: { chatId: "chat-1", role: "assistant", text: "Buenas.", llmJson: "{}" },
    });
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });
});

describe("resetChat", () => {
  it("deletes messages and resets theme and mode in a transaction when chat exists", async () => {
    vi.mocked(prisma.chat.findUnique).mockResolvedValue(mockChat);
    vi.mocked(prisma.message.deleteMany).mockResolvedValue({ count: 5 });
    vi.mocked(prisma.chat.update).mockResolvedValue({
      ...mockChat,
      currentTheme: "moving to Spain",
      themeReplyCount: 0,
    });

    await resetChat("123", "moving to Spain");

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(prisma.message.deleteMany).toHaveBeenCalledWith({ where: { chatId: "chat-1" } });
    expect(prisma.chat.update).toHaveBeenCalledWith({
      where: { id: "chat-1" },
      data: {
        currentTheme: "moving to Spain",
        themeReplyCount: 0,
        mode: "dialogue",
        lockTheme: false,
      },
    });
  });

  it("creates new chat when chat does not exist", async () => {
    vi.mocked(prisma.chat.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.chat.create).mockResolvedValue({
      ...mockChat,
      id: "new-chat",
      telegramChatId: "999",
      currentTheme: "public transport",
      themeReplyCount: 0,
    });

    await resetChat("999", "public transport");

    expect(prisma.message.deleteMany).not.toHaveBeenCalled();
    expect(prisma.chat.create).toHaveBeenCalledWith({
      data: { telegramChatId: "999", currentTheme: "public transport", themeReplyCount: 0 },
    });
  });
});
