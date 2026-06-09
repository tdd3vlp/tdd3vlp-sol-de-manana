import type { Bot } from "grammy";
import { handleStart, handleMessage, handleTranslate, handleTopicCallback, handleMoreThemes, handleUnsupportedMedia } from "./handlers.js";

export function registerCommands(bot: Bot): void {
  bot.command("start", handleStart);
  bot.on("message:text", handleMessage);
  bot.on(["message:voice", "message:video_note", "message:photo", "message:video", "message:audio", "message:sticker", "message:document"], handleUnsupportedMedia);
  bot.callbackQuery("translate", handleTranslate);
  bot.callbackQuery(/^topic:/, handleTopicCallback);
  bot.callbackQuery("more_themes", handleMoreThemes);
}
