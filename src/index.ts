import { Bot } from "grammy";
import { config } from "./config/env.js";
import { registerCommands } from "./bot/commands.js";
import { startWebhookServer } from "./bot/webhookServer.js";
import { notifyErrorChannel } from "./bot/errorNotifier.js";
import { prisma } from "./db/prisma.js";

const bot = new Bot(config.telegramBotToken);

registerCommands(bot);

bot.catch((err) => {
  const message = err.error instanceof Error ? err.error.message : String(err.error);
  console.error("Bot error:", err.error);
  void notifyErrorChannel(bot, message);
});

const server = startWebhookServer(bot);

async function main() {
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

main().catch(async (err) => {
  console.error("Fatal startup error:", err);
  // Await so the alert is actually delivered before the process dies.
  await notifyErrorChannel(bot, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
