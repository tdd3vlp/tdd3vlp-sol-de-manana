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

function meaningful(s: string | null): s is string {
  return !!s && s.trim().length > 1;
}

export function assembleMessage(response: SolResponse): string {
  const parts: string[] = [];
  if (meaningful(response.correctionOrTranslation)) parts.push(response.correctionOrTranslation);
  if (meaningful(response.reminder)) parts.push(response.reminder);
  parts.push(response.continuation);
  return parts.join("\n\n");
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

    const rawText = assembleMessage(response);
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
