import { diffWords } from "diff";
import { InlineKeyboard, Keyboard } from "grammy";
import type { Context } from "grammy";
import {
  getOrCreateChat,
  saveMessage,
  getRecentMessages,
  updateChatTheme,
  updateChatMode,
  resetChat,
  checkAndMaybeReset,
  incrementDailyCount,
  upgradeChatPlan,
} from "../db/chatHistory.js";
import {
  callSol,
  callSolStart,
  translateToRussian,
  translateBidirectional,
  SolServiceError,
} from "../llm/solService.js";
import { buildLLMContext } from "../conversation/context.js";
import {
  pickRandomTheme,
  pickRandomThemes,
  shouldChangeTheme,
  THEME_LABELS,
} from "../conversation/themes.js";
import { isNonsense, isLikelyUnsupported } from "../conversation/language.js";
import {
  PLAN_PRICES_STARS,
  getPlanModel,
  PLAN_LIMITS,
  isAdminUser,
} from "../subscription/plans.js";
import { config } from "../config/env.js";
import type { SolResponse } from "../llm/schemas.js";

const WELCOME_STICKER_ID =
  "CAACAgIAAxkBAAIG_GopKYTJ-OV5SI0py5HVx7uUI3kVAAJKngACJo1ISanGJVJBcnbeOwQ";

const BTN_MAIN_MENU = "Главное меню";
const BTN_MODE_TRANSLATION = "Перевести";
const BTN_MODE_DIALOGUE = "Поговорить";

const dialogueReplyKeyboard = new Keyboard()
  .text(BTN_MAIN_MENU)
  .text(BTN_MODE_TRANSLATION)
  .resized()
  .persistent();

const translationReplyKeyboard = new Keyboard()
  .text(BTN_MAIN_MENU)
  .text(BTN_MODE_DIALOGUE)
  .resized()
  .persistent();

// InlineKeyboard attached to each bot dialogue message
const botKeyboard = new InlineKeyboard()
  .text("Выбрать тему", "topic_menu")
  .text("🇷🇺 Перевести", "translate");

function buildMainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("Hola, Sol 👋", "mode_dialogue");
}

function buildSubscribeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(`Basic — ${PLAN_PRICES_STARS.basic} ⭐`, "pay:basic")
    .row()
    .text(`Premium — ${PLAN_PRICES_STARS.premium} ⭐`, "pay:premium");
}

async function sendPaywall(ctx: Context): Promise<void> {
  await ctx.reply(
    "На сегодня сообщения закончились.\nОбнови подписку, чтобы продолжить.",
    { reply_markup: buildSubscribeKeyboard() },
  );
}

async function sendSubscriptionInvoice(
  ctx: Context,
  plan: "basic" | "premium",
): Promise<void> {
  const labels: Record<string, string> = {
    basic: "Basic — 100 сообщений в день",
    premium: "Premium — 300 сообщений в день",
  };
  const stars = PLAN_PRICES_STARS[plan];
  await ctx.api.sendInvoice(
    ctx.chat!.id,
    labels[plan],
    "Доступ к Sol de Mañana",
    `plan:${plan}`,
    "XTR",
    [{ label: labels[plan], amount: stars }],
  );
}

const TIPS =
  `Некоторые рекомендации по работе с ботом, которые способствуют изучению языка:\n\n` +
  `— Пишите полными предложениями и давайте развернутые ответы.\n` +
  `— Старайтесь всегда писать на испанском языке, бот выделит ошибки.\n` +
  `— Можете написать ответ полностью или частично на русском языке.\n` +
  `— Меняйте тему в любой момент и изучайте лексику.`;

const HELP = `Если у вас возникли вопросы или предложения, напишите менеджеру.\n\nМенеджер отвечает в течение 24 часов.`;

function meaningful(s: string | null): s is string {
  if (!s) return false;
  const t = s.trim().toLowerCase();
  return (
    t.length > 1 &&
    t !== "null" &&
    !/^:?null[,.:;]?\s*$/.test(t) &&
    /[a-záéíóúüñа-яёА-ЯЁ]/i.test(t)
  );
}

