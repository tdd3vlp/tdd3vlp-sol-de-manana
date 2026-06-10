import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSolResponse, makeChat } from "../src/testing/fixtures.js";
import { assembleMessage, formatForTelegram } from "../src/bot/handlers.js";

vi.mock("../src/config/env.js", () => ({
  config: {
    telegramBotToken: "test-token",
    openaiApiKey: "test-key",
    openaiModelFree: "gpt-4o-mini",
    openaiModelPaid: "gpt-4o",
    openaiModelTranslate: "gpt-4o-mini",
    databaseUrl: "postgresql://test",
    nodeEnv: "test",
    webAppUrl: "",
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
  consumeDailyMessage: vi.fn(),
  refundDailyMessage: vi.fn(),
  upgradeChatPlan: vi.fn(),
}));

vi.mock("../src/db/payments.js", () => ({
  recordPaymentOnce: vi.fn(),
}));

vi.mock("../src/llm/solService.js", () => ({
  callSol: vi.fn(),
  callSolStart: vi.fn(),
  translateBidirectional: vi.fn(async () => ({
    translation: "перевод",
    direction: "es→ru" as const,
  })),
  translateToRussian: vi.fn(async () => "перевод"),
  SolServiceError: class SolServiceError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "SolServiceError";
    }
  },
}));

vi.mock("../src/conversation/themes.js", () => ({
  pickRandomTheme: vi.fn().mockReturnValue("supermarket"),
  pickRandomThemes: vi.fn().mockReturnValue(["supermarket"]),
  shouldChangeTheme: vi.fn().mockReturnValue(false),
  THEME_LABELS: { supermarket: "Супермаркет" },
}));

import type { Context } from "grammy";
import {
  getOrCreateChat,
  saveMessage,
  getRecentMessages,
  updateChatTheme,
  resetChat,
  consumeDailyMessage,
  refundDailyMessage,
} from "../src/db/chatHistory.js";
import {
  callSol,
  callSolStart,
  translateToRussian,
  SolServiceError,
} from "../src/llm/solService.js";
import { shouldChangeTheme } from "../src/conversation/themes.js";
import {
  handleStart,
  handleMessage,
  handleUnsupportedMedia,
  handleSuccessfulPayment,
} from "../src/bot/handlers.js";
import { upgradeChatPlan } from "../src/db/chatHistory.js";
import { recordPaymentOnce } from "../src/db/payments.js";

function makeCtx(opts: { chatId?: number; text?: string } = {}): Context {
  return {
    chat: { id: opts.chatId ?? 12345 },
    from: { first_name: "Test" },
    message: { text: opts.text ?? "Me gusta España." },
    reply: vi.fn().mockResolvedValue({
      chat: { id: opts.chatId ?? 12345 },
      message_id: 1,
    }),
    replyWithSticker: vi.fn().mockResolvedValue({}),
    api: { editMessageText: vi.fn().mockResolvedValue(true) },
  } as unknown as Context;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(saveMessage).mockResolvedValue({} as ReturnType<typeof saveMessage> extends Promise<infer T> ? T : never);
  vi.mocked(getRecentMessages).mockResolvedValue([]);
  vi.mocked(refundDailyMessage).mockResolvedValue();
  // Default: limit not exceeded, message consumed, return chat unchanged
  vi.mocked(consumeDailyMessage).mockImplementation(async (chat) => ({
    allowed: true,
    consumed: true,
    chat,
  }));
  vi.mocked(recordPaymentOnce).mockResolvedValue(true);
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
    expect(ctx.reply).toHaveBeenCalledOnce();
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

  it("sends a Stars subscription invoice link for pay_basic deep link without resetting chat", async () => {
    const ctx = makeCtx();
    (ctx as { match?: string }).match = "pay_basic";
    (ctx as { api?: unknown }).api = {
      createInvoiceLink: vi.fn().mockResolvedValue("https://t.me/$invoice"),
    };

    await handleStart(ctx);

    expect(resetChat).not.toHaveBeenCalled();
    expect(ctx.replyWithSticker).not.toHaveBeenCalled();
    const call = vi.mocked(ctx.api.createInvoiceLink).mock.calls[0];
    expect(call[2]).toBe("plan:basic");
    expect(call[4]).toBe("XTR");
    expect(call[5]).toEqual([{ label: expect.stringContaining("Basic"), amount: 200 }]);
    expect(call[6]).toEqual({ subscription_period: 2592000 });
    const reply = vi.mocked(ctx.reply).mock.calls[0];
    expect(reply[0]).toContain("автопродлением");
    expect(JSON.stringify(reply[1])).toContain("https://t.me/$invoice");
  });

  it("sends a Stars subscription invoice link for pay_premium deep link", async () => {
    const ctx = makeCtx();
    (ctx as { match?: string }).match = "pay_premium";
    (ctx as { api?: unknown }).api = {
      createInvoiceLink: vi.fn().mockResolvedValue("https://t.me/$invoice"),
    };

    await handleStart(ctx);

    const call = vi.mocked(ctx.api.createInvoiceLink).mock.calls[0];
    expect(call[2]).toBe("plan:premium");
    expect(call[5]).toEqual([{ label: expect.stringContaining("Premium"), amount: 600 }]);
  });

  it("ignores unknown start payloads and runs normal start flow", async () => {
    const chat = makeChat({ id: "chat-1", telegramChatId: "12345" });
    vi.mocked(resetChat).mockResolvedValue(chat);

    const ctx = makeCtx();
    (ctx as { match?: string }).match = "pay_unknown";

    await handleStart(ctx);

    expect(resetChat).toHaveBeenCalledWith("12345", "supermarket");
    expect(ctx.replyWithSticker).toHaveBeenCalledOnce();
  });
});

