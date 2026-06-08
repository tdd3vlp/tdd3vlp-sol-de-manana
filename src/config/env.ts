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
  openaiModel: process.env.OPENAI_MODEL ?? "gpt-4o",
  databaseUrl: requireEnv("DATABASE_URL"),
  nodeEnv: process.env.NODE_ENV ?? "development",
} as const;
