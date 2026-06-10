import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSolResponse, makeChat } from "../src/testing/fixtures.js";
import { assembleMessage, formatForTelegram } from "../src/bot/handlers.js";

vi.mock("../src/config/env.js", () => ({
  config: {
    telegramBotToken: "test-token",
    openaiApiKey: "test-key",
    openaiModel: "gpt-4o",
    databaseUrl: "postgresql://test",
    nodeEnv: "test",
    webappUrl: "",
    adminTelegramIds: [],
  },
}));

vi.mock("../src/db/chatHistory.js", () => ({
  getOrCreateChat: vi.fn(),
  saveMessage: vi.fn(),
  getRecentMessages: vi.fn(),
  updateChatTheme: vi.fn(),
  updateChatMode: vi.fn(),
  resetChat: vi.fn(),
  checkAndMaybeReset: vi.fn(),
  incrementDailyCount: vi.fn(),
  upgradeChatPlan: vi.fn(),
}));

vi.mock("../src/llm/solService.js", () => ({
  callSol: vi.fn(),
  callSolStart: vi.fn(),
  SolServiceError: class SolServiceError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "SolServiceError";
    }
  },
}));

vi.mock("../src/conversation/themes.js", () => ({
  pickRandomTheme: vi.fn().mockReturnValue("supermarket"),
  shouldChangeTheme: vi.fn().mockReturnValue(false),
}));

import type { Context } from "grammy";
import {
  getOrCreateChat,
  saveMessage,
  getRecentMessages,
  updateChatTheme,
  resetChat,
  checkAndMaybeReset,
  incrementDailyCount,
} from "../src/db/chatHistory.js";
import { callSol, callSolStart, SolServiceError } from "../src/llm/solService.js";
import { shouldChangeTheme } from "../src/conversation/themes.js";
import { handleStart, handleMessage, handleUnsupportedMedia } from "../src/bot/handlers.js";

function makeCtx(opts: { chatId?: number; text?: string } = {}): Context {
  return {
    chat: { id: opts.chatId ?? 12345 },
    from: { first_name: "Test" },
    message: { text: opts.text ?? "Me gusta España." },
    reply: vi.fn().mockResolvedValue({}),
    replyWithSticker: vi.fn().mockResolvedValue({}),
  } as unknown as Context;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(saveMessage).mockResolvedValue({} as ReturnType<typeof saveMessage> extends Promise<infer T> ? T : never);
  vi.mocked(getRecentMessages).mockResolvedValue([]);
  vi.mocked(incrementDailyCount).mockResolvedValue();
  // Default: limit not exceeded, return chat unchanged
  vi.mocked(checkAndMaybeReset).mockImplementation(async (chat) => ({ allowed: true, chat }));
});

// ── assembleMessage ──────────────────────────────────────────────────────────

describe("assembleMessage", () => {
  it("returns only continuation when nothing else is set", () => {
    const r = makeSolResponse({ correctionOrTranslation: null });
    expect(assembleMessage(r)).toBe(r.continuation);
  });

  it("prepends correction before continuation (no userInput → no diff, plain text shown)", () => {
    const r = makeSolResponse({
      correctionOrTranslation: "Corrección: Quiero ir al mercado.",
      continuation: "Buena idea. ¿Qué quieres comprar?",
    });
    expect(assembleMessage(r)).toBe(
      "Corrección: Quiero ir al mercado.\n\nBuena idea. ¿Qué quieres comprar?"
    );
  });

  it("orders parts: correction → continuation", () => {
    const r = makeSolResponse({
      correctionOrTranslation: "Corrección: Quiero ir al mercado.",
      continuation: "Buena idea. Es un mercado estupendo. Tienen frutas frescas todos los días. ¿Qué quieres comprar?",
    });
    const parts = assembleMessage(r).split("\n\n");
    expect(parts[0]).toContain("mercado.");
    expect(parts[1]).toContain("Buena idea");
  });
});

// ── formatForTelegram ────────────────────────────────────────────────────────

