import { Bot } from "grammy";
import { config } from "./config/env.js";
import { registerCommands } from "./bot/commands.js";

const bot = new Bot(config.telegramBotToken);

registerCommands(bot);

bot.catch((err) => {
  console.error("Bot error:", err.error);
});

bot.start();
console.log("Sol de Mañana is running...");
