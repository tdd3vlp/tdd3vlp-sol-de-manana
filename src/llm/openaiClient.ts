import OpenAI from "openai";
import { config } from "../config/env.js";

export const openai = new OpenAI({
  apiKey: config.openaiApiKey,
});
