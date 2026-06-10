import { diffWords } from "diff";
import { InlineKeyboard, Keyboard } from "grammy";
import type { Context } from "grammy";
import {
  getOrCreateChat,
  saveMessage,
  getRecentMessages,
  updateChatTheme,
  updateChatThemeAndLock,
  updateChatMode,
  resetChat,
  consumeDailyMessage,
  refundDailyMessage,
  upgradeChatPlan,
} from "../db/chatHistory.js";
import { recordPaymentOnce } from "../db/payments.js";
import {
  callSol,
  callSolStart,
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
  PLAN_PRICES_RUB,
  getPlanModel,
  getEffectivePlan,
  PLAN_LIMITS,
  isAdminUser,
} from "../subscription/plans.js";
import { config } from "../config/env.js";
import type { SolResponse } from "../llm/schemas.js";

const WELCOME_STICKER_ID =
  "CAACAgIAAxkBAAIG_GopKYTJ-OV5SI0py5HVx7uUI3kVAAJKngACJo1ISanGJVJBcnbeOwQ";

const BTN_TOPIC_MENU = "Выбор темы";
const BTN_MODE_TRANSLATION = "Режим перевода";
const BTN_MODE_DIALOGUE = "Режим диалога";
const BTN_CUSTOM_TOPIC = "Своя тема";

function buildDialogueKeyboard(plan: string, userId?: string): Keyboard {
  const kb = new Keyboard().text(BTN_TOPIC_MENU);
  if (plan === "premium" || (userId && isAdminUser(userId))) {
    kb.text(BTN_MODE_TRANSLATION);
  }
  return kb.resized().persistent();
}

const translationReplyKeyboard = new Keyboard()
  .text(BTN_MODE_DIALOGUE)
  .resized()
  .persistent();

function buildMainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("Hola, Sol 👋", "mode_dialogue");
}

function buildSubscribeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Выбрать Basic", "pay:basic")
    .row()
    .text("Выбрать Premium", "pay:premium");
}

async function sendPaywall(ctx: Context, plan = "free"): Promise<void> {
  const isUpgrade = plan === "basic";
  const text = isUpgrade
    ? "Ты достиг лимита Basic.\nУлучши до Premium, чтобы получить 300 сообщений в день."
    : "На сегодня сообщения закончились.\nОбнови подписку, чтобы продолжить.";

  if (config.webAppUrl) {
    const btnLabel = isUpgrade ? "Улучшить до Premium" : "Выбрать тариф";
    await ctx.reply(text, {
      reply_markup: new InlineKeyboard().webApp(btnLabel, config.webAppUrl),
    });
  } else {
    const keyboard = isUpgrade
      ? new InlineKeyboard().text("Выбрать Premium", "pay:premium")
      : buildSubscribeKeyboard();
    await ctx.reply(text, { reply_markup: keyboard });
  }
}

// The only subscription period Telegram allows: 30 days.
const SUBSCRIPTION_PERIOD_SECONDS = 2592000;