// ── handleSuccessfulPayment ──────────────────────────────────────────────────

function makePaymentCtx(payment: Record<string, unknown>): Context {
  return {
    chat: { id: 12345 },
    message: { successful_payment: payment },
    reply: vi.fn().mockResolvedValue({}),
  } as unknown as Context;
}

describe("handleSuccessfulPayment", () => {
  it("upgrades plan with expiry from subscription_expiration_date", async () => {
    const exp = Math.floor(Date.now() / 1000) + 2592000;
    const ctx = makePaymentCtx({
      invoice_payload: "plan:basic",
      subscription_expiration_date: exp,
      is_recurring: true,
      is_first_recurring: true,
    });

    await handleSuccessfulPayment(ctx);

    expect(upgradeChatPlan).toHaveBeenCalledWith("12345", "basic", new Date(exp * 1000));
    expect(vi.mocked(ctx.reply).mock.calls[0][0]).toContain("активирована");
  });

  it("sends renewal confirmation and extends expiry on auto-renewal", async () => {
    const exp = Math.floor(Date.now() / 1000) + 2592000;
    const ctx = makePaymentCtx({
      invoice_payload: "plan:premium",
      subscription_expiration_date: exp,
      is_recurring: true,
    });

    await handleSuccessfulPayment(ctx);

    expect(upgradeChatPlan).toHaveBeenCalledWith("12345", "premium", new Date(exp * 1000));
    expect(vi.mocked(ctx.reply).mock.calls[0][0]).toContain("продлена");
  });

  it("stores no expiry for legacy one-time payments", async () => {
    const ctx = makePaymentCtx({ invoice_payload: "plan:basic" });

    await handleSuccessfulPayment(ctx);

    expect(upgradeChatPlan).toHaveBeenCalledWith("12345", "basic", null);
  });

  it("ignores unknown payloads", async () => {
    const ctx = makePaymentCtx({ invoice_payload: "something:else" });

    await handleSuccessfulPayment(ctx);

    expect(upgradeChatPlan).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("records the charge for audit and refunds", async () => {
    const ctx = makePaymentCtx({
      invoice_payload: "plan:basic",
      total_amount: 200,
      currency: "XTR",
      telegram_payment_charge_id: "charge-1",
      provider_payment_charge_id: "provider-1",
      is_recurring: true,
    });

    await handleSuccessfulPayment(ctx);

    expect(recordPaymentOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        telegramChatId: "12345",
        plan: "basic",
        amount: 200,
        currency: "XTR",
        telegramPaymentChargeId: "charge-1",
        providerPaymentChargeId: "provider-1",
        isRecurring: true,
      })
    );
  });

  it("skips duplicate payment updates without upgrading twice", async () => {
    vi.mocked(recordPaymentOnce).mockResolvedValue(false);
    const ctx = makePaymentCtx({
      invoice_payload: "plan:basic",
      telegram_payment_charge_id: "charge-1",
    });

    await handleSuccessfulPayment(ctx);

    expect(upgradeChatPlan).not.toHaveBeenCalled();
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

  it("edits the russian spoiler into the reply in the background", async () => {
    const chat = makeChat();
    vi.mocked(getOrCreateChat).mockResolvedValue(chat);
    vi.mocked(updateChatTheme).mockResolvedValue({ ...chat, themeReplyCount: 1 });
    vi.mocked(callSol).mockResolvedValue(
      makeSolResponse({ continuation: "Interesante. ¿Y tú?" })
    );

    const ctx = makeCtx({ text: "Me gusta España." });
    await handleMessage(ctx);

    await vi.waitFor(() =>
      expect(ctx.api.editMessageText).toHaveBeenCalledOnce()
    );
    expect(translateToRussian).toHaveBeenCalledWith(
      "Interesante. ¿Y tú?",
      "gpt-4o-mini"
    );
    const edited = vi.mocked(ctx.api.editMessageText).mock.calls[0][2] as string;
    expect(edited).toContain("tg-spoiler");
    expect(edited).toContain("перевод");
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
    // No orphan user message must remain in history after an LLM failure
    expect(saveMessage).not.toHaveBeenCalled();
    // The failed message must be refunded to the daily limit
    expect(refundDailyMessage).toHaveBeenCalled();
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
