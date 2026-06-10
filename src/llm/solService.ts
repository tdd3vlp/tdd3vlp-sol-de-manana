import { zodResponseFormat } from "openai/helpers/zod";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { openai } from "./openaiClient.js";
import { SolResponseSchema, type SolResponse } from "./schemas.js";
import { buildSystemPrompt, buildStartSystemPrompt } from "../prompts/solSystemPrompt.js";
import { config } from "../config/env.js";
import { getPlanModel } from "../subscription/plans.js";
import type { Chat } from "@prisma/client";
import type { LLMMessage } from "../conversation/context.js";
import { isNonsense, isLikelyUnsupported } from "../conversation/language.js";

export class SolServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolServiceError";
  }
}

async function attemptParse(
  messages: ChatCompletionMessageParam[],
  model: string
): Promise<SolResponse> {
  const completion = await openai.beta.chat.completions.parse({
    model,
    messages,
    // The JSON payload carries a 3-sentence continuation plus its Russian
    // translation (Cyrillic tokenizes at ~2-3 tokens/word) and a correction.
    // A tight cap truncates the JSON and the whole structured parse fails.
    response_format: zodResponseFormat(SolResponseSchema, "sol_response"),
    max_tokens: 500,
  });
  const parsed = completion.choices[0]?.message?.parsed;
  if (!parsed) throw new Error("Empty parsed response from OpenAI");
  if (config.nodeEnv !== "production")
    console.log(`[LLM ${model}]`, JSON.stringify(parsed));
  return parsed;
}

// Detects cases where Zod parsing succeeded syntactically but the response
// contains the word "null" as literal text in string fields — a model artifact
// caused by the schema using nullable fields.
function hasNullArtifacts(r: SolResponse): boolean {
  const nullValue = /^\s*:?null[,.]?\s*$/i;
  const nullLine = /(?:^|\n)\s*:?null[,.]?\s*(?:\n|$)/i;
  if (typeof r.correctionOrTranslation === "string" && nullValue.test(r.correctionOrTranslation)) return true;
  if (nullLine.test(r.continuation)) return true;
  if (typeof r.russianTranslation === "string" && nullValue.test(r.russianTranslation)) return true;
  return false;
}

export async function translateBidirectional(
  text: string,
  model: string
): Promise<{ translation: string; direction: "ru→es" | "es→ru" }> {
  const cyrillicCount = (text.match(/[а-яёА-ЯЁ]/g) ?? []).length;
  const latinCount = (text.match(/[a-zA-ZáéíóúüñÁÉÍÓÚÜÑ]/g) ?? []).length;
  const isRussian = cyrillicCount >= latinCount;

  const systemPrompt = isRussian
    ? "Переведи текст с русского на испанский (Испания, разговорный стиль). Только перевод, без пояснений."
    : "Переведи текст с испанского на русский. Только перевод, без пояснений.";

  const response = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ],
  });

  return {
    translation: response.choices[0]?.message?.content?.trim() ?? "Перевод недоступен.",
    direction: isRussian ? "ru→es" : "es→ru",
  };
}

export async function translateToRussian(text: string, model: string): Promise<string> {
  const response = await openai.chat.completions.create({
    model,
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

export async function callSolStart(
  chat: Chat,
  model: string = getPlanModel(chat.plan),
): Promise<SolResponse> {
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: buildStartSystemPrompt(chat.currentTheme) },
    { role: "user", content: "hola" },
  ];

  const sanitize = (r: SolResponse): SolResponse => ({
    ...r,
    correctionOrTranslation: null,
  });

  try {
    return sanitize(await attemptParse(messages, model));
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
      ], model));
    } catch (retryError) {
      console.error("Start LLM service failed after retry:", retryError);
      throw new SolServiceError("Failed to get a valid start response from the language model");
    }
  }
}

export async function callSol(
  userText: string,
  history: LLMMessage[],
  chat: Chat,
  model: string = getPlanModel(chat.plan),
): Promise<SolResponse> {
  const nonsense = isNonsense(userText);
  if (nonsense || isLikelyUnsupported(userText)) {
    return {
      inputLanguage: nonsense ? "nonsense" : "unsupported",
      correctionOrTranslation: null,
      continuation: "Por favor, escribe en español o ruso para que podamos continuar.",
      russianTranslation: null,
      theme: chat.currentTheme,
    };
  }

  const baseMessages: ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(chat.currentTheme) },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userText },
  ];

  try {
    const first = await attemptParse(baseMessages, model);
    if (hasNullArtifacts(first)) throw new Error("Semantic validation: null artifacts in response");
    return first;
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
      const retry = await attemptParse(repairMessages, model);
      if (hasNullArtifacts(retry)) throw new Error("Semantic validation: null artifacts in retry response");
      return retry;
    } catch (retryError) {
      console.error("LLM service failed after retry:", retryError);
      throw new SolServiceError("Failed to get a valid response from the language model");
    }
  }
}
