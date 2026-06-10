import type { Bot } from "grammy";
import {
  handleStart,
  handleMessage,
  handleTranslate,
  handleTopicCallback,
  handleTopicMenu,
  handleMoreThemes,
  handleUnsupportedMedia,
  handleTips,
  handleHelp,
  handleSubscribe,
  handleContinueDialogue,
  handleDirectPayCallback,
  handlePreCheckout,
  handleSuccessfulPayment,
  handleMyId,
  handleSetPlan,
  handleMainMenuCallback,
  handleModeDialogueCallback,
  handleModeTranslationCallback,
} from "./handlers.js";

export function registerCommands(bot: Bot): void {
  bot.command("start", handleStart);
  bot.command("tips", handleTips);
  bot.command("help", handleHelp);
  bot.command("subscribe", handleSubscribe);
  bot.command("myid", handleMyId);
  bot.command("setplan", handleSetPlan);
  bot.on("message:text", handleMessage);
  bot.on("message:successful_payment", handleSuccessfulPayment);
  bot.on("pre_checkout_query", handlePreCheckout);
  bot.on(["message:voice", "message:video_note", "message:photo", "message:video", "message:audio", "message:sticker", "message:document"], handleUnsupportedMedia);
  bot.callbackQuery("translate", handleTranslate);
  bot.callbackQuery("continue_dialogue", handleContinueDialogue);
  bot.callbackQuery("topic_menu", handleTopicMenu);
  bot.callbackQuery(/^topic:/, handleTopicCallback);
  bot.callbackQuery("more_themes", handleMoreThemes);
  bot.callbackQuery(/^pay:/, handleDirectPayCallback);
  bot.callbackQuery("main_menu", handleMainMenuCallback);
  bot.callbackQuery("mode_dialogue", handleModeDialogueCallback);
  bot.callbackQuery("mode_translation", handleModeTranslationCallback);
}
