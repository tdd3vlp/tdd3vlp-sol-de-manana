import { InlineKeyboard } from "grammy";
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
import { pickRandomTheme, shouldChangeTheme } from "../conversation/themes.js";
import type { SolResponse } from "../llm/schemas.js";

const translateKeyboard = new InlineKeyboard().text("🇷🇺 Перевести", "translate");

// Rejects null, bare "null", and LLM artifacts like ":null," or "null,"
function meaningful(s: string | null): s is string {
  if (!s) return false;
  const t = s.trim().toLowerCase();
  return t.length > 1 && t !== "null" && !/^:?null[,.:;]?\s*$/.test(t);
}

function sanitizeNullTokens(s: string): string {
  return s
    .replace(/^(\s*:?null[,.:;]?\s*\n*)+/i, "")  // strip leading null artifact (including "null:")
    .replace(/\bnull[,.:;]?\s*/gi, "")             // strip null anywhere mid-text
    .replace(/\n{3,}/g, "\n\n")                    // collapse triple+ newlines
    .trim();
}

// Strip bold markers (**word**) from any word that appears unchanged in the original input.
// Comparison is case-insensitive but accent-sensitive: "fiestas"/"Fiestas" match,
// but "si" and "sí" do NOT match, so accent corrections keep their bold.
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
  // Last-resort: if "null" somehow survived sanitization, strip it
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
      reply_markup: translateKeyboard,
    });
  } catch (error) {
    console.error("handleStart error:", error);
    await ctx.reply(
      "¡Hola! Soy Sol de Mañana, tu compañero de español. " +
        "Escríbeme algo en español o ruso y empezamos. / " +
        "Привет! Я Sol de Mañana. Напиши мне что-нибудь по-испански или по-русски!"
    );
  }
}

export async function handleMessage(ctx: Context): Promise<void> {
  const telegramChatId = ctx.chat?.id?.toString();
  const userText = ctx.message?.text;
  if (!telegramChatId || !userText) return;

  let chat = await getOrCreateChat(telegramChatId, pickRandomTheme());

  // Fetch history before saving the current message so it appears as the last user turn
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
