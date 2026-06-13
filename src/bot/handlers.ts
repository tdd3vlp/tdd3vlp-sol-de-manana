import { diffWords } from "diff";
import { InlineKeyboard, Keyboard } from "grammy";
import type { Context } from "grammy";
import {
  getOrCreateChat,
  saveMessages,
  getRecentMessages,
  saveTurn,
  updateChatThemeAndLock,
  updateChatMode,
  resetChat,
  consumeDailyMessage,
  refundDailyMessage,
  upgradeChatPlan,
  setAwaitingEmail,
  saveCustomerEmail,
  type NewMessage,
} from "../db/chatHistory.js";
import { recordPaymentAndUpgradeOnce } from "../db/payments.js";
import { createYookassaPayment } from "../payments/yookassaClient.js";
import {
  callSol,
  callSolStart,
  translateBidirectional,
  translateToRussian,
  SolServiceError,
} from "../llm/solService.js";
import {
  callDailyPracticeStart,
  callDailyPractice,
  callDailyPracticeFinale,
} from "../llm/dailyPracticeService.js";
import {
  getTodaySession,
  createTodaySession,
  incrementStep,
  completeSession,
  updateStreakAndWeekly,
  computeDayNumber,
  getThemeForDay,
} from "../db/practiceSession.js";
import { buildLLMContext } from "../conversation/context.js";
import {
  isKnownTheme,
  pickRandomTheme,
  pickRandomThemes,
  shouldChangeTheme,
  THEME_LABELS,
} from "../conversation/themes.js";
import { isNonsense, isLikelyUnsupported, isPromptInjectionAttempt } from "../conversation/language.js";
import {
  PLAN_PRICES_STARS,
  PLAN_PRICES_RUB,
  getPlanModel,
  getEffectivePlan,
  PLAN_LIMITS,
  isAdminUser,
  isBetaUser,
} from "../subscription/plans.js";
import { config } from "../config/env.js";
import {
  reportUserVisibleError,
  type SendMessageApi,
} from "./errorNotifier.js";
import { stripCurrentMessageTags } from "../prompts/solSystemPrompt.js";
import type { SolResponse } from "../llm/schemas.js";

const WELCOME_STICKER_ID =
  "CAACAgIAAxkBAAIG_GopKYTJ-OV5SI0py5HVx7uUI3kVAAJKngACJo1ISanGJVJBcnbeOwQ";

const BTN_TOPIC_MENU = "Выбор темы";
const BTN_MODE_TRANSLATION = "Режим перевода";
const BTN_MODE_DIALOGUE = "Режим диалога";
const BTN_CUSTOM_TOPIC = "Своя тема";
const BTN_DAILY_PRACTICE = "Практика дня";

export function buildDialogueKeyboard(plan: string, userId?: string): Keyboard {
  const kb = new Keyboard().text(BTN_TOPIC_MENU);
  if (plan === "premium" || (userId && isAdminUser(userId))) {
    kb.text(BTN_MODE_TRANSLATION);
  }
  if (userId && isBetaUser(userId)) {
    kb.row().text(BTN_DAILY_PRACTICE);
  }
  return kb.resized().persistent();
}

const translationReplyKeyboard = new Keyboard()
  .text(BTN_MODE_DIALOGUE)
  .resized()
  .persistent();

const LLM_NULL_ARTIFACT_RE = /^[/:]?(?:null|spanish|russian|mixed|unsupported|nonsense)[/,.:;]?\s*$/i;

type PaidPlan = "basic" | "premium";
type PaymentMethod = "stars" | "yookassa";

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
  plan: PaidPlan,
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

async function sendYooKassaDirectPayment(
  ctx: Context,
  plan: PaidPlan,
): Promise<void> {
  const telegramChatId = ctx.chat?.id?.toString();
  if (!telegramChatId) return;

  if (!config.yookassaShopId || !config.yookassaSecretKey) {
    await ctx.reply("Оплата картой/СБП пока не настроена. Можно оплатить Stars.");
    return;
  }

  const chat = await getOrCreateChat(telegramChatId, pickRandomTheme());

  if (!chat.customerEmail) {
    await setAwaitingEmail(chat.id, plan);
    await ctx.reply(
      "Для оформления фискального чека укажи email.\nОн будет использован только для отправки чека.",
    );
    return;
  }

  await createAndSendYooKassaLink(ctx, plan, telegramChatId, chat.customerEmail);
}

