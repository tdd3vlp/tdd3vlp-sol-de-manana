import type { Bot } from "grammy";
import { handleStart, handleMessage, handleTranslate } from "./handlers.js";

export function registerCommands(bot: Bot): void {
  bot.command("start", handleStart);
  bot.on("message:text", handleMessage);
  bot.callbackQuery("translate", handleTranslate);
}