function sanitizeNullTokens(s: string): string {
  return s
    .replace(/\/n/g, "\n")
    .replace(/^(\s*:?null[,.:;]?\s*\n*)+/i, "")
    .replace(/\bnull[,.:;]?\s*/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function diffAndBold(original: string, corrected: string): string {
  if (!original || !corrected) return corrected || "";
  const changes = diffWords(original, corrected);
  let result = "";
  for (const part of changes) {
    if (part.removed) continue;
    if (part.added) {
      const text = part.value.trimEnd();
      const trailing = part.value.slice(text.length);
      const wordPart = text.replace(/[.,!?;:]+$/, "");
      const punct = text.slice(wordPart.length);
      if (wordPart) result += `**${wordPart}**`;
      result += punct + trailing;
    } else {
      result += part.value;
    }
  }
  return result.trim();
}

const UNSUPPORTED_WARNING =
  "Por favor, escribe en español o ruso para que podamos continuar.";

export function assembleMessage(
  response: SolResponse,
  userInput?: string,
): string {
  if (
    response.inputLanguage === "unsupported" ||
    response.inputLanguage === "nonsense"
  ) {
    return UNSUPPORTED_WARNING;
  }

  const parts: string[] = [];
  if (meaningful(response.correctionOrTranslation)) {
    let correction = sanitizeNullTokens(response.correctionOrTranslation);
    const plain = correction.replace(/\*\*(.+?)\*\*/g, "$1");
    if (
      userInput &&
      (response.inputLanguage === "spanish" ||
        response.inputLanguage === "mixed")
    ) {
      const prefixMatch = plain.match(
        /(?:Corrección:|En español:)\s*([\s\S]*)/i,
      );
      const withoutPrefix = prefixMatch ? prefixMatch[1].trim() : plain.trim();
      const bolded = diffAndBold(userInput, withoutPrefix);
      const prefix =
        response.inputLanguage === "spanish" ? "Corrección:" : "En español:";
      correction = bolded ? `${prefix} ${bolded}` : "";
    } else {
      correction = plain;
    }
    if (meaningful(correction)) parts.push(correction);
  }
  const cont = sanitizeNullTokens(response.continuation).replace(
    /\*\*(.+?)\*\*/g,
    "$1",
  );
  parts.push(cont || UNSUPPORTED_WARNING);
  const result = parts.join("\n\n");
  return (
    result.replace(/\bnull\b[,.:;]?\s*/gi, "").trim() || UNSUPPORTED_WARNING
  );
}

export function formatForTelegram(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
}

// ─── Main menu ────────────────────────────────────────────────────────────────

async function showMainMenu(ctx: Context): Promise<void> {
  const firstName = ctx.from?.first_name ?? "друг";
  await ctx.reply(
    `Привет, ${firstName}! Я Sol, твой друг в изучении испанского языка.`,
    { reply_markup: buildMainMenuKeyboard() },
  );
}

export async function handleStart(ctx: Context): Promise<void> {
  const telegramChatId = ctx.chat?.id?.toString();
  if (!telegramChatId) return;

  const theme = pickRandomTheme();
  await resetChat(telegramChatId, theme);

  const firstName = ctx.from?.first_name ?? "друг";

  await ctx.replyWithSticker(WELCOME_STICKER_ID);
  await ctx.reply(
    `Привет, ${firstName}! Я Sol, твой друг в изучении испанского языка.`,
    { reply_markup: buildMainMenuKeyboard() },
  );
}

export async function handleMainMenuCallback(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();
  await showMainMenu(ctx);
}

// ─── Dialogue mode ────────────────────────────────────────────────────────────

async function enterDialogueMode(ctx: Context): Promise<void> {
  const telegramChatId = ctx.chat?.id?.toString();
  const telegramUserId = ctx.from?.id?.toString();
  if (!telegramChatId) return;

  let chat = await getOrCreateChat(telegramChatId, pickRandomTheme());
  await updateChatMode(chat.id, "dialogue");

  const { allowed, chat: freshChat } = await checkAndMaybeReset(
    chat,
    telegramUserId,
  );
  chat = freshChat;
  if (!allowed) {
    await sendPaywall(ctx);
    return;
  }

  try {
    const response = await callSolStart(chat);
    await incrementDailyCount(chat.id);
    const rawText = assembleMessage(response);
    await saveMessage(chat.id, "assistant", rawText, JSON.stringify(response));
    await ctx.reply(formatForTelegram(rawText), {
      parse_mode: "HTML",
      reply_markup: dialogueReplyKeyboard,
    });
  } catch (error) {
    console.error("enterDialogueMode error:", error);
    await ctx.reply(
      "Lo siento, ocurrió un error. Por favor, inténtalo de nuevo.",
    );
  }
}

export async function handleModeDialogueCallback(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();
  await enterDialogueMode(ctx);
}

// ─── Translation mode ─────────────────────────────────────────────────────────

async function enterTranslationMode(ctx: Context): Promise<void> {
  const telegramChatId = ctx.chat?.id?.toString();
  const telegramUserId = ctx.from?.id?.toString();
  if (!telegramChatId) return;

  const chat = await getOrCreateChat(telegramChatId, pickRandomTheme());

  if (
    chat.plan !== "premium" &&
    !(telegramUserId && isAdminUser(telegramUserId))
  ) {
    await ctx.reply("Режим перевода доступен только на тарифе Premium.", {
      reply_markup: buildSubscribeKeyboard(),
    });
    return;
  }

  await updateChatMode(chat.id, "translation");
  await ctx.reply(
    "Режим перевода. Отправь текст на русском или испанском — я переведу его.",
    { reply_markup: translationReplyKeyboard },
  );
}

export async function handleModeTranslationCallback(
  ctx: Context,
): Promise<void> {
  await ctx.answerCallbackQuery();
  await enterTranslationMode(ctx);
}

async function handleTranslationInput(
  ctx: Context,
  userText: string,
): Promise<void> {
  const telegramChatId = ctx.chat?.id?.toString();
  const telegramUserId = ctx.from?.id?.toString();
  if (!telegramChatId) return;

  let chat = await getOrCreateChat(telegramChatId, pickRandomTheme());

  if (
    chat.plan !== "premium" &&
    !(telegramUserId && isAdminUser(telegramUserId))
  ) {
    await ctx.reply("Режим перевода доступен только на тарифе Premium.", {
      reply_markup: buildSubscribeKeyboard(),
    });
    return;
  }

  const { allowed, chat: freshChat } = await checkAndMaybeReset(
    chat,
    telegramUserId,
  );
  chat = freshChat;
  if (!allowed) {
    await sendPaywall(ctx);
    return;
  }

  const model = getPlanModel(chat.plan);
  try {
    const { translation, direction } = await translateBidirectional(
      userText,
      model,
    );
    await incrementDailyCount(chat.id);
    const label = direction === "ru→es" ? "🇪🇸 Испанский:" : "🇷🇺 Русский:";
    await ctx.reply(`${label}\n\n${translation}`, {
      reply_markup: translationReplyKeyboard,
    });
  } catch (error) {
    console.error("Translation error:", error);
    await ctx.reply("Не удалось перевести. Попробуй ещё раз.");
  }
}

// ─── Topic menu ───────────────────────────────────────────────────────────────

function buildTopicKeyboard(): InlineKeyboard {
  const themes = pickRandomThemes(7);
  const keyboard = new InlineKeyboard();
  themes.forEach((theme, i) => {
    keyboard.text(THEME_LABELS[theme] ?? theme, `topic:${theme}`);
    if (i % 2 === 1) keyboard.row();
  });
  keyboard.text("Другие темы →", "more_themes");
  return keyboard;
}

export async function handleTopicMenu(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();
  await ctx.reply("Выбери тему для разговора:", {
    reply_markup: buildTopicKeyboard(),
  });
}

export async function handleMoreThemes(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: buildTopicKeyboard() });
}

