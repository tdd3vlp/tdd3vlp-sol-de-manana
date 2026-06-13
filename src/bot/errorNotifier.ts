import type { Bot } from "grammy";
import type { Context } from "grammy";
import { config } from "../config/env.js";

// Structural subset of grammy's Api so both bot.api and ctx.api fit.
export interface SendMessageApi {
  sendMessage(
    chatId: string | number,
    text: string,
    other?: Record<string, unknown>,
  ): Promise<unknown>;
}

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

const INPUT_PREVIEW_LIMIT = 200;

export interface UserVisibleErrorReport {
  handler: string;
  error: unknown;
  telegramChatId?: string;
  telegramUserId?: string;
  plan?: string;
  mode?: string;
  inputPreview?: string;
  // "warning" = the user got their answer, only background work failed.
  severity?: "error" | "warning";
}

export async function reportUserVisibleError(
  api: SendMessageApi,
  report: UserVisibleErrorReport,
): Promise<void> {
  if (!config.errorChannelId) return;
  const errorText =
    report.error instanceof Error
      ? `${report.error.name}: ${report.error.message}`
      : String(report.error);
  const lines = [
    report.severity === "warning"
      ? "⚠️ Sol error (user unaffected)"
      : "❌ Sol user-visible error",
    `handler: ${report.handler}`,
    report.telegramChatId && `chat: ${report.telegramChatId}`,
    report.telegramUserId && `user: ${report.telegramUserId}`,
    report.plan && `plan: ${report.plan}`,
    report.mode && `mode: ${report.mode}`,
    `error: ${errorText}`,
    report.inputPreview &&
      `input: "${report.inputPreview.slice(0, INPUT_PREVIEW_LIMIT)}"`,
  ].filter(Boolean);
  try {
    await api.sendMessage(config.errorChannelId, lines.join("\n"));
  } catch {
    // Alerting must never crash the process itself.
  }
}
