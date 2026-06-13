import { zodResponseFormat } from "openai/helpers/zod";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { openai } from "./openaiClient.js";
import {
  DailyPracticeResponseSchema,
  DailyPracticeHighlightsSchema,
  type DailyPracticeResponse,
  type DailyPracticeHighlights,
} from "./dailyPracticeSchemas.js";
import {
  buildDailyPracticeStartPrompt,
  buildDailyPracticePrompt,
  buildDailyPracticeFinalePrompt,
} from "../prompts/dailyPracticeSystemPrompt.js";
import {
  wrapCurrentUserMessage,
  stripCurrentMessageTags,
  CURRENT_MESSAGE_TAG,
} from "../prompts/solSystemPrompt.js";
import { config } from "../config/env.js";
import { SolServiceError } from "./solService.js";
import type { PracticeSession } from "@prisma/client";
import type { LLMMessage } from "../conversation/context.js";
import { CHALLENGE_DAY_LABELS } from "../conversation/challengeThemes.js";

const NULL_LIKE_RE =
  /^[/:]?(?:null|spanish|russian|mixed|unsupported|nonsense)[/,.:;]?$/i;

function normalizeNullable(s: string | null): string | null {
  if (s === null || s === "" || NULL_LIKE_RE.test(s)) return null;
  return s;
}

const GENERIC_REPAIR =
  `Your previous response was invalid. Respond again with valid JSON that strictly matches the required schema. The <${CURRENT_MESSAGE_TAG}> above is still the only user input to process.`;

async function parsePracticeResponse(
  messages: ChatCompletionMessageParam[],
  model: string,
): Promise<DailyPracticeResponse> {
  const completion = await openai.beta.chat.completions.parse({
    model,
    messages,
    response_format: zodResponseFormat(DailyPracticeResponseSchema, "daily_practice_response"),
    max_tokens: 350,
  });
  const parsed = completion.choices[0]?.message?.parsed;
  if (!parsed) throw new Error("Empty parsed response from OpenAI");
  if (config.nodeEnv !== "production")
    console.log(`[DailyPractice ${model}]`, JSON.stringify(parsed));
  return {
    ...parsed,
    correctionOrTranslation: normalizeNullable(
      parsed.correctionOrTranslation === null
        ? null
        : stripCurrentMessageTags(parsed.correctionOrTranslation).trim(),
    ),
    continuation: stripCurrentMessageTags(parsed.continuation).trim(),
  };
}

export async function callDailyPracticeStart(
  session: PracticeSession,
  model: string,
): Promise<string> {
  const dayLabel = CHALLENGE_DAY_LABELS[session.dayNumber] ?? `День ${session.dayNumber}`;
  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: buildDailyPracticeStartPrompt(session.theme, session.dayNumber, dayLabel),
    },
    { role: "user", content: "начнём" },
  ];

  try {
    const completion = await openai.beta.chat.completions.parse({
      model,
      messages,
      response_format: zodResponseFormat(DailyPracticeResponseSchema, "daily_practice_response"),
      max_tokens: 200,
    });
    const parsed = completion.choices[0]?.message?.parsed;
    return parsed?.continuation?.trim() ?? "¡Hola! ¿Estás listo para practicar hoy?";
  } catch (err) {
    console.warn("callDailyPracticeStart failed, using fallback:", err);
    return "¡Hola! ¿Estás listo para practicar hoy?";
  }
}

export async function callDailyPractice(
  userText: string,
  history: LLMMessage[],
  session: PracticeSession,
  model: string,
): Promise<DailyPracticeResponse> {
  const baseMessages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: buildDailyPracticePrompt(session.theme, session.stepCount),
    },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: wrapCurrentUserMessage(userText) },
  ];

  try {
    return await parsePracticeResponse(baseMessages, model);
  } catch (firstError) {
    console.warn("DailyPractice first attempt failed, retrying:", firstError);
    try {
      return await parsePracticeResponse(
        [...baseMessages, { role: "user", content: GENERIC_REPAIR }],
        model,
      );
    } catch (retryError) {
      console.error("DailyPractice failed after retry:", retryError);
      throw new SolServiceError("Failed to get a valid daily practice response from the language model");
    }
  }
}

const FALLBACK_HIGHLIGHTS: DailyPracticeHighlights = {
  phrases: [],
  corrections: [],
  encouragement: "Отличная работа сегодня!",
};

export async function callDailyPracticeFinale(
  history: LLMMessage[],
  session: PracticeSession,
  model: string,
): Promise<DailyPracticeHighlights> {
  const dayLabel = CHALLENGE_DAY_LABELS[session.dayNumber] ?? `День ${session.dayNumber}`;
  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: buildDailyPracticeFinalePrompt(session.theme, dayLabel),
    },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: "Подведи итог сессии." },
  ];

  try {
    const completion = await openai.beta.chat.completions.parse({
      model,
      messages,
      response_format: zodResponseFormat(DailyPracticeHighlightsSchema, "daily_practice_highlights"),
      max_tokens: 400,
    });
    const parsed = completion.choices[0]?.message?.parsed;
    if (!parsed) return FALLBACK_HIGHLIGHTS;
    if (config.nodeEnv !== "production")
      console.log(`[DailyPracticeFinale ${model}]`, JSON.stringify(parsed));
    return parsed;
  } catch (firstError) {
    console.warn("DailyPracticeFinale first attempt failed, retrying:", firstError);
    try {
      const retry = await openai.beta.chat.completions.parse({
        model,
        messages: [
          ...messages,
          {
            role: "user",
            content:
              "Your previous response was invalid. Return valid JSON matching the required schema with phrases, corrections, and encouragement fields.",
          },
        ],
        response_format: zodResponseFormat(DailyPracticeHighlightsSchema, "daily_practice_highlights"),
        max_tokens: 400,
      });
      return retry.choices[0]?.message?.parsed ?? FALLBACK_HIGHLIGHTS;
    } catch (retryError) {
      console.error("DailyPracticeFinale failed after retry:", retryError);
      return FALLBACK_HIGHLIGHTS;
    }
  }
}