export async function handleTopicCallback(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();
  const theme = ctx.callbackQuery?.data?.replace("topic:", "");
  if (!theme) return;

  const telegramChatId = ctx.chat?.id?.toString();
  const telegramUserId = ctx.from?.id?.toString();
  if (!telegramChatId) return;

  let chat = await getOrCreateChat(telegramChatId, theme);
  chat = await updateChatTheme(chat.id, theme, 0);
  await updateChatMode(chat.id, "dialogue");

  const { allowed, chat: freshChat } = await checkAndMaybeReset(
    chat,
    telegramUserId,
  );
  chat = freshChat;
  if (!allowed) {
    await sendPaywall(ctx);
    return;
  }

  try {
    const response = await callSolStart(chat);
    await incrementDailyCount(chat.id);
    const rawText = assembleMessage(response);
    await saveMessage(chat.id, "assistant", rawText, JSON.stringify(response));
    await ctx.reply(formatForTelegram(rawText), {
      parse_mode: "HTML",
      reply_markup: botKeyboard,
    });
  } catch (error) {
    console.error("handleTopicCallback error:", error);
    await ctx.reply(
      "Lo siento, ocurrió un error. Por favor, inténtalo de nuevo.",
    );
  }
}

// ─── Misc handlers ────────────────────────────────────────────────────────────

