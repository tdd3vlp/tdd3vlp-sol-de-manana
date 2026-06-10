import OpenAI from "openai";
import { config } from "../config/env.js";

export const openai = new OpenAI({
  apiKey: config.openaiApiKey,
  // Keep a chat-bot-sized budget: the SDK default is 10 minutes with 2
  // retries. solService has its own retry layer, so disable SDK retries
  // to avoid retry-times-retry amplification.
  timeout: 30_000,
  maxRetries: 0,
});