async function createAndSendYooKassaLink(
  ctx: Context,
  plan: PaidPlan,
  telegramChatId: string,
  customerEmail: string,
): Promise<void> {
  const labels: Record<PaidPlan, string> = {
    basic: "Basic — 100 сообщений/день",
    premium: "Premium — 300 сообщений/день",
  };
  const rubles = PLAN_PRICES_RUB[plan] / 100;

  try {
    const payment = await createYookassaPayment(plan, telegramChatId, customerEmail);
    const confirmationUrl = payment.confirmation.confirmation_url;
    if (!confirmationUrl) throw new Error("ЮKassa did not return confirmation_url");

    await ctx.reply(
      `${labels[plan]} — ${rubles} ₽ на 30 дней.\nОплата через ЮKassa: карта, СБП и другие способы.`,
      { reply_markup: new InlineKeyboard().url(`Оплатить ${rubles} ₽`, confirmationUrl) },
    );
  } catch (error) {
    console.error("Failed to create ЮKassa payment:", error);
    void reportUserVisibleError(ctx.api, {
      handler: "createAndSendYooKassaLink",
      error,
      telegramChatId,
      plan,
    });
    await ctx.reply("Не удалось создать платёж. Попробуй позже или оплати Stars.");
  }
}

async function sendPaymentMethodPicker(
  ctx: Context,
  plan: PaidPlan,
): Promise<void> {
  if (!config.yookassaShopId) {
    await sendSubscriptionInvoice(ctx, plan);
    return;
  }

  const labels: Record<PaidPlan, string> = {
    basic: "Basic",
    premium: "Premium",
  };
  await ctx.reply(`Выбери способ оплаты для ${labels[plan]}:`, {
    reply_markup: new InlineKeyboard()
      .text("Stars с автопродлением", `pay:${plan}:stars`)
      .row()
      .text("Карта / СБП на 30 дней", `pay:${plan}:yookassa`),
  });
}

function parsePaymentPayload(
  payload: string | undefined,
): { plan: PaidPlan; method: PaymentMethod } | null {
  if (!payload?.startsWith("plan:")) return null;
  const [, plan, method = "stars"] = payload.split(":");
  if (plan !== "basic" && plan !== "premium") return null;
  if (method !== "stars" && method !== "yookassa") return null;
  return { plan, method };
}

function meaningful(s: string | null): s is string {
  if (!s) return false;
  const t = s.trim().toLowerCase();
  return (
    t.length > 1 &&
    !LLM_NULL_ARTIFACT_RE.test(t) &&
    /[a-záéíóúüñа-яёА-ЯЁ]/i.test(t)
  );
}

function sanitizeLlmArtifacts(s: string): string {
  // Belt over the source-level strip in solService: an echoed marker tag
  // must never reach the user, whichever path the response object took.
  return stripCurrentMessageTags(s)
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
  "Por favor, escribe en español o ruso para que podamos continuar.\n\n_(Пожалуйста, пишите на испанском или русском языке, чтобы продолжить диалог)_";

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
    let correction = sanitizeLlmArtifacts(response.correctionOrTranslation);
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
      correction = (bolded && meaningful(bolded)) ? `${prefix} ${bolded}` : "";
    } else {
      correction = plain;
    }
    if (meaningful(correction)) parts.push(correction);
  }
  const cont = sanitizeLlmArtifacts(response.continuation).replace(
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
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/_(.+?)_/gs, "<i>$1</i>");
}