describe("formatForTelegram", () => {
  it("converts **bold** to <b>bold</b>", () => {
    expect(formatForTelegram("Quiero **ir** al mercado.")).toBe(
      "Quiero <b>ir</b> al mercado."
    );
  });

  it("escapes HTML entities", () => {
    expect(formatForTelegram("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  it("passes plain text through unchanged", () => {
    expect(formatForTelegram("Hola, ¿cómo estás?")).toBe("Hola, ¿cómo estás?");
  });

  it("handles multiple bold spans", () => {
    expect(formatForTelegram("**ir** y **vivir**")).toBe("<b>ir</b> y <b>vivir</b>");
  });
});

// ── handleStart ──────────────────────────────────────────────────────────────

describe("handleStart", () => {
  it("resets chat, sends sticker, greeting, and main menu", async () => {
    const chat = makeChat({ id: "chat-1", telegramChatId: "12345" });
    vi.mocked(resetChat).mockResolvedValue(chat);

    const ctx = makeCtx();
    await handleStart(ctx);

    expect(resetChat).toHaveBeenCalledWith("12345", "supermarket");
    expect(callSolStart).not.toHaveBeenCalled();
    expect(ctx.replyWithSticker).toHaveBeenCalledOnce();
    expect(ctx.reply).toHaveBeenCalledTimes(2);
    const firstReplyText = vi.mocked(ctx.reply).mock.calls[0][0] as string;
    expect(firstReplyText).toContain("Sol");
  });

  it("does nothing when chat context is missing", async () => {
    const ctx = {
      chat: null,
      from: null,
      message: null,
      reply: vi.fn(),
      replyWithSticker: vi.fn(),
    } as unknown as Context;
    await handleStart(ctx);
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});

// ── handleMessage ────────────────────────────────────────────────────────────

describe("handleMessage", () => {
  it("saves user message, calls LLM, saves assistant message, and replies", async () => {
    const chat = makeChat();
    vi.mocked(getOrCreateChat).mockResolvedValue(chat);
    vi.mocked(updateChatTheme).mockResolvedValue({ ...chat, themeReplyCount: 1 });
    vi.mocked(callSol).mockResolvedValue(
      makeSolResponse({ continuation: "Interesante. ¿Y tú?" })
    );

    const ctx = makeCtx({ text: "Me gusta España." });
    await handleMessage(ctx);

    expect(saveMessage).toHaveBeenCalledWith(chat.id, "user", "Me gusta España.");
    expect(callSol).toHaveBeenCalledOnce();
    expect(saveMessage).toHaveBeenCalledWith(
      expect.any(String),
      "assistant",
      expect.any(String),
      expect.any(String)
    );
    expect(ctx.reply).toHaveBeenCalledOnce();
  });

  it("increments themeReplyCount when theme does not change", async () => {
    vi.mocked(shouldChangeTheme).mockReturnValue(false);
    const chat = makeChat({ themeReplyCount: 2, currentTheme: "supermarket" });
    vi.mocked(getOrCreateChat).mockResolvedValue(chat);
    vi.mocked(updateChatTheme).mockResolvedValue({ ...chat, themeReplyCount: 3 });
    vi.mocked(callSol).mockResolvedValue(makeSolResponse());

    await handleMessage(makeCtx());

    expect(updateChatTheme).toHaveBeenCalledWith(chat.id, "supermarket", 3);
  });

  it("resets count to 0 and picks new theme when shouldChangeTheme is true", async () => {
    vi.mocked(shouldChangeTheme).mockReturnValue(true);
    const chat = makeChat({ themeReplyCount: 8, currentTheme: "supermarket" });
    vi.mocked(getOrCreateChat).mockResolvedValue(chat);
    vi.mocked(updateChatTheme).mockResolvedValue({ ...chat, currentTheme: "supermarket", themeReplyCount: 0 });
    vi.mocked(callSol).mockResolvedValue(makeSolResponse());

    await handleMessage(makeCtx());

    // Count resets to 0; theme changes to whatever pickRandomTheme returns ("supermarket" in mock)
    expect(updateChatTheme).toHaveBeenCalledWith(chat.id, "supermarket", 0);
  });

  it("sends LLM fallback message on SolServiceError", async () => {
    vi.mocked(getOrCreateChat).mockResolvedValue(makeChat());
    vi.mocked(callSol).mockRejectedValue(new SolServiceError("fail"));

    const ctx = makeCtx();
    await handleMessage(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining("inténtalo")
    );
  });

  it("does nothing when message text is missing", async () => {
    const ctx = {
      chat: { id: 1 },
      message: { text: undefined },
      reply: vi.fn(),
    } as unknown as Context;
    await handleMessage(ctx);
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});

// ── handleUnsupportedMedia ───────────────────────────────────────────────────

describe("handleUnsupportedMedia", () => {
  it("replies with bilingual text-only warning", async () => {
    const ctx = { reply: vi.fn().mockResolvedValue({}) } as unknown as Context;
    await handleUnsupportedMedia(ctx);
    const text: string = vi.mocked(ctx.reply).mock.calls[0][0] as string;
    expect(text).toMatch(/текстовые сообщения/i);
    expect(text).toMatch(/Solo acepto mensajes de texto/i);
  });

  it("replies exactly once regardless of media type", async () => {
    const ctx = { reply: vi.fn().mockResolvedValue({}) } as unknown as Context;
    await handleUnsupportedMedia(ctx);
    expect(ctx.reply).toHaveBeenCalledOnce();
  });

  it("does not call the LLM or database", async () => {
    const ctx = { reply: vi.fn().mockResolvedValue({}) } as unknown as Context;
    await handleUnsupportedMedia(ctx);
    expect(callSol).not.toHaveBeenCalled();
    expect(saveMessage).not.toHaveBeenCalled();
  });
});
