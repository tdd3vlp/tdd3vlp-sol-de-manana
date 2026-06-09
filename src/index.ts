import { Bot } from "grammy";
import { config } from "./config/env.js";
import { registerCommands } from "./bot/commands.js";

const bot = new Bot(config.telegramBotToken);

registerCommands(bot);

bot.catch((err) => {
  console.error("Bot error:", err.error);
});

bot.api.setMyCommands([
  { command: "start", description: "Начать или перезапустить сессию" },
  { command: "tips", description: "Советы по работе с ботом" },
  { command: "help", description: "Связаться с менеджером" },
]);

bot.start();
console.log("Sol de Mañana is running...");
