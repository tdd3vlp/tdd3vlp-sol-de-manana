import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSolResponse, makeChat } from "../src/testing/fixtures.js";
import { assembleMessage } from "../src/bot/handlers.js";
import { isNonsense } from "../src/conversation/language.js";

vi.mock("../src/config/env.js", () => ({
  config: {
    telegramBotToken: "test-token",
    openaiApiKey: "test-key",
    openaiModel: "gpt-4o",
    databaseUrl: "postgresql://test",
    nodeEnv: "test",
  },
}));

vi.mock("../src/llm/openaiClient.js", () => ({
  openai: {
    beta: {
      chat: {
        completions: {
          parse: vi.fn(),
        },
      },
    },
  },
}));

import { openai } from "../src/llm/openaiClient.js";
import { callSol, SolServiceError } from "../src/llm/solService.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isNonsense pre-filter", () => {
  it.each([
    "asdfghjkl",
    "qwrtpsdfg",
    "12345",
    "!!! ???",
    "...",
    "🎉🎉🎉",
    "   ",
  ])("classifies %j as nonsense", (input) => {
    expect(isNonsense(input)).toBe(true);
  });

  it.each([
    "Hola",
    "sí",
    "yo",
    "no",
    "нет",
    "да",
    "Quiero ir al mercado",
    "Я хочу учить испанский",
    "Vivo en Madrid",
  ])("classifies %j as not nonsense", (input) => {
    expect(isNonsense(input)).toBe(false);
  });

  it("callSol returns nonsense response without calling OpenAI", async () => {
    const result = await callSol("asdfghjkl 12345 !!!", [], makeChat());
    expect(openai.beta.chat.completions.parse).not.toHaveBeenCalled();
    expect(result.inputLanguage).toBe("nonsense");
    expect(result.correctionOrTranslation).toBeNull();
  });
});

describe("Semantic validation (null artifact detection)", () => {
  it("normalizes correctionOrTranslation: string 'null' to null without retry", async () => {
    vi.mocked(openai.beta.chat.completions.parse).mockResolvedValueOnce({
      choices: [{ message: { parsed: makeSolResponse({ correctionOrTranslation: "null", continuation: "Buena idea." }) } }],
    } as Awaited<ReturnType<typeof openai.beta.chat.completions.parse>>);

    const result = await callSol("Hola", [], makeChat());
    expect(openai.beta.chat.completions.parse).toHaveBeenCalledTimes(1);
    expect(result.correctionOrTranslation).toBeNull();
  });

  it("normalizes correctionOrTranslation: string '/null/' to null without retry", async () => {
    vi.mocked(openai.beta.chat.completions.parse).mockResolvedValueOnce({
      choices: [{ message: { parsed: makeSolResponse({ correctionOrTranslation: "/null/", continuation: "La paella es un plato típico. ¿Cuál prefieres?" }) } }],
    } as Awaited<ReturnType<typeof openai.beta.chat.completions.parse>>);

    const result = await callSol("La paella", [], makeChat());
    expect(openai.beta.chat.completions.parse).toHaveBeenCalledTimes(1);
    expect(result.correctionOrTranslation).toBeNull();
  });

  it("retries when continuation starts with a null artifact line", async () => {
    const bad = makeSolResponse({
      correctionOrTranslation: null,
      continuation: "null\n\nBuena idea. ¿Qué tal?",
    });
    const good = makeSolResponse({
      correctionOrTranslation: null,
      continuation: "Buena idea. ¿Qué tal?",
    });
    vi.mocked(openai.beta.chat.completions.parse)
      .mockResolvedValueOnce({ choices: [{ message: { parsed: bad } }] } as Awaited<ReturnType<typeof openai.beta.chat.completions.parse>>)
      .mockResolvedValueOnce({ choices: [{ message: { parsed: good } }] } as Awaited<ReturnType<typeof openai.beta.chat.completions.parse>>);

    const result = await callSol("Hola", [], makeChat());
    expect(openai.beta.chat.completions.parse).toHaveBeenCalledTimes(2);
    expect(result.continuation).toBe("Buena idea. ¿Qué tal?");
  });
});

