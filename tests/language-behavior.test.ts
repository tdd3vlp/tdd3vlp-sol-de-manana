import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSolResponse, makeChat } from "../src/testing/fixtures.js";

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

function stubParse(response: ReturnType<typeof makeSolResponse>) {
  vi.mocked(openai.beta.chat.completions.parse).mockResolvedValue({
    choices: [{ message: { parsed: response } }],
  } as Awaited<ReturnType<typeof openai.beta.chat.completions.parse>>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Spanish input", () => {
  it("returns inputLanguage=spanish with a correction", async () => {
    stubParse(
      makeSolResponse({
        inputLanguage: "spanish",
        // LLM now returns plain text; bolding is added by code in assembleMessage
        correctionOrTranslation: "Quiero ir al supermercado.",
        continuation: "Buena idea. ¿Qué quieres comprar?",
      })
    );
    const result = await callSol("Quiero ir la supermercado.", [], makeChat());
    expect(result.inputLanguage).toBe("spanish");
    expect(result.correctionOrTranslation).toBeTruthy();
  });

  it("makes exactly one API call on success", async () => {
    stubParse(makeSolResponse({ inputLanguage: "spanish" }));
    await callSol("Hola.", [], makeChat());
    expect(openai.beta.chat.completions.parse).toHaveBeenCalledTimes(1);
  });
});

describe("Russian input", () => {
  it("returns inputLanguage=russian with a Spanish translation", async () => {
    stubParse(
      makeSolResponse({
        inputLanguage: "russian",
        correctionOrTranslation: "Quiero alquilar un piso cerca del metro.",
        continuation: "Es una buena prioridad. ¿Prefieres el centro o una zona tranquila?",
      })
    );
    const result = await callSol("Я хочу снять квартиру рядом с метро.", [], makeChat());
    expect(result.inputLanguage).toBe("russian");
    expect(result.correctionOrTranslation).toBeTruthy();
  });
});

describe("Mixed Spanish-Russian input", () => {
  it("returns inputLanguage=mixed with a combined correction", async () => {
    stubParse(
      makeSolResponse({
        inputLanguage: "mixed",
        correctionOrTranslation: "Quiero vivir en España porque me gusta el clima.",
        continuation: "Es una razón estupenda.",
      })
    );
    const result = await callSol(
      "Quiero vivir en España porque мне нравится clima.",
      [],
      makeChat()
    );
    expect(result.inputLanguage).toBe("mixed");
    expect(result.correctionOrTranslation).toBeTruthy();
  });
});

describe("Unsupported language input", () => {
  it("returns inputLanguage=unsupported with no correction or question", async () => {
    stubParse(
      makeSolResponse({
        inputLanguage: "unsupported",
        correctionOrTranslation: null,
        continuation: "Por favor, escribe en español o ruso.",
      })
    );
    const result = await callSol("I want to live in Spain.", [], makeChat());
    expect(result.inputLanguage).toBe("unsupported");
    expect(result.correctionOrTranslation).toBeNull();
  });
});

describe("Short answer — corrects accent and continues", () => {
  it("corrects accent on 'si' and continues naturally", async () => {
    stubParse(
      makeSolResponse({
        inputLanguage: "spanish",
        correctionOrTranslation: "Corrección: Sí.",
        continuation:
          "Entiendo. España tiene muchas ciudades bonitas. Madrid es la capital y tiene mucho que ofrecer. ¿Qué ciudad de España te interesa más?",
      })
    );
    const result = await callSol("si.", [], makeChat());
    expect(result.inputLanguage).toBe("spanish");
    expect(result.correctionOrTranslation).toBeTruthy();
  });
});

describe("Accent correction on nouns", () => {
  it("corrects 'cafe' to 'café'", async () => {
    stubParse(
      makeSolResponse({
        inputLanguage: "spanish",
        correctionOrTranslation: "Corrección: Me gusta el café.",
        continuation:
          "Hay muchos cafés bonitos en España. En Madrid y Barcelona puedes encontrar lugares con mucha historia. ¿Tienes algún café favorito ya?",
      })
    );
    const result = await callSol("Me gusta el cafe.", [], makeChat());
    expect(result.inputLanguage).toBe("spanish");
    expect(result.correctionOrTranslation).toContain("café");
  });

  it("corrects 'ingles' to 'inglés'", async () => {
    stubParse(
      makeSolResponse({
        inputLanguage: "spanish",
        correctionOrTranslation: "Corrección: Hablo inglés y español.",
        continuation:
          "Hablar dos idiomas es una gran ventaja. En España el inglés es muy útil en zonas turísticas. ¿Cuánto tiempo llevas estudiando español?",
      })
    );
    const result = await callSol("Hablo ingles y español.", [], makeChat());
    expect(result.inputLanguage).toBe("spanish");
    expect(result.correctionOrTranslation).toContain("inglés");
  });
});

describe("LLM failure and retry", () => {
  it("retries once on first failure and returns result on second success", async () => {
    vi.mocked(openai.beta.chat.completions.parse)
      .mockRejectedValueOnce(new Error("parse error"))
      .mockResolvedValueOnce({
        choices: [{ message: { parsed: makeSolResponse() } }],
      } as Awaited<ReturnType<typeof openai.beta.chat.completions.parse>>);

    const result = await callSol("Hola.", [], makeChat());
    expect(openai.beta.chat.completions.parse).toHaveBeenCalledTimes(2);
    expect(result.inputLanguage).toBe("spanish");
  });

  it("throws SolServiceError after two failures", async () => {
    vi.mocked(openai.beta.chat.completions.parse)
      .mockRejectedValueOnce(new Error("first fail"))
      .mockRejectedValueOnce(new Error("second fail"));

    await expect(callSol("Hola.", [], makeChat())).rejects.toThrow(SolServiceError);
  });
});
