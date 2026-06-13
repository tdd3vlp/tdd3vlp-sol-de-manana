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
  openaiModelTranslate: process.env.OPENAI_MODEL_TRANSLATE ?? "gpt-4o-mini",
  databaseUrl: requireEnv("DATABASE_URL"),
  nodeEnv: process.env.NODE_ENV ?? "development",
  adminTelegramIds: (process.env.ADMIN_TELEGRAM_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  betaTelegramIds: (process.env.BETA_TELEGRAM_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  webAppUrl: process.env.WEBAPP_URL ?? "",
  // Legacy Telegram Payments provider token (kept for reference, no longer used for RUB)
  yookassaProviderToken: process.env.YOOKASSA_PROVIDER_TOKEN ?? "",
  // Direct ЮKassa API (replaces provider token for RUB payments)
  yookassaShopId: process.env.YOOKASSA_SHOP_ID ?? "",
  yookassaSecretKey: process.env.YOOKASSA_SECRET_KEY ?? "",
  yookassaWebhookToken: process.env.YOOKASSA_WEBHOOK_TOKEN ?? "",
  // HTTP server
  port: parseInt(process.env.PORT ?? "3001", 10),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "",
  telegramBotUrl: process.env.TELEGRAM_BOT_URL ?? "",
  // Error alerting: Telegram channel ID to forward critical errors
  errorChannelId: process.env.ERROR_CHANNEL_ID ?? "",
} as const;

if (config.yookassaShopId && !config.yookassaSecretKey) {
  throw new Error("YOOKASSA_SHOP_ID is set but YOOKASSA_SECRET_KEY is missing");
}
if (config.yookassaSecretKey && !config.yookassaShopId) {
  throw new Error("YOOKASSA_SECRET_KEY is set but YOOKASSA_SHOP_ID is missing");
}
