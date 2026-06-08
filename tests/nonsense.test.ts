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

  it("assembled message contains only the continuation warning", async () => {
    const warning = "Por favor, escribe en español o ruso.";
    const response = makeSolResponse({
      inputLanguage: "nonsense",
      correctionOrTranslation: null,
      reminder: null,
      continuation: warning,
    });
    vi.mocked(openai.beta.chat.completions.parse).mockResolvedValue({
      choices: [{ message: { parsed: response } }],
    } as Awaited<ReturnType<typeof openai.beta.chat.completions.parse>>);

    const result = await callSol("???", [], makeChat());
    expect(assembleMessage(result)).toBe(warning);
  });
});