describe("Semantic validation (Cyrillic in correction)", () => {
  it("retries with a Cyrillic-specific repair instruction", async () => {
    const bad = makeSolResponse({
      inputLanguage: "mixed",
      correctionOrTranslation: "En español: No tengo preguntas - это была опечатка",
      continuation: "Entiendo. ¿Algo más?",
    });
    const good = makeSolResponse({
      inputLanguage: "mixed",
      correctionOrTranslation: "En español: No tengo preguntas — fue una errata.",
      continuation: "Entiendo. ¿Algo más?",
    });
    vi.mocked(openai.beta.chat.completions.parse)
      .mockResolvedValueOnce({ choices: [{ message: { parsed: bad } }] } as Awaited<ReturnType<typeof openai.beta.chat.completions.parse>>)
      .mockResolvedValueOnce({ choices: [{ message: { parsed: good } }] } as Awaited<ReturnType<typeof openai.beta.chat.completions.parse>>);

    const result = await callSol("Tengo NO preguntas - это была опечатка", [], makeChat());

    expect(openai.beta.chat.completions.parse).toHaveBeenCalledTimes(2);
    expect(result.correctionOrTranslation).toBe(
      "En español: No tengo preguntas — fue una errata."
    );

    const retryCall = vi.mocked(openai.beta.chat.completions.parse).mock.calls[1][0];
    const repair = retryCall.messages[retryCall.messages.length - 1];
    expect(repair.content).toContain("contained Cyrillic characters");
    expect(repair.content).toContain("zero Cyrillic characters");
  });

  it("throws SolServiceError when Cyrillic persists after retry", async () => {
    const bad = makeSolResponse({
      inputLanguage: "mixed",
      correctionOrTranslation: "En español: No tengo preguntas - это была опечатка",
      continuation: "Entiendo.",
    });
    vi.mocked(openai.beta.chat.completions.parse).mockResolvedValue({
      choices: [{ message: { parsed: bad } }],
    } as Awaited<ReturnType<typeof openai.beta.chat.completions.parse>>);

    await expect(
      callSol("Tengo NO preguntas - это была опечатка", [], makeChat())
    ).rejects.toThrow(SolServiceError);
    expect(openai.beta.chat.completions.parse).toHaveBeenCalledTimes(2);
  });
});

describe("Nonsense input", () => {
  it("returns inputLanguage=nonsense with null correction", async () => {
    const response = makeSolResponse({
      inputLanguage: "nonsense",
      correctionOrTranslation: null,
      continuation: "Por favor, escribe algo en español o ruso.",
    });
    vi.mocked(openai.beta.chat.completions.parse).mockResolvedValue({
      choices: [{ message: { parsed: response } }],
    } as Awaited<ReturnType<typeof openai.beta.chat.completions.parse>>);

    const result = await callSol("asdfghjkl qwerty 123!!!", [], makeChat());

    expect(result.inputLanguage).toBe("nonsense");
    expect(result.correctionOrTranslation).toBeNull();
  });

  it("does not add bold markers or corrections to nonsense response", async () => {
    const response = makeSolResponse({
      inputLanguage: "nonsense",
      correctionOrTranslation: null,
      continuation: "No entiendo. Por favor, escribe en español o ruso.",
    });
    vi.mocked(openai.beta.chat.completions.parse).mockResolvedValue({
      choices: [{ message: { parsed: response } }],
    } as Awaited<ReturnType<typeof openai.beta.chat.completions.parse>>);

    const result = await callSol("xkcd foo bar baz", [], makeChat());
    const text = assembleMessage(result);

    expect(text).not.toContain("**");
    expect(text).not.toContain("<b>");
  });

  it("assembled message contains the fixed Spanish warning regardless of LLM continuation", async () => {
    const response = makeSolResponse({
      inputLanguage: "nonsense",
      correctionOrTranslation: null,
      continuation: "anything from the LLM",
    });
    vi.mocked(openai.beta.chat.completions.parse).mockResolvedValue({
      choices: [{ message: { parsed: response } }],
    } as Awaited<ReturnType<typeof openai.beta.chat.completions.parse>>);

    const result = await callSol("???", [], makeChat());
    expect(assembleMessage(result)).toBe(
      "Por favor, escribe en español o ruso para que podamos continuar."
    );
  });
});
