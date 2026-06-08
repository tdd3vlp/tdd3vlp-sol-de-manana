import { zodResponseFormat } from "openai/helpers/zod";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { openai } from "./openaiClient.js";
import { SolResponseSchema, type SolResponse } from "./schemas.js";
import { buildSystemPrompt, buildStartSystemPrompt } from "../prompts/solSystemPrompt.js";
import { config } from "../config/env.js";
import type { Chat } from "@prisma/client";
import type { LLMMessage } from "../conversation/context.js";

export class SolServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolServiceError";
  }
}

async function attemptParse(
  messages: ChatCompletionMessageParam[]
): Promise<SolResponse> {
  const completion = await openai.beta.chat.completions.parse({
    model: config.openaiModel,
    messages,
    response_format: zodResponseFormat(SolResponseSchema, "sol_response"),
  });
  const parsed = completion.choices[0]?.message?.parsed;
  if (!parsed) throw new Error("Empty parsed response from OpenAI");
  return parsed;
}

export async function translateToRussian(text: string): Promise<string> {
  const response = await openai.chat.completions.create({
    model: config.openaiModel,
    messages: [
      {
        role: "system",
        content:
          "Переведи текст с испанского на русский. Только перевод, без пояснений.",
      },
      { role: "user", content: text },
    ],
    max_tokens: 600,
  });
  return (
    response.choices[0]?.message?.content?.trim() ?? "Перевод недоступен."
  );
}

export async function callSolStart(chat: Chat): Promise<SolResponse> {
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: buildStartSystemPrompt(chat.currentTheme) },
    { role: "user", content: "hola" },
  ];

  const sanitize = (r: SolResponse): SolResponse => ({
    ...r,
    correctionOrTranslation: null,
    reminder: null,
    isTooShort: false,
  });

  try {
    return sanitize(await attemptParse(messages));
  } catch (firstError) {
    console.warn("Start LLM call failed, retrying:", firstError);
    try {
      return sanitize(await attemptParse([
        ...messages,
        {
          role: "user",
          content:
            "Your previous response was invalid. Please respond with valid JSON matching the required schema.",
        },
      ]));
    } catch (retryError) {
      console.error("Start LLM service failed after retry:", retryError);
      throw new SolServiceError("Failed to get a valid start response from the language model");
    }
  }
}

export async function callSol(
  userText: string,
  history: LLMMessage[],
  chat: Chat
): Promise<SolResponse> {
  const systemPrompt = buildSystemPrompt(chat.currentTheme);

  const baseMessages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userText },
  ];

  try {
    return await attemptParse(baseMessages);
  } catch (firstError) {
    console.warn("First LLM call failed, retrying with repair instruction:", firstError);
    try {
      const repairMessages: ChatCompletionMessageParam[] = [
        ...baseMessages,
        {
          role: "user",
          content:
            "Your previous response was invalid. Please respond again with valid JSON that strictly matches the required schema.",
        },
      ];
      return await attemptParse(repairMessages);
    } catch (retryError) {
      console.error("LLM service failed after retry:", retryError);
      throw new SolServiceError("Failed to get a valid response from the language model");
    }
  }
}