// Sends the reply immediately and appends the Russian spoiler afterwards:
// the translation runs on a cheap model in the background and is edited into
// the message, so the user never waits for it.
//
// Telegram refuses to edit messages sent with a reply keyboard, so when the
// keyboard must be attached (mode/theme entry messages) the translation is
// awaited inline instead and everything goes out as one message.
async function replyWithSpoilerTranslation(
  ctx: Context,
  rawText: string,
  response: SolResponse,
  keyboard?: Keyboard,
): Promise<void> {
  const skipTranslation =
    response.inputLanguage === "unsupported" ||
    response.inputLanguage === "nonsense";

  if (keyboard) {
    let spoiler = "";
    if (!skipTranslation) {
      try {
        const translation = await translateToRussian(
          response.continuation,
          config.openaiModelTranslate,
        );
        spoiler = buildSpoiler(translation);
      } catch (error) {
        console.error("Spoiler translation failed:", error);
      }
    }
    await ctx.reply(formatForTelegram(rawText) + spoiler, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
    return;
  }

  const sent = await ctx.reply(formatForTelegram(rawText), {
    parse_mode: "HTML",
  });
  if (skipTranslation) return;
  void translateToRussian(response.continuation, config.openaiModelTranslate)
    .then((translation) =>
      ctx.api.editMessageText(
        sent.chat.id,
        sent.message_id,
        formatForTelegram(rawText) + buildSpoiler(translation),
        { parse_mode: "HTML" },
      ),
    )
    .catch((error) => console.error("Spoiler translation failed:", error));
}

// History is saved only after the reply is delivered (a failed LLM call or
// Telegram send must not leave messages the user never saw in the LLM
// context), and a persistence failure after delivery must not reach the
// caller's catch — the user already got the answer, so an apology and a
// limit refund would both be wrong. Losing the pair from history is the
// lesser harm; log it and move on.
async function saveDeliveredMessages(
  chatId: string,
  entries: NewMessage[],
  api?: SendMessageApi,
): Promise<void> {
  try {
    await saveMessages(chatId, entries);
  } catch (error) {
    console.error("Failed to persist delivered messages:", error);
    if (api) {
      void reportUserVisibleError(api, {
        handler: "saveDeliveredMessages",
        error,
        telegramChatId: `db:${chatId}`,
        severity: "warning",
      });
    }
  }
}

// Same delivery contract as saveDeliveredMessages, for turns that also
// advance dialogue state (theme/count): one transaction underneath, so
// state and history can never drift apart.
async function saveDeliveredTurn(
  chatId: string,
  theme: string,
  count: number,
  entries: NewMessage[],
  api?: SendMessageApi,
): Promise<void> {
  try {
    await saveTurn(chatId, theme, count, entries);
  } catch (error) {
    console.error("Failed to persist delivered turn:", error);
    if (api) {
      void reportUserVisibleError(api, {
        handler: "saveDeliveredTurn",
        error,
        telegramChatId: `db:${chatId}`,
        severity: "warning",
      });
    }
  }
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

  // Deep link from the Web App: t.me/<bot>?start=pay_basic | pay_premium
  // (payment method picker) or pay_basic_yookassa | pay_premium_yookassa
  // (card/SBP invoice directly). sendData does not work for Web Apps opened
  // via menu/inline buttons, so the Web App redirects here.
  const payload = typeof ctx.match === "string" ? ctx.match.trim() : "";
  const payMatch = payload.match(/^pay_(basic|premium)(_yookassa)?$/);
  if (payMatch) {
    const plan = payMatch[1] as PaidPlan;
    if (payMatch[2]) {
      await sendYooKassaDirectPayment(ctx, plan);
    } else {
      await sendPaymentMethodPicker(ctx, plan);
    }
    return;
  }

  const telegramUserId = ctx.from?.id?.toString();
  const firstName = ctx.from?.first_name ?? "друг";

  // Deep link from Mini App: start=daily_practice
  if (payload === "daily_practice") {
    if (telegramUserId && isBetaUser(telegramUserId)) {
      const dpChat = await getOrCreateChat(telegramChatId, pickRandomTheme());
      await handleDailyPracticeButton(ctx, dpChat, telegramUserId);
      return;
    }
  }

  const theme = pickRandomTheme();
  await resetChat(telegramChatId, theme);

  const webAppUrl =
    telegramUserId && isBetaUser(telegramUserId) && config.webAppBetaUrl
      ? config.webAppBetaUrl
      : config.webAppUrl;

  if (webAppUrl && ctx.chat?.id) {
    try {
      await ctx.api.setChatMenuButton({
        chat_id: ctx.chat.id,
        menu_button: { type: "web_app", text: "Menu", web_app: { url: webAppUrl } },
      });
    } catch (err) {
      console.error("Failed to set per-chat menu button:", err);
    }
  }

  await ctx.replyWithSticker(WELCOME_STICKER_ID);
  await ctx.reply(
    `Привет, ${firstName}! Я Sol, твой друг в изучении испанского языка.\n\nНажми на кнопку, чтобы начать общение. Не знаешь, как сказать что-то по-испански? Пиши по-русски или смешивай языки — я переведу и продолжу диалог.`,
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

  const {
    allowed,
    consumed,
    chat: freshChat,
  } = await consumeDailyMessage(chat, telegramUserId);
  chat = freshChat;
  if (!allowed) {
    await sendPaywall(ctx, chat.plan);
    return;
  }

  try {
    const response = await callSolStart(
      chat,
      getPlanModel(getEffectivePlan(chat), telegramUserId),
    );
    const rawText = assembleMessage(response);
    await replyWithSpoilerTranslation(
      ctx,
      rawText,
      response,
      buildDialogueKeyboard(chat.plan, telegramUserId),
    );
    await saveDeliveredMessages(
      chat.id,
      [{ role: "assistant", text: rawText, llmJson: JSON.stringify(response) }],
      ctx.api,
    );
  } catch (error) {
    console.error("enterDialogueMode error:", error);
    void reportUserVisibleError(ctx.api, {
      handler: "enterDialogueMode",
      error,
      telegramChatId,
      telegramUserId,
      plan: chat.plan,
    });
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
  if (isNonsense(userText) || isLikelyUnsupported(userText) || isPromptInjectionAttempt(userText)) {
    await ctx.reply(formatForTelegram(UNSUPPORTED_WARNING), { parse_mode: "HTML" });
    return;
  }

  const {
    allowed,
    consumed,
    chat: freshChat,
  } = await consumeDailyMessage(chat, telegramUserId);
  chat = freshChat;
  if (!allowed) {
    await sendPaywall(ctx, chat.plan);
    return;
  }

  try {
    // Translation is mechanical work — the cheap model handles it fine
    // regardless of the user's plan.
    const { translation, direction } = await translateBidirectional(
      userText,
      config.openaiModelTranslate,
    );
    const label = direction === "ru→es" ? "🇪🇸 Испанский:" : "🇷🇺 Русский:";
    await ctx.reply(`${label}\n\n${translation}`, {
      reply_markup: translationReplyKeyboard,
    });
  } catch (error) {
    console.error("Translation error:", error);
    void reportUserVisibleError(ctx.api, {
      handler: "handleTranslationInput",
      error,
      telegramChatId,
      telegramUserId,
      plan: chat.plan,
      mode: chat.mode,
      inputPreview: userText,
    });
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

export async function handleMoreThemes(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();
  const telegramChatId = ctx.chat?.id?.toString();
  const telegramUserId = ctx.from?.id?.toString();
  const plan = telegramChatId
    ? getEffectivePlan(await getOrCreateChat(telegramChatId, pickRandomTheme()))
    : "free";
  const isPremium =
    plan === "premium" || !!(telegramUserId && isAdminUser(telegramUserId));
  await ctx.editMessageReplyMarkup({
    reply_markup: buildTopicKeyboard(isPremium),
  });
}

async function handleCustomTopicInput(
  ctx: Context,
  userText: string,
  chat: Awaited<ReturnType<typeof getOrCreateChat>>,
  telegramUserId: string | undefined,
): Promise<void> {
  if (userText.length > 200) {
    await ctx.reply(
      "Тема слишком длинная. Напиши покороче — одним предложением.",
    );
    return;
  }

  if (isNonsense(userText) || isPromptInjectionAttempt(userText)) {
    await ctx.reply("Не понял тему. Напиши её на русском или испанском.");
    return;
  }

  const {
    allowed,
    consumed,
    chat: freshChat,
  } = await consumeDailyMessage(chat, telegramUserId);
  if (!allowed) {
    await sendPaywall(ctx, chat.plan);
    return;
  }
  chat = freshChat;

  chat = await updateChatThemeAndLock(chat.id, userText, 0, true);
  await updateChatMode(chat.id, "dialogue");

  try {
    const response = await callSolStart(
      chat,
      getPlanModel(getEffectivePlan(chat), telegramUserId),
    );
    const rawText = assembleMessage(response);
    await replyWithSpoilerTranslation(
      ctx,
      rawText,
      response,
      buildDialogueKeyboard(chat.plan, telegramUserId),
    );
    await saveDeliveredMessages(
      chat.id,
      [{ role: "assistant", text: rawText, llmJson: JSON.stringify(response) }],
      ctx.api,
    );
  } catch (error) {
    console.error("handleCustomTopicInput error:", error);
    void reportUserVisibleError(ctx.api, {
      handler: "handleCustomTopicInput",
      error,
      telegramChatId: chat.telegramChatId,
      telegramUserId,
      plan: chat.plan,
      inputPreview: userText,
    });
    if (consumed) await refundDailyMessage(chat.id);
    await ctx.reply(
      "Lo siento, ocurrió un error. Por favor, inténtalo de nuevo.",
    );
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
  // Whitelist check: callback data comes from the client and can be forged;
  // an arbitrary string here would land in the prompt and bypass the
  // premium-only custom topic feature.
  if (!theme || !isKnownTheme(theme)) return;

  const telegramChatId = ctx.chat?.id?.toString();
  const telegramUserId = ctx.from?.id?.toString();
  if (!telegramChatId) return;

  let chat = await getOrCreateChat(telegramChatId, theme);
  chat = await updateChatThemeAndLock(chat.id, theme, 0, false);
  await updateChatMode(chat.id, "dialogue");

  const {
    allowed,
    consumed,
    chat: freshChat,
  } = await consumeDailyMessage(chat, telegramUserId);
  chat = freshChat;
  if (!allowed) {
    await sendPaywall(ctx, chat.plan);
    return;
  }

  try {
    const response = await callSolStart(
      chat,
      getPlanModel(getEffectivePlan(chat), telegramUserId),
    );
    const rawText = assembleMessage(response);
    await replyWithSpoilerTranslation(
      ctx,
      rawText,
      response,
      buildDialogueKeyboard(chat.plan, telegramUserId),
    );
    await saveDeliveredMessages(
      chat.id,
      [{ role: "assistant", text: rawText, llmJson: JSON.stringify(response) }],
      ctx.api,
    );
  } catch (error) {
    console.error("handleTopicCallback error:", error);
    void reportUserVisibleError(ctx.api, {
      handler: "handleTopicCallback",
      error,
      telegramChatId,
      telegramUserId,
      plan: chat.plan,
    });
    if (consumed) await refundDailyMessage(chat.id);
    await ctx.reply(
      "Lo siento, ocurrió un error. Por favor, inténtalo de nuevo.",
    );
  }
}

// ─── Daily practice ───────────────────────────────────────────────────────────

function assembleDailyPracticeMessage(
  response: { correctionOrTranslation: string | null; continuation: string },
  userInput?: string,
): string {
  const parts: string[] = [];
  if (meaningful(response.correctionOrTranslation)) {
    let correction = sanitizeLlmArtifacts(response.correctionOrTranslation);
    const plain = correction.replace(/\*\*(.+?)\*\*/g, "$1");
    if (userInput) {
      const prefixMatch = plain.match(/(?:Corrección:|En español:)\s*([\s\S]*)/i);
      const withoutPrefix = prefixMatch ? prefixMatch[1].trim() : plain.trim();
      const bolded = diffAndBold(userInput, withoutPrefix);
      const prefix = plain.startsWith("En español:") ? "En español:" : "Corrección:";
      correction = bolded && meaningful(bolded) ? `${prefix} ${bolded}` : "";
    } else {
      correction = plain;
    }
    if (meaningful(correction)) parts.push(correction);
  }
  const cont = sanitizeLlmArtifacts(response.continuation).replace(/\*\*(.+?)\*\*/g, "$1");
  parts.push(cont || UNSUPPORTED_WARNING);
  return parts.join("\n\n").trim();
}

function buildDailyPracticeFinaleText(highlights: {
  phrases: string[];
  corrections: string[];
  encouragement: string;
}): string {
  const parts: string[] = ["Практика завершена.\n"];

  if (highlights.phrases.length > 0) {
    parts.push("Сегодня ты потренировал:\n" + highlights.phrases.map((p) => `• ${p}`).join("\n"));
  }

  if (highlights.corrections.length > 0) {
    parts.push("Исправления:\n" + highlights.corrections.map((c) => `• ${c}`).join("\n"));
  }

  if (highlights.encouragement) {
    parts.push(highlights.encouragement);
  }

  return parts.join("\n\n");
}

type ChatRecord = Awaited<ReturnType<typeof getOrCreateChat>>;

async function handleDailyPracticeButton(
  ctx: Context,
  chat: ChatRecord,
  telegramUserId: string,
): Promise<void> {
  const telegramChatId = ctx.chat?.id?.toString();
  if (!telegramChatId) return;

  if (!isBetaUser(telegramUserId)) return;

  const session = await getTodaySession(chat.id);

  if (session?.status === "completed") {
    await ctx.reply(
      "Практика на сегодня завершена. Возвращайся завтра!",
      {
        reply_markup: new InlineKeyboard().text("Продолжить в диалоге", "mode_dialogue"),
      },
    );
    return;
  }

  if (session?.status === "active") {
    if (chat.mode !== "daily_practice") {
      await updateChatMode(chat.id, "daily_practice");
    }
    await ctx.reply(
      "Продолжаем практику дня. Ответь на последний вопрос Sol или напиши коротко, где остановились.",
      { reply_markup: buildDialogueKeyboard(chat.plan, telegramUserId) },
    );
    return;
  }

  // Start a new session
  const dayNumber = computeDayNumber(chat);
  const theme = getThemeForDay(dayNumber);
  const newSession = await createTodaySession(chat.id, dayNumber, theme);
  await updateChatMode(chat.id, "daily_practice");

  const model = getPlanModel(getEffectivePlan(chat), telegramUserId);
  try {
    const openingText = await callDailyPracticeStart(newSession, model);
    await ctx.reply(formatForTelegram(openingText), {
      parse_mode: "HTML",
      reply_markup: buildDialogueKeyboard(chat.plan, telegramUserId),
    });
    await saveDeliveredMessages(
      chat.id,
      [{ role: "assistant", text: openingText }],
      ctx.api,
    );
  } catch (error) {
    console.error("handleDailyPracticeButton start error:", error);
    void reportUserVisibleError(ctx.api, {
      handler: "handleDailyPracticeButton",
      error,
      telegramChatId,
      telegramUserId,
    });
    await ctx.reply("Lo siento, ocurrió un error. Por favor, inténtalo de nuevo.");
  }
}

async function handleDailyPracticeMessage(
  ctx: Context,
  chat: ChatRecord,
  telegramUserId: string | undefined,
): Promise<void> {
  const telegramChatId = ctx.chat?.id?.toString();
  const userText = ctx.message?.text;
  if (!telegramChatId || !userText) return;

  const session = await getTodaySession(chat.id);
  if (!session || session.status === "completed") {
    // Session gone or already done: drop back to dialogue
    await updateChatMode(chat.id, "dialogue");
    await ctx.reply(
      "Практика уже завершена. Продолжим в обычном режиме.",
      { reply_markup: buildDialogueKeyboard(chat.plan, telegramUserId) },
    );
    return;
  }

  if (userText.length > 350) {
    await ctx.reply("Сообщение слишком длинное. Пожалуйста, напиши не более 3–4 предложений.");
    return;
  }

  if (isNonsense(userText) || isLikelyUnsupported(userText) || isPromptInjectionAttempt(userText)) {
    await ctx.reply(formatForTelegram(UNSUPPORTED_WARNING), { parse_mode: "HTML" });
    return;
  }

  const { allowed, consumed, chat: freshChat } = await consumeDailyMessage(chat, telegramUserId);
  const activeChat = freshChat;
  if (!allowed) {
    await sendPaywall(ctx, activeChat.plan);
    return;
  }

  const updatedSession = await incrementStep(session.id);
  const recentMessages = await getRecentMessages(chat.id, 14);
  const llmHistory = buildLLMContext(recentMessages);
  const model = getPlanModel(getEffectivePlan(activeChat), telegramUserId);

  try {
    if (updatedSession.stepCount >= 5) {
      // Finale
      const finaleHistory = [
        ...llmHistory,
        { role: "user" as const, content: userText },
      ];
      const highlights = await callDailyPracticeFinale(finaleHistory, updatedSession, model);
      const finaleText = buildDailyPracticeFinaleText(highlights);

      await ctx.reply(formatForTelegram(finaleText), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("Продолжить в диалоге", "mode_dialogue"),
      });

      await completeSession(updatedSession.id, highlights);
      await updateStreakAndWeekly(activeChat, chat.id);
      await updateChatMode(chat.id, "dialogue");

      await saveDeliveredMessages(
        chat.id,
        [
          { role: "user", text: userText },
          { role: "assistant", text: finaleText },
        ],
        ctx.api,
      );
    } else {
      const response = await callDailyPractice(userText, llmHistory, updatedSession, model);

      if (
        response.inputLanguage === "unsupported" ||
        response.inputLanguage === "nonsense"
      ) {
        if (consumed) await refundDailyMessage(chat.id);
        await ctx.reply(formatForTelegram(UNSUPPORTED_WARNING), { parse_mode: "HTML" });
        return;
      }

      const rawText = assembleDailyPracticeMessage(response, userText);
      await ctx.reply(formatForTelegram(rawText), { parse_mode: "HTML" });

      await saveDeliveredMessages(
        chat.id,
        [
          { role: "user", text: userText },
          { role: "assistant", text: rawText },
        ],
        ctx.api,
      );
    }
  } catch (error) {
    if (consumed) await refundDailyMessage(chat.id);
    void reportUserVisibleError(ctx.api, {
      handler: "handleDailyPracticeMessage",
      error,
      telegramChatId,
      telegramUserId,
      mode: "daily_practice",
      inputPreview: userText,
    });
    console.error("handleDailyPracticeMessage error:", error);
    await ctx.reply(
      "Lo siento, tuve un problema al procesar tu mensaje. Por favor, inténtalo de nuevo.",
    );
  }
}

// ─── Email collection for ЮKassa receipts ────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function handleEmailInput(
  ctx: Context,
  userText: string,
  chat: Awaited<ReturnType<typeof getOrCreateChat>>,
  telegramChatId: string,
): Promise<void> {
  const email = userText.trim();
  if (!EMAIL_RE.test(email)) {
    await ctx.reply("Некорректный email. Попробуй ещё раз, например: ivan@example.com");
    return;
  }

  const plan = chat.pendingPaymentPlan as PaidPlan | null;
  if (!plan || (plan !== "basic" && plan !== "premium")) {
    await saveCustomerEmail(chat.id, email);
    await ctx.reply("Email сохранён. Нажми кнопку оплаты ещё раз.");
    return;
  }

  await saveCustomerEmail(chat.id, email);
  await createAndSendYooKassaLink(ctx, plan, telegramChatId, email);
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
  if (userText === BTN_DAILY_PRACTICE) {
    if (telegramUserId && isBetaUser(telegramUserId)) {
      const dpChat = await getOrCreateChat(telegramChatId, pickRandomTheme());
      await handleDailyPracticeButton(ctx, dpChat, telegramUserId);
    }
    return;
  }

  let chat = await getOrCreateChat(telegramChatId, pickRandomTheme());

  // Mode-specific input is routed before dialogue checks: translation allows
  // longer text (500) and custom topics may contain English words.
  if (chat.mode === "daily_practice") {
    await handleDailyPracticeMessage(ctx, chat, telegramUserId);
    return;
  }

  if (chat.mode === "translation") {
    await handleTranslationInput(ctx, userText);
    return;
  }

  if (chat.mode === "awaiting_custom_topic") {
    await handleCustomTopicInput(ctx, userText, chat, telegramUserId);
    return;
  }

  if (chat.mode === "awaiting_email") {
    await handleEmailInput(ctx, userText, chat, telegramChatId);
    return;
  }

  if (userText.length > 350) {
    await ctx.reply(
      "Сообщение слишком длинное. Пожалуйста, напиши не более 3–4 предложений.",
    );
    return;
  }

  // Nonsense/unsupported: warn without touching the counter
  if (isNonsense(userText) || isLikelyUnsupported(userText) || isPromptInjectionAttempt(userText)) {
    await ctx.reply(formatForTelegram(UNSUPPORTED_WARNING), { parse_mode: "HTML" });
    return;
  }

  // Dialogue mode flow
  const {
    allowed,
    consumed,
    chat: freshChat,
  } = await consumeDailyMessage(chat, telegramUserId);
  chat = freshChat;
  if (!allowed) {
    await sendPaywall(ctx, chat.plan);
    return;
  }

  const recentMessages = await getRecentMessages(chat.id, 14);
  const llmHistory = buildLLMContext(recentMessages);

  // Guards against a double refund: if the LLM classifies the input as
  // unsupported/nonsense (refunded here) and a later step still throws,
  // the catch must not refund the same message again.
  let refunded = false;

  try {
    const response = await callSol(
      userText,
      llmHistory,
      chat,
      getPlanModel(getEffectivePlan(chat), telegramUserId),
    );

    // Input the local filter missed but the LLM classified as
    // unsupported/nonsense is not part of the dialogue: it does not count
    // against the daily limit, does not advance the theme, and stays out of
    // history — saved English text would pull later LLM replies toward
    // English.
    if (
      response.inputLanguage === "unsupported" ||
      response.inputLanguage === "nonsense"
    ) {
      if (consumed) {
        await refundDailyMessage(chat.id);
        refunded = true;
      }
      await replyWithSpoilerTranslation(
        ctx,
        assembleMessage(response, userText),
        response,
      );
      return;
    }

    let newCount = chat.themeReplyCount + 1;
    let currentTheme = chat.currentTheme;

    if (!chat.lockTheme && shouldChangeTheme(newCount)) {
      currentTheme = pickRandomTheme();
      newCount = 0;
    }

    const rawText = assembleMessage(response, userText);
    await replyWithSpoilerTranslation(ctx, rawText, response);
    // The background spoiler edit is not part of critical delivery.

    await saveDeliveredTurn(
      chat.id,
      currentTheme,
      newCount,
      [
        { role: "user", text: userText },
        { role: "assistant", text: rawText, llmJson: JSON.stringify(response) },
      ],
      ctx.api,
    );
  } catch (error) {
    if (consumed && !refunded) await refundDailyMessage(chat.id);
    void reportUserVisibleError(ctx.api, {
      handler: "handleMessage",
      error,
      telegramChatId,
      telegramUserId,
      plan: chat.plan,
      mode: chat.mode,
      inputPreview: userText,
    });
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

export async function handleWebAppData(ctx: Context): Promise<void> {
  const data = ctx.message?.web_app_data?.data;
  if (data !== "pay:basic" && data !== "pay:premium") return;
  await sendPaymentMethodPicker(ctx, data.replace("pay:", "") as PaidPlan);
}

export async function handleDirectPayCallback(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery();
  const [, plan, method] = ctx.callbackQuery?.data?.split(":") ?? [];
  if (plan !== "basic" && plan !== "premium") return;

  if (!method) {
    await sendPaymentMethodPicker(ctx, plan);
    return;
  }
  if (method === "stars") {
    await sendSubscriptionInvoice(ctx, plan);
    return;
  }
  if (method === "yookassa") {
    await sendYooKassaDirectPayment(ctx, plan);
  }
}

export async function handlePreCheckout(ctx: Context): Promise<void> {
  const query = ctx.preCheckoutQuery;
  console.log("pre_checkout_query received:", JSON.stringify(query));

  // ЮKassa direct API payments bypass Telegram Payments entirely — reject stale
  // RUB invoices (created before the migration to the direct API).
  if (query?.currency === "RUB") {
    await ctx.answerPreCheckoutQuery(
      false,
      "Оплата картой теперь проходит напрямую через ЮKassa. Оформи подписку заново.",
    );
    return;
  }

  const payload = parsePaymentPayload(query?.invoice_payload);
  const valid =
    !!query &&
    !!payload &&
    payload.method === "stars" &&
    query.currency === "XTR" &&
    query.total_amount === PLAN_PRICES_STARS[payload.plan];

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
  const payload = parsePaymentPayload(payment?.invoice_payload);
  const telegramChatId = ctx.chat?.id?.toString();
  if (!payment || !payload || !telegramChatId) return;

  // Defense in depth: pre-checkout already validated this. Only Stars (XTR) comes
  // through Telegram Payments — RUB is handled by ЮKassa webhook instead.
  const validPayment =
    payload.method === "stars" &&
    payment.currency === "XTR" &&
    payment.total_amount === PLAN_PRICES_STARS[payload.plan];
  if (!validPayment) {
    console.error(
      "successful_payment with unexpected currency/amount:",
      JSON.stringify(payment),
    );
    return;
  }

  // Stars subscriptions always carry subscription_expiration_date (initial and renewals).
  const expiresAt = payment.subscription_expiration_date
    ? new Date(payment.subscription_expiration_date * 1000)
    : null;

  const upgraded = await recordPaymentAndUpgradeOnce({
    telegramChatId,
    plan: payload.plan,
    amount: payment.total_amount,
    currency: payment.currency,
    telegramPaymentChargeId: payment.telegram_payment_charge_id,
    providerPaymentChargeId: payment.provider_payment_charge_id ?? null,
    isRecurring: payment.is_recurring ?? false,
    expiresAt,
  });
  if (!upgraded) {
    console.warn(
      `Duplicate successful_payment ignored: ${payment.telegram_payment_charge_id}`,
    );
    return;
  }

  const isRenewal = payment.is_recurring && !payment.is_first_recurring;
  const confirmations: Record<string, string> = {
    basic: "Подписка Basic активирована. Теперь у тебя 100 сообщений в день.",
    premium:
      "Подписка Premium активирована. Теперь у тебя 300 сообщений в день.",
  };
  // Dialogue replies no longer carry the reply keyboard (it would make them
  // uneditable), so refresh the persistent bar here — an upgrade can add the
  // translation-mode button.
  await ctx.reply(
    isRenewal
      ? `Подписка ${payload.plan === "basic" ? "Basic" : "Premium"} продлена на месяц.`
      : (confirmations[payload.plan] ?? "Подписка активирована."),
    {
      reply_markup:
        upgraded.mode === "translation"
          ? translationReplyKeyboard
          : buildDialogueKeyboard(upgraded.plan, ctx.from?.id?.toString()),
    },
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

  const args = ctx.message?.text?.trim().split(/\s+/).slice(1) ?? [];
  // Two forms: "/setplan <plan>" for the admin's own chat,
  // "/setplan <telegramId> <plan>" for any chat (private chat id == user id).
  const selfForm = args.length === 1;
  const targetChatId = selfForm ? ctx.chat?.id?.toString() : args[0];
  const plan = selfForm ? args[0] : args[1];

  if (!targetChatId || !plan || !(plan in PLAN_LIMITS)) {
    await ctx.reply(
      "Использование:\n/setplan <free|basic|premium> — для себя\n/setplan <telegramId> <free|basic|premium> — для пользователя",
    );
    return;
  }

  await upgradeChatPlan(targetChatId, plan);
  await ctx.reply(
    `План для ${targetChatId} изменён на ${plan} (модель: ${getPlanModel(plan)}).`,
  );
}