export async function handleContinueDialogue(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();
  await ctx.reply("Продолжаем! Напиши что-нибудь по-испански или по-русски.", {
    reply_markup: dialogueReplyKeyboard,
  });
}

export async function handleTips(ctx: Context): Promise<void> {
  const backButton = new InlineKeyboard().text("← Главное меню", "main_menu");
  await ctx.reply(TIPS, { reply_markup: backButton });
}

export async function handleTipsCallback(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();
  const backButton = new InlineKeyboard().text("← Главное меню", "main_menu");
  await ctx.reply(TIPS, { reply_markup: backButton });
}

export async function handleHelp(ctx: Context): Promise<void> {
  await ctx.reply(HELP, {
    reply_markup: new InlineKeyboard()
      .url("Связаться с менеджером", "https://t.me/tdd3vlp")
      .row()
      .text("Главное меню", "main_menu"),
  });
}

// ─── Main message handler ─────────────────────────────────────────────────────

export async function handleMessage(ctx: Context): Promise<void> {
  const telegramChatId = ctx.chat?.id?.toString();
  const telegramUserId = ctx.from?.id?.toString();
  const userText = ctx.message?.text;
  if (!telegramChatId || !userText) return;

  // Intercept persistent keyboard nav buttons before any other processing
  if (userText === BTN_MAIN_MENU) {
    await showMainMenu(ctx);
    return;
  }
  if (userText === BTN_MODE_TRANSLATION) {
    await enterTranslationMode(ctx);
    return;
  }
  if (userText === BTN_MODE_DIALOGUE) {
    await enterDialogueMode(ctx);
    return;
  }

  // Nonsense/unsupported: warn without touching the counter
  if (isNonsense(userText) || isLikelyUnsupported(userText)) {
    await ctx.reply(formatForTelegram(UNSUPPORTED_WARNING), {
      parse_mode: "HTML",
      reply_markup: botKeyboard,
    });
    return;
  }

  let chat = await getOrCreateChat(telegramChatId, pickRandomTheme());

  // Route to translation mode if active
  if (chat.mode === "translation") {
    await handleTranslationInput(ctx, userText);
    return;
  }

  // Dialogue mode flow
  const { allowed, chat: freshChat } = await checkAndMaybeReset(
    chat,
    telegramUserId,
  );
  chat = freshChat;
  if (!allowed) {
    await sendPaywall(ctx);
    return;
  }

  const recentMessages = await getRecentMessages(chat.id, 14);
  const llmHistory = buildLLMContext(recentMessages);
  await saveMessage(chat.id, "user", userText);

  try {
    const response = await callSol(userText, llmHistory, chat);

    if (
      response.inputLanguage !== "unsupported" &&
      response.inputLanguage !== "nonsense"
    ) {
      await incrementDailyCount(chat.id);
    }

    let newCount = chat.themeReplyCount + 1;
    let currentTheme = chat.currentTheme;

    if (shouldChangeTheme(newCount)) {
      currentTheme = pickRandomTheme();
      newCount = 0;
    }

    chat = await updateChatTheme(chat.id, currentTheme, newCount);

    const rawText = assembleMessage(response, userText);
    await saveMessage(chat.id, "assistant", rawText, JSON.stringify(response));
    await ctx.reply(formatForTelegram(rawText), {
      parse_mode: "HTML",
      reply_markup: botKeyboard,
    });
  } catch (error) {
    if (error instanceof SolServiceError) {
      console.error("LLM service error in handleMessage:", error);
      await ctx.reply(
        "Lo siento, tuve un problema al procesar tu mensaje. Por favor, inténtalo de nuevo. " +
          "/ Извини, возникла проблема. Попробуй ещё раз.",
      );
    } else {
      console.error("Unexpected error in handleMessage:", error);
      await ctx.reply(
        "Lo siento, ocurrió un error inesperado. / Произошла неожиданная ошибка.",
      );
    }
  }
}

