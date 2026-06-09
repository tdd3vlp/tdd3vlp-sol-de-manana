import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSolResponse, makeChat } from "../src/testing/fixtures.js";
import { assembleMessage } from "../src/bot/handlers.js";

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
import { callSol } from "../src/llm/solService.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Semantic validation (null artifact detection)", () => {
  it("retries when correctionOrTranslation is the string 'null'", async () => {
    const bad = makeSolResponse({
      correctionOrTranslation: "null",
      continuation: "Buena idea.",
    });
    const good = makeSolResponse({
      correctionOrTranslation: null,
      continuation: "Buena idea.",
    });
    vi.mocked(openai.beta.chat.completions.parse)
      .mockResolvedValueOnce({ choices: [{ message: { parsed: bad } }] } as Awaited<ReturnType<typeof openai.beta.chat.completions.parse>>)
      .mockResolvedValueOnce({ choices: [{ message: { parsed: good } }] } as Awaited<ReturnType<typeof openai.beta.chat.completions.parse>>);

    const result = await callSol("Hola", [], makeChat());
    expect(openai.beta.chat.completions.parse).toHaveBeenCalledTimes(2);
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
