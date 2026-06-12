import type { Bot } from "grammy";
import type { Context } from "grammy";
import { config } from "../config/env.js";

export async function notifyErrorChannel(
  bot: Bot<Context>,
  message: string,
): Promise<void> {
  if (!config.errorChannelId) return;
  try {
    await bot.api.sendMessage(config.errorChannelId, `❌ Sol error: ${message}`);
  } catch {
    // Alerting must never crash the process itself.
  }
}