// ─── Subscription handlers ────────────────────────────────────────────────────

export async function handleSubscribe(ctx: Context): Promise<void> {
  const keyboard = buildSubscribeKeyboard()
    .row()
    .text("Продолжить диалог →", "continue_dialogue");
  await ctx.reply(
    "Подписка Sol de Mañana:\n\n" +
      `Basic — ${PLAN_PRICES_STARS.basic} ⭐ — 100 сообщений в день\n` +
      `Premium — ${PLAN_PRICES_STARS.premium} ⭐ — 300 сообщений в день`,
    { reply_markup: keyboard },
  );
}

export async function handleDirectPayCallback(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();
  const plan = ctx.callbackQuery?.data?.replace("pay:", "");
  if (plan !== "basic" && plan !== "premium") return;
  await sendSubscriptionInvoice(ctx, plan);
}

export async function handlePreCheckout(ctx: Context): Promise<void> {
  await ctx.answerPreCheckoutQuery(true);
}

export async function handleSuccessfulPayment(ctx: Context): Promise<void> {
  const payload = ctx.message?.successful_payment?.invoice_payload;
  const telegramChatId = ctx.chat?.id?.toString();
  if (!payload || !telegramChatId) return;

  if (!payload.startsWith("plan:")) return;
  const plan = payload.replace("plan:", "");
  if (plan !== "basic" && plan !== "premium") return;

  await upgradeChatPlan(telegramChatId, plan);

  const confirmations: Record<string, string> = {
    basic: "Подписка Basic активирована. Теперь у тебя 100 сообщений в день.",
    premium:
      "Подписка Premium активирована. Теперь у тебя 300 сообщений в день.",
  };
  await ctx.reply(confirmations[plan] ?? "Подписка активирована.");
}

const MEDIA_WARNING =
  "Я принимаю только текстовые сообщения. Напиши что-нибудь по-испански или по-русски. / Solo acepto mensajes de texto.";

export async function handleUnsupportedMedia(ctx: Context): Promise<void> {
  await ctx.reply(MEDIA_WARNING);
}

// ─── Inline translate button ──────────────────────────────────────────────────

function stripCorrectionLine(text: string): string {
  const paragraphs = text.split("\n\n");
  const first = paragraphs[0].trimStart();
  if (/^(Corrección:|En español:)/i.test(first)) {
    return paragraphs.slice(1).join("\n\n").trim();
  }
  return text;
}

export async function handleTranslate(ctx: Context): Promise<void> {
  const originalText = ctx.callbackQuery?.message?.text;
  if (!originalText) {
    await ctx.answerCallbackQuery({ text: "Текст не найден." });
    return;
  }

  await ctx.answerCallbackQuery();

  const telegramChatId = ctx.chat?.id?.toString();
  const chat = telegramChatId
    ? await getOrCreateChat(telegramChatId, pickRandomTheme())
    : null;
  const model = getPlanModel(chat?.plan ?? "free");
  const textToTranslate = stripCorrectionLine(originalText);

  try {
    const translation = await translateToRussian(textToTranslate, model);
    await ctx.reply(translation, {
      reply_parameters: { message_id: ctx.callbackQuery!.message!.message_id },
    });
  } catch (error) {
    console.error("Translation error:", error);
    await ctx.reply("Не удалось перевести. Попробуй ещё раз.");
  }
}

// ─── Admin handlers ───────────────────────────────────────────────────────────

export async function handleMyId(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id?.toString();
  if (!chatId) return;
  await ctx.reply(`Твой Chat ID: \`${chatId}\``, { parse_mode: "MarkdownV2" });
}

export async function handleSetPlan(ctx: Context): Promise<void> {
  const adminId = ctx.from?.id?.toString();
  if (!adminId || !isAdminUser(adminId)) {
    await ctx.reply("Нет доступа.");
    return;
  }

  const args = ctx.message?.text?.split(" ").slice(1);
  const targetChatId = args?.[0];
  const plan = args?.[1];

  if (!targetChatId || !plan || !(plan in PLAN_LIMITS)) {
    await ctx.reply("Использование: /setplan <chatId> <free|basic|premium>");
    return;
  }

  await upgradeChatPlan(targetChatId, plan);
  await ctx.reply(`План для ${targetChatId} изменён на ${plan}.`);
}
