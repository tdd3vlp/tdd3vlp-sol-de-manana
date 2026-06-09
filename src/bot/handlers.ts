import { InlineKeyboard, Keyboard } from "grammy";
import type { Context } from "grammy";
import {
  getOrCreateChat,
  saveMessage,
  getRecentMessages,
  updateChatTheme,
  resetChat,
} from "../db/chatHistory.js";
import { callSol, callSolStart, translateToRussian, SolServiceError } from "../llm/solService.js";
import { buildLLMContext } from "../conversation/context.js";
import { pickRandomTheme, pickRandomThemes, shouldChangeTheme, THEME_LABELS } from "../conversation/themes.js";
import type { SolResponse } from "../llm/schemas.js";

const MENU_TOPIC = "Выбрать тему";
const MENU_RECOMMENDATIONS = "Рекомендации";

export const mainKeyboard = new Keyboard()
  .text(MENU_TOPIC).text(MENU_RECOMMENDATIONS)
  .resized()
  .persistent();

const translateKeyboard = new InlineKeyboard().text("🇷🇺 Перевести", "translate");

const RECOMMENDATIONS =
  `Некоторые рекомендации по работе с ботом, которые способствуют изучению языка:\n\n` +
  `— Пишите полными предложениями и давайте развернутые ответы.\n` +
  `— Старайтесь всегда писать на испанском языке, бот выделит ошибки.\n` +
  `— Можете написать ответ полностью или частично на русском языке.\n` +
  `— Меняйте тему в любой момент и изучайте лексику.`;

// Rejects null, bare "null", and LLM artifacts like ":null," or "null,"
function meaningful(s: string | null): s is string {
  if (!s) return false;
  const t = s.trim().toLowerCase();
  return t.length > 1 && t !== "null" && !/^:?null[,.:;]?\s*$/.test(t);
}

