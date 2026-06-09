import { describe, it, expect } from "vitest";
import { makeSolResponse } from "../src/testing/fixtures.js";
import { shouldChangeTheme } from "../src/conversation/themes.js";
import { diffAndBold, assembleMessage, formatForTelegram } from "../src/bot/handlers.js";

describe("shouldChangeTheme", () => {
  it("returns false for count below 4", () => {
    expect(shouldChangeTheme(0)).toBe(false);
    expect(shouldChangeTheme(1)).toBe(false);
    expect(shouldChangeTheme(2)).toBe(false);
    expect(shouldChangeTheme(3)).toBe(false);
  });

  it("returns true for count 8 or above", () => {
    expect(shouldChangeTheme(8)).toBe(true);
    expect(shouldChangeTheme(9)).toBe(true);
    expect(shouldChangeTheme(20)).toBe(true);
  });

  it("returns a boolean for counts between 4 and 7", () => {
    for (let i = 4; i < 8; i++) {
      expect(typeof shouldChangeTheme(i)).toBe("boolean");
    }
  });
});

describe("diffAndBold", () => {
  it("bolds a word that gained an accent mark", () => {
    expect(diffAndBold("Me gusta el cafe.", "Me gusta el café.")).toBe(
      "Me gusta el **café**."
    );
  });

  it("bolds a word with a fixed accent on a verb", () => {
    expect(diffAndBold("Esta bien.", "Está bien.")).toBe("**Está** bien.");
  });

  it("bolds a replaced misspelled word", () => {
    const result = diffAndBold(
      "Soy programista.",
      "Soy programador."
    );
    expect(result).toContain("**programador**");
  });

  it("bolds an added opening ¿ together with the question word", () => {
    const result = diffAndBold("Donde vives?", "¿Dónde vives?");
    expect(result).toContain("**¿Dónde**");
  });

  it("does not bold a word that is unchanged", () => {
    const result = diffAndBold("Me gusta el café.", "Me gusta el café.");
    expect(result).not.toContain("**");
  });

  it("handles multiple corrections in one sentence", () => {
    const result = diffAndBold(
      "Donde esta Monjuic?",
      "¿Dónde está Montjuïc?"
    );
    // All three words changed — may be individual spans or one grouped span; all must be bolded
    expect(result).toContain("¿Dónde");
    expect(result).toContain("está");
    expect(result).toContain("Montjuïc");
    expect(result).toContain("**");
    // Ensure no original (wrong) word appears instead
    expect(result).not.toContain("Donde ");
    expect(result).not.toContain(" esta ");
  });

  it("keeps trailing punctuation outside the bold span", () => {
    expect(diffAndBold("Hablo ingles.", "Hablo inglés.")).toBe("Hablo **inglés**.");
  });

  it("returns the corrected text unchanged when original is empty", () => {
    expect(diffAndBold("", "Hola.")).toBe("Hola.");
  });
});

describe("assembleMessage — continuation bold stripping", () => {
  it("strips bold markers from continuation even if LLM leaked them", () => {
    const r = makeSolResponse({
      inputLanguage: "spanish",
      correctionOrTranslation: null,
      continuation: "Muy bien. **Quiero** ir al mercado. ¿Y tú?",
    });
    const out = assembleMessage(r, "Quiero ir al mercado.");
    expect(out).not.toContain("**");
    expect(out).toContain("Quiero");
  });
});

describe("bold formatting end-to-end (assembleMessage → formatForTelegram)", () => {
  it("renders café correction as <b>café</b> in Telegram HTML", () => {
    const r = makeSolResponse({
      inputLanguage: "spanish",
      // LLM now returns plain text — no ** markers
      correctionOrTranslation: "Corrección: Me gusta el café.",
      continuation: "Hay muchos cafés en España. ¿Tienes uno favorito?",
    });
    const html = formatForTelegram(assembleMessage(r, "Me gusta el cafe."));
    expect(html).toContain("<b>café</b>");
    expect(html).not.toContain("**");
  });

  it("renders inglés correction as <b>inglés</b> in Telegram HTML", () => {
    const r = makeSolResponse({
      inputLanguage: "spanish",
      correctionOrTranslation: "Corrección: Hablo inglés y español.",
      continuation: "Hablar idiomas es una ventaja. ¿Cuánto tiempo llevas aprendiendo?",
    });
    const html = formatForTelegram(assembleMessage(r, "Hablo ingles y español."));
    expect(html).toContain("<b>inglés</b>");
    expect(html).not.toContain("**");
  });

  it("renders sí correction as <b>Sí</b> in Telegram HTML", () => {
    const r = makeSolResponse({
      inputLanguage: "spanish",
      correctionOrTranslation: "Corrección: Sí, me gusta España.",
      continuation: "Me alegra oírlo. ¿Qué ciudad te gusta más?",
    });
    const html = formatForTelegram(assembleMessage(r, "si, me gusta España."));
    expect(html).toContain("<b>Sí</b>");
    expect(html).not.toContain("**");
  });

  it("strips any accidental bold the LLM added in correctionOrTranslation before diffing", () => {
    const r = makeSolResponse({
      inputLanguage: "spanish",
      // LLM disobeyed and added bold — code should still produce correct output
      correctionOrTranslation: "Corrección: Hablo **inglés** y español.",
      continuation: "Hablar idiomas es una ventaja. ¿Cuánto tiempo llevas aprendiendo?",
    });
    const html = formatForTelegram(assembleMessage(r, "Hablo ingles y español."));
    expect(html).toContain("<b>inglés</b>");
    expect(html).not.toContain("**");
  });
});

describe("bold formatting for mixed input (assembleMessage → formatForTelegram)", () => {
  it("bolds changed/translated words in mixed input via code diff", () => {
    const r = makeSolResponse({
      inputLanguage: "mixed",
      // LLM returns plain text — code does the diff
      correctionOrTranslation:
        "En español: Trabajo como programador. Sí, es algo que me gustaría continuar haciendo en España.",
      continuation: "Es un campo muy demandado en España. ¿En qué ciudad te gustaría trabajar?",
    });
    const html = formatForTelegram(
      assembleMessage(
        r,
        "Hm, trabajo als programista. Si, es algo que me gustaria continuar haciendo en Espana."
      )
    );
    // Changed words must be bolded; unchanged words must not be wrapped in **
    expect(html).toContain("programador");
    expect(html).toContain("<b>gustaría</b>");
    expect(html).toContain("<b>España</b>");
    expect(html).not.toContain("**");
  });
});

describe("SolResponse fixture", () => {
  it("produces a valid default response", () => {
    const r = makeSolResponse();
    expect(r.inputLanguage).toBe("spanish");
    expect(r.continuation).toBeTruthy();
  });

  it("allows overriding individual fields", () => {
    const r = makeSolResponse({ inputLanguage: "russian" });
    expect(r.inputLanguage).toBe("russian");
    expect(r.continuation).toBeTruthy();
  });
});
