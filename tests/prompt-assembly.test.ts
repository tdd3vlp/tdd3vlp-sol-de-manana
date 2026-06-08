import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../src/prompts/solSystemPrompt.js";
import { THEMES } from "../src/conversation/themes.js";

describe("buildSystemPrompt", () => {
  it("includes the current theme", () => {
    const prompt = buildSystemPrompt("supermarket");
    expect(prompt).toContain("supermarket");
  });

  it("includes all language behavior categories", () => {
    const prompt = buildSystemPrompt("cafe or restaurant");
    expect(prompt).toContain("spanish");
    expect(prompt).toContain("russian");
    expect(prompt).toContain("mixed");
    expect(prompt).toContain("unsupported");
    expect(prompt).toContain("nonsense");
  });

  it("includes the short-answer reminder text verbatim", () => {
    const prompt = buildSystemPrompt("supermarket");
    expect(prompt).toContain(
      "Рекомендуем отвечать полными предложениями, так как это способствует изучению языка 🙂"
    );
  });

  it("instructs to respond in JSON", () => {
    const prompt = buildSystemPrompt("supermarket");
    expect(prompt).toContain("JSON");
  });

  it("names all required schema fields", () => {
    const prompt = buildSystemPrompt("supermarket");
    expect(prompt).toContain("inputLanguage");
    expect(prompt).toContain("isTooShort");
    expect(prompt).toContain("correctionOrTranslation");
    expect(prompt).toContain("continuation");
    expect(prompt).toContain("shouldChangeTheme");
  });

  it("instructs to use bold markers for corrections", () => {
    const prompt = buildSystemPrompt("supermarket");
    expect(prompt).toContain("double asterisks");
  });

  it("works correctly with every theme in the list", () => {
    for (const theme of THEMES) {
      const prompt = buildSystemPrompt(theme);
      expect(prompt).toContain(theme);
    }
  });
});
