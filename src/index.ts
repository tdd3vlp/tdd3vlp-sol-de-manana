import { Bot } from "grammy";
import { config } from "./config/env.js";
import { registerCommands } from "./bot/commands.js";

const bot = new Bot(config.telegramBotToken);

registerCommands(bot);

bot.catch((err) => {
  console.error("Bot error:", err.error);
});

if (config.webAppUrl) {
  bot.api.setChatMenuButton({
    menu_button: { type: "web_app", text: "Sol de Mañana", web_app: { url: config.webAppUrl } },
  });
} else {
  bot.api.setMyCommands([]);
}

bot.start();
console.log("Sol de Mañana is running...");
