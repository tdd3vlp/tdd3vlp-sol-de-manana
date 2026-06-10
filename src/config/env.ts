import { config as loadDotenv } from "dotenv";

loadDotenv();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
  openaiApiKey: requireEnv("OPENAI_API_KEY"),
  openaiModelFree: process.env.OPENAI_MODEL_FREE ?? "gpt-4o-mini",
  openaiModelPaid: process.env.OPENAI_MODEL_PAID ?? "gpt-4o",
  databaseUrl: requireEnv("DATABASE_URL"),
  nodeEnv: process.env.NODE_ENV ?? "development",
  adminTelegramIds: (process.env.ADMIN_TELEGRAM_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  webAppUrl: process.env.WEBAPP_URL ?? "",
} as const;
