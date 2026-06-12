import { Bot } from "grammy";
import { config } from "./config/env.js";
import { registerCommands } from "./bot/commands.js";
import { startWebhookServer } from "./bot/webhookServer.js";
import { prisma } from "./db/prisma.js";

const bot = new Bot(config.telegramBotToken);

registerCommands(bot);

async function notifyErrorChannel(message: string): Promise<void> {
  if (!config.errorChannelId) return;
  try {
    await bot.api.sendMessage(config.errorChannelId, `❌ Sol error: ${message}`);
  } catch {
    // Alerting must never crash the process itself.
  }
}

bot.catch((err) => {
  const message = err.error instanceof Error ? err.error.message : String(err.error);
  console.error("Bot error:", err.error);
  void notifyErrorChannel(message);
});

const server = startWebhookServer(bot);

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

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}, shutting down...`);
  // Force exit after 30 s to prevent hung shutdown.
  setTimeout(() => {
    console.error("Graceful shutdown timed out, forcing exit.");
    process.exit(1);
  }, 30_000).unref();
  server.close();
  await bot.stop();
  await prisma.$disconnect();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((err) => {
  console.error("Fatal startup error:", err);
  void notifyErrorChannel(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