function sanitizeNullTokens(s: string): string {
  return s
    .replace(/^(\s*:?null[,.:;]?\s*\n*)+/i, "")
    .replace(/\bnull[,.:;]?\s*/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function casefold(s: string): string {
  return s.toLowerCase();
}

export function removeFalseBold(correction: string, userInput: string): string {
  const userWords = new Set(
    userInput
      .split(/\s+/)
      .map((w) => casefold(w.replace(/[^a-záéíóúüñA-ZÁÉÍÓÚÜÑ]/g, "")))
      .filter(Boolean)
  );
  return correction.replace(/\*\*(.+?)\*\*/g, (match, word) => {
    const bare = casefold(word.replace(/[^a-záéíóúüñA-ZÁÉÍÓÚÜÑ]/g, ""));
    return userWords.has(bare) ? word : match;
  });
}

const UNSUPPORTED_WARNING =
  "Por favor, escribe en español o ruso para que podamos continuar.";

export function assembleMessage(response: SolResponse, userInput?: string): string {
  if (
    response.inputLanguage === "unsupported" ||
    response.inputLanguage === "nonsense"
  ) {
    return UNSUPPORTED_WARNING;
  }

  const parts: string[] = [];
  if (meaningful(response.correctionOrTranslation)) {
    const correction = userInput
      ? removeFalseBold(response.correctionOrTranslation, userInput)
      : response.correctionOrTranslation;
    parts.push(correction);
  }
  const cont = sanitizeNullTokens(response.continuation).replace(/\*\*(.+?)\*\*/g, "$1");
  parts.push(cont || UNSUPPORTED_WARNING);
  const result = parts.join("\n\n");
  return result.replace(/\bnull\b[,.:;]?\s*/gi, "").trim() || UNSUPPORTED_WARNING;
}

export function formatForTelegram(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
}

export async function handleStart(ctx: Context): Promise<void> {
  const telegramChatId = ctx.chat?.id?.toString();
  if (!telegramChatId) return;

  const theme = pickRandomTheme();
  const chat = await resetChat(telegramChatId, theme);

  try {
    const response = await callSolStart(chat);
    const rawText = assembleMessage(response);
    await saveMessage(chat.id, "assistant", rawText, JSON.stringify(response));
    await ctx.reply(formatForTelegram(rawText), {
      parse_mode: "HTML",
      reply_markup: mainKeyboard,
    });
  } catch (error) {
    console.error("handleStart error:", error);
    await ctx.reply(
      "¡Hola! Soy Sol de Mañana, tu compañero de español. " +
        "Escríbeme algo en español o ruso y empezamos. / " +
        "Привет! Я Sol de Mañana. Напиши мне что-нибудь по-испански или по-русски!",
      { reply_markup: mainKeyboard }
    );
  }
}

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
  await ctx.reply("Выбери тему для разговора:", { reply_markup: buildTopicKeyboard() });
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
  if (!telegramChatId) return;

  let chat = await getOrCreateChat(telegramChatId, theme);
  chat = await updateChatTheme(chat.id, theme, 0);

  try {
    const response = await callSolStart(chat);
    const rawText = assembleMessage(response);
    await saveMessage(chat.id, "assistant", rawText, JSON.stringify(response));
    await ctx.reply(formatForTelegram(rawText), {
      parse_mode: "HTML",
      reply_markup: translateKeyboard,
    });
  } catch (error) {
    console.error("handleTopicCallback error:", error);
    await ctx.reply("Lo siento, ocurrió un error. Por favor, inténtalo de nuevo.");
  }
}

export async function handleRecommendations(ctx: Context): Promise<void> {
  await ctx.reply(RECOMMENDATIONS);
}

export async function handleMessage(ctx: Context): Promise<void> {
  const telegramChatId = ctx.chat?.id?.toString();
  const userText = ctx.message?.text;
  if (!telegramChatId || !userText) return;

  if (userText === MENU_TOPIC) {
    await handleTopicMenu(ctx);
    return;
  }
  if (userText === MENU_RECOMMENDATIONS) {
    await handleRecommendations(ctx);
    return;
  }

  let chat = await getOrCreateChat(telegramChatId, pickRandomTheme());

  const recentMessages = await getRecentMessages(chat.id, 14);
  const llmHistory = buildLLMContext(recentMessages);

  await saveMessage(chat.id, "user", userText);

  try {
    const response = await callSol(userText, llmHistory, chat);

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
      reply_markup: translateKeyboard,
    });
  } catch (error) {
    if (error instanceof SolServiceError) {
      console.error("LLM service error in handleMessage:", error);
      await ctx.reply(
        "Lo siento, tuve un problema al procesar tu mensaje. Por favor, inténtalo de nuevo. " +
          "/ Извини, возникла проблема. Попробуй ещё раз."
      );
    } else {
      console.error("Unexpected error in handleMessage:", error);
      await ctx.reply(
        "Lo siento, ocurrió un error inesperado. / Произошла неожиданная ошибка."
      );
    }
  }
}

const MEDIA_WARNING =
  "Я принимаю только текстовые сообщения. Напиши что-нибудь по-испански или по-русски. / Solo acepto mensajes de texto.";

export async function handleUnsupportedMedia(ctx: Context): Promise<void> {
  await ctx.reply(MEDIA_WARNING);
}

export async function handleTranslate(ctx: Context): Promise<void> {
  const originalText = ctx.callbackQuery?.message?.text;
  if (!originalText) {
    await ctx.answerCallbackQuery({ text: "Текст не найден." });
    return;
  }

  await ctx.answerCallbackQuery();

  try {
    const translation = await translateToRussian(originalText);
    await ctx.reply(translation, {
      reply_parameters: { message_id: ctx.callbackQuery!.message!.message_id },
    });
  } catch (error) {
    console.error("Translation error:", error);
    await ctx.reply("Не удалось перевести. Попробуй ещё раз.");
  }
}