async function sendSubscriptionInvoice(
  ctx: Context,
  plan: "basic" | "premium",
): Promise<void> {
  const labels: Record<string, string> = {
    basic: "Basic — 100 сообщений в день",
    premium: "Premium — 300 сообщений в день",
  };
  const stars = PLAN_PRICES_STARS[plan];
  // sendInvoice does not support subscriptions, so we go through an invoice link
  const link = await ctx.api.createInvoiceLink(
    labels[plan],
    "Подписка Sol de Mañana на 30 дней с автопродлением",
    `plan:${plan}`,
    "",
    "XTR",
    [{ label: labels[plan], amount: stars }],
    { subscription_period: SUBSCRIPTION_PERIOD_SECONDS },
  );
  await ctx.reply(
    `${labels[plan]} — ${stars} ⭐ в месяц с автопродлением.\nОтменить подписку можно в любой момент в настройках Telegram.`,
    { reply_markup: new InlineKeyboard().url(`Оплатить ${stars} ⭐`, link) },
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

function buildSpoiler(translation: string | null | undefined): string {
  if (!translation) return "";
  const escaped = translation
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `\n\n<tg-spoiler><i>(${escaped})</i></tg-spoiler>`;
}

// ─── Main menu ────────────────────────────────────────────────────────────────

export async function handleStart(ctx: Context): Promise<void> {
  const telegramChatId = ctx.chat?.id?.toString();
  if (!telegramChatId) return;

  // Deep link from the Web App: t.me/<bot>?start=pay_basic | pay_premium.
  // sendData does not work for Web Apps opened via menu/inline buttons,
  // so the Web App redirects here to trigger the Stars invoice.
  const payload = typeof ctx.match === "string" ? ctx.match.trim() : "";
  if (payload === "pay_basic" || payload === "pay_premium") {
    await sendSubscriptionInvoice(
      ctx,
      payload.replace("pay_", "") as "basic" | "premium",
    );
    return;
  }

  const theme = pickRandomTheme();
  await resetChat(telegramChatId, theme);

  const firstName = ctx.from?.first_name ?? "друг";

  await ctx.replyWithSticker(WELCOME_STICKER_ID);
  await ctx.reply(
    `Привет, ${firstName}! Я Sol, твой друг в изучении испанского языка.`,
    { reply_markup: buildMainMenuKeyboard() },
  );
}

// ─── Dialogue mode ────────────────────────────────────────────────────────────

async function enterDialogueMode(ctx: Context): Promise<void> {
  const telegramChatId = ctx.chat?.id?.toString();
  const telegramUserId = ctx.from?.id?.toString();
  if (!telegramChatId) return;

  let chat = await getOrCreateChat(telegramChatId, pickRandomTheme());
  await updateChatMode(chat.id, "dialogue");

  const { allowed, consumed, chat: freshChat } = await consumeDailyMessage(
    chat,
    telegramUserId,
  );
  chat = freshChat;
  if (!allowed) {
    await sendPaywall(ctx, chat.plan);
    return;
  }

  try {
    const response = await callSolStart(chat);
    const rawText = assembleMessage(response);
    await saveMessage(chat.id, "assistant", rawText, JSON.stringify(response));
    await ctx.reply(
      formatForTelegram(rawText) + buildSpoiler(response.russianTranslation),
      { parse_mode: "HTML", reply_markup: buildDialogueKeyboard(chat.plan, telegramUserId) },
    );
  } catch (error) {
    console.error("enterDialogueMode error:", error);
    if (consumed) await refundDailyMessage(chat.id);
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
    getEffectivePlan(chat) !== "premium" &&
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
    getEffectivePlan(chat) !== "premium" &&
    !(telegramUserId && isAdminUser(telegramUserId))
  ) {
    await ctx.reply("Режим перевода доступен только на тарифе Premium.", {
      reply_markup: buildSubscribeKeyboard(),
    });
    return;
  }

  if (userText.length > 500) {
    await ctx.reply(
      "Текст слишком длинный. Пожалуйста, отправь не более 3–4 предложений.",
    );
    return;
  }

  // The translator only handles Spanish and Russian
  if (isNonsense(userText) || isLikelyUnsupported(userText)) {
    await ctx.reply(UNSUPPORTED_WARNING);
    return;
  }

  const { allowed, consumed, chat: freshChat } = await consumeDailyMessage(
    chat,
    telegramUserId,
  );
  chat = freshChat;
  if (!allowed) {
    await sendPaywall(ctx, chat.plan);
    return;
  }

  const model = getPlanModel(chat.plan);
  try {
    const { translation, direction } = await translateBidirectional(
      userText,
      model,
    );
    const label = direction === "ru→es" ? "🇪🇸 Испанский:" : "🇷🇺 Русский:";
    await ctx.reply(`${label}\n\n${translation}`, {
      reply_markup: translationReplyKeyboard,
    });
  } catch (error) {
    console.error("Translation error:", error);
    if (consumed) await refundDailyMessage(chat.id);
    await ctx.reply("Не удалось перевести. Попробуй ещё раз.");
  }
}

// ─── Topic menu ───────────────────────────────────────────────────────────────

function buildTopicKeyboard(isPremium: boolean): InlineKeyboard {
  const themes = pickRandomThemes(7);
  const keyboard = new InlineKeyboard();
  themes.forEach((theme, i) => {
    keyboard.text(THEME_LABELS[theme] ?? theme, `topic:${theme}`);
    if (i % 2 === 1) keyboard.row();
  });
  keyboard.text("Другие темы →", "more_themes");
  if (isPremium) {
    keyboard.row().text(`${BTN_CUSTOM_TOPIC} →`, "custom_topic");
  }
  return keyboard;
}

async function showTopicMenu(ctx: Context, isPremium: boolean): Promise<void> {
  await ctx.reply("Выбери тему для разговора:", {
    reply_markup: buildTopicKeyboard(isPremium),
  });
}

export async function handleTopicMenu(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();
  const telegramChatId = ctx.chat?.id?.toString();
  const telegramUserId = ctx.from?.id?.toString();
  const plan = telegramChatId
    ? getEffectivePlan(await getOrCreateChat(telegramChatId, pickRandomTheme()))
    : "free";
  const isPremium = plan === "premium" || !!(telegramUserId && isAdminUser(telegramUserId));
  await showTopicMenu(ctx, isPremium);
}

export async function handleMoreThemes(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();
  const telegramChatId = ctx.chat?.id?.toString();
  const telegramUserId = ctx.from?.id?.toString();
  const plan = telegramChatId
    ? getEffectivePlan(await getOrCreateChat(telegramChatId, pickRandomTheme()))
    : "free";
  const isPremium = plan === "premium" || !!(telegramUserId && isAdminUser(telegramUserId));
  await ctx.editMessageReplyMarkup({ reply_markup: buildTopicKeyboard(isPremium) });
}

async function handleCustomTopicInput(
  ctx: Context,
  userText: string,
  chat: Awaited<ReturnType<typeof getOrCreateChat>>,
  telegramUserId: string | undefined,
): Promise<void> {
  if (userText.length > 200) {
    await ctx.reply("Тема слишком длинная. Напиши покороче — одним предложением.");
    return;
  }

  if (isNonsense(userText)) {
    await ctx.reply("Не понял тему. Напиши её на русском или испанском.");
    return;
  }

  const { allowed, consumed, chat: freshChat } = await consumeDailyMessage(chat, telegramUserId);
  if (!allowed) {
    await sendPaywall(ctx, chat.plan);
    return;
  }
  chat = freshChat;

  chat = await updateChatThemeAndLock(chat.id, userText, 0, true);
  await updateChatMode(chat.id, "dialogue");

  try {
    const response = await callSolStart(chat);
    const rawText = assembleMessage(response);
    await saveMessage(chat.id, "assistant", rawText, JSON.stringify(response));
    await ctx.reply(
      formatForTelegram(rawText) + buildSpoiler(response.russianTranslation),
      { parse_mode: "HTML", reply_markup: buildDialogueKeyboard(chat.plan, telegramUserId) },
    );
  } catch (error) {
    console.error("handleCustomTopicInput error:", error);
    if (consumed) await refundDailyMessage(chat.id);
    await ctx.reply("Lo siento, ocurrió un error. Por favor, inténtalo de nuevo.");
  }
}

export async function handleCustomTopicCallback(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();
  const telegramChatId = ctx.chat?.id?.toString();
  const telegramUserId = ctx.from?.id?.toString();
  if (!telegramChatId) return;

  const chat = await getOrCreateChat(telegramChatId, pickRandomTheme());
  if (
    getEffectivePlan(chat) !== "premium" &&
    !(telegramUserId && isAdminUser(telegramUserId))
  ) {
    await ctx.reply("Своя тема доступна только на тарифе Premium.", {
      reply_markup: buildSubscribeKeyboard(),
    });
    return;
  }

  await updateChatMode(chat.id, "awaiting_custom_topic");
  await ctx.reply(
    "Напиши тему, которую хочешь обсудить — на русском или испанском.",
  );
}

export async function handleTopicCallback(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();
  const theme = ctx.callbackQuery?.data?.replace("topic:", "");
  if (!theme) return;

  const telegramChatId = ctx.chat?.id?.toString();
  const telegramUserId = ctx.from?.id?.toString();
  if (!telegramChatId) return;

  let chat = await getOrCreateChat(telegramChatId, theme);
  chat = await updateChatThemeAndLock(chat.id, theme, 0, false);
  await updateChatMode(chat.id, "dialogue");

  const { allowed, consumed, chat: freshChat } = await consumeDailyMessage(
    chat,
    telegramUserId,
  );
  chat = freshChat;
  if (!allowed) {
    await sendPaywall(ctx, chat.plan);
    return;
  }

  try {
    const response = await callSolStart(chat);
    const rawText = assembleMessage(response);
    await saveMessage(chat.id, "assistant", rawText, JSON.stringify(response));
    await ctx.reply(
      formatForTelegram(rawText) + buildSpoiler(response.russianTranslation),
      { parse_mode: "HTML", reply_markup: buildDialogueKeyboard(chat.plan, telegramUserId) },
    );
  } catch (error) {
    console.error("handleTopicCallback error:", error);
    if (consumed) await refundDailyMessage(chat.id);
    await ctx.reply(
      "Lo siento, ocurrió un error. Por favor, inténtalo de nuevo.",
    );
  }
}

// ─── Misc handlers ────────────────────────────────────────────────────────────

export async function handleContinueDialogue(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();
  const telegramChatId = ctx.chat?.id?.toString();
  const telegramUserId = ctx.from?.id?.toString();
  const plan = telegramChatId
    ? getEffectivePlan(await getOrCreateChat(telegramChatId, pickRandomTheme()))
    : "free";
  await ctx.reply("Продолжаем! Напиши что-нибудь по-испански или по-русски.", {
    reply_markup: buildDialogueKeyboard(plan, telegramUserId),
  });
}

export async function handleTips(ctx: Context): Promise<void> {
  await ctx.reply(TIPS);
}

export async function handleTipsCallback(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();
  await ctx.reply(TIPS);
}

export async function handleHelp(ctx: Context): Promise<void> {
  await ctx.reply(HELP, {
    reply_markup: new InlineKeyboard().url(
      "Связаться с менеджером",
      "https://t.me/tdd3vlp",
    ),
  });
}

// ─── Main message handler ─────────────────────────────────────────────────────

export async function handleMessage(ctx: Context): Promise<void> {
  const telegramChatId = ctx.chat?.id?.toString();
  const telegramUserId = ctx.from?.id?.toString();
  const userText = ctx.message?.text;
  if (!telegramChatId || !userText) return;

  // Intercept persistent keyboard nav buttons before any other processing
  if (userText === BTN_MODE_TRANSLATION) {
    await enterTranslationMode(ctx);
    return;
  }
  if (userText === BTN_MODE_DIALOGUE) {
    await enterDialogueMode(ctx);
    return;
  }
  if (userText === BTN_TOPIC_MENU) {
    const chat = await getOrCreateChat(telegramChatId, pickRandomTheme());
    const isPremium =
      getEffectivePlan(chat) === "premium" ||
      !!(telegramUserId && isAdminUser(telegramUserId));
    await showTopicMenu(ctx, isPremium);
    return;
  }

  let chat = await getOrCreateChat(telegramChatId, pickRandomTheme());

  // Mode-specific input is routed before dialogue checks: translation allows
  // longer text (500) and custom topics may contain English words.
  if (chat.mode === "translation") {
    await handleTranslationInput(ctx, userText);
    return;
  }

  if (chat.mode === "awaiting_custom_topic") {
    await handleCustomTopicInput(ctx, userText, chat, telegramUserId);
    return;
  }

  if (userText.length > 350) {
    await ctx.reply(
      "Сообщение слишком длинное. Пожалуйста, напиши не более 3–4 предложений.",
    );
    return;
  }

  // Nonsense/unsupported: warn without touching the counter
  if (isNonsense(userText) || isLikelyUnsupported(userText)) {
    await ctx.reply(UNSUPPORTED_WARNING);
    return;
  }

  // Dialogue mode flow
  const { allowed, consumed, chat: freshChat } = await consumeDailyMessage(
    chat,
    telegramUserId,
  );
  chat = freshChat;
  if (!allowed) {
    await sendPaywall(ctx, chat.plan);
    return;
  }

  const recentMessages = await getRecentMessages(chat.id, 14);
  const llmHistory = buildLLMContext(recentMessages);

  try {
    const response = await callSol(userText, llmHistory, chat);

    // Persist the user message only after a successful LLM response —
    // otherwise a failed call leaves an unanswered message in history and
    // the next request gets a broken context.
    await saveMessage(chat.id, "user", userText);

    // Unsupported/nonsense input does not count against the daily limit
    if (
      consumed &&
      (response.inputLanguage === "unsupported" ||
        response.inputLanguage === "nonsense")
    ) {
      await refundDailyMessage(chat.id);
    }

    let newCount = chat.themeReplyCount + 1;
    let currentTheme = chat.currentTheme;

    if (!chat.lockTheme && shouldChangeTheme(newCount)) {
      currentTheme = pickRandomTheme();
      newCount = 0;
    }

    chat = await updateChatTheme(chat.id, currentTheme, newCount);

    const rawText = assembleMessage(response, userText);
    await saveMessage(chat.id, "assistant", rawText, JSON.stringify(response));
    await ctx.reply(
      formatForTelegram(rawText) + buildSpoiler(response.russianTranslation),
      { parse_mode: "HTML", reply_markup: buildDialogueKeyboard(chat.plan, telegramUserId) },
    );
  } catch (error) {
    if (consumed) await refundDailyMessage(chat.id);
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
  if (config.webAppUrl) {
    const keyboard = new InlineKeyboard().webApp("Выбрать тариф", config.webAppUrl);
    await ctx.reply("Тарифы Sol de Mañana:", { reply_markup: keyboard });
  } else {
    const keyboard = buildSubscribeKeyboard()
      .row()
      .text("Продолжить диалог →", "continue_dialogue");
    await ctx.reply(
      `Подписка Sol de Mañana:\n\nBasic — ${PLAN_PRICES_RUB.basic} ₽ / ${PLAN_PRICES_STARS.basic} ⭐ — 100 сообщений в день\nPremium — ${PLAN_PRICES_RUB.premium} ₽ / ${PLAN_PRICES_STARS.premium} ⭐ — 300 сообщений в день`,
      { reply_markup: keyboard },
    );
  }
}

export async function handleWebAppData(ctx: Context): Promise<void> {
  const data = ctx.message?.web_app_data?.data;
  if (data !== "pay:basic" && data !== "pay:premium") return;
  await sendSubscriptionInvoice(ctx, data.replace("pay:", "") as "basic" | "premium");
}

export async function handleDirectPayCallback(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();
  const plan = ctx.callbackQuery?.data?.replace("pay:", "");
  if (plan !== "basic" && plan !== "premium") return;
  await sendSubscriptionInvoice(ctx, plan);
}

export async function handlePreCheckout(ctx: Context): Promise<void> {
  const query = ctx.preCheckoutQuery;
  const plan = query?.invoice_payload?.replace("plan:", "");
  const valid =
    !!query &&
    (plan === "basic" || plan === "premium") &&
    query.currency === "XTR" &&
    query.total_amount === PLAN_PRICES_STARS[plan];

  if (valid) {
    await ctx.answerPreCheckoutQuery(true);
  } else {
    console.error("Rejected pre-checkout query:", JSON.stringify(query));
    await ctx.answerPreCheckoutQuery(
      false,
      "Не удалось проверить платёж. Попробуйте оформить подписку заново.",
    );
  }
}

export async function handleSuccessfulPayment(ctx: Context): Promise<void> {
  const payment = ctx.message?.successful_payment;
  const payload = payment?.invoice_payload;
  const telegramChatId = ctx.chat?.id?.toString();
  if (!payment || !payload || !telegramChatId) return;

  if (!payload.startsWith("plan:")) return;
  const plan = payload.replace("plan:", "");
  if (plan !== "basic" && plan !== "premium") return;

  // Telegram sends successful_payment for the initial purchase and for every
  // auto-renewal; subscription_expiration_date moves forward each cycle.
  const expiresAt = payment.subscription_expiration_date
    ? new Date(payment.subscription_expiration_date * 1000)
    : null;

  const isNewCharge = await recordPaymentOnce({
    telegramChatId,
    plan,
    amount: payment.total_amount,
    currency: payment.currency,
    telegramPaymentChargeId: payment.telegram_payment_charge_id,
    providerPaymentChargeId: payment.provider_payment_charge_id ?? null,
    isRecurring: payment.is_recurring ?? false,
    expiresAt,
  });
  if (!isNewCharge) {
    console.warn(
      `Duplicate successful_payment ignored: ${payment.telegram_payment_charge_id}`,
    );
    return;
  }

  await upgradeChatPlan(telegramChatId, plan, expiresAt);

  const isRenewal = payment.is_recurring && !payment.is_first_recurring;
  const confirmations: Record<string, string> = {
    basic: "Подписка Basic активирована. Теперь у тебя 100 сообщений в день.",
    premium:
      "Подписка Premium активирована. Теперь у тебя 300 сообщений в день.",
  };
  await ctx.reply(
    isRenewal
      ? `Подписка ${plan === "basic" ? "Basic" : "Premium"} продлена на месяц.`
      : confirmations[plan] ?? "Подписка активирована.",
  );
}

const MEDIA_WARNING =
  "Я принимаю только текстовые сообщения. Напиши что-нибудь по-испански или по-русски. / Solo acepto mensajes de texto.";

export async function handleUnsupportedMedia(ctx: Context): Promise<void> {
  await ctx.reply(MEDIA_WARNING);
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
