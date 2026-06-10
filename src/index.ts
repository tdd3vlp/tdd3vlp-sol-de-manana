import { Bot } from "grammy";
import { config } from "./config/env.js";
import { registerCommands } from "./bot/commands.js";

const bot = new Bot(config.telegramBotToken);

registerCommands(bot);

bot.catch((err) => {
  console.error("Bot error:", err.error);
});

async function main() {
  if (config.webAppUrl) {
    try {
      await bot.api.setChatMenuButton({
        menu_button: { type: "web_app", text: "Sol de Mañana", web_app: { url: config.webAppUrl } },
      });
      console.log("Web App menu button set.");
    } catch (err) {
      console.error("Failed to set menu button:", err);
    }
  } else {
    await bot.api.setMyCommands([]);
  }
  bot.start();
  console.log("Sol de Mañana is running...");
}

main().catch(console.error);
