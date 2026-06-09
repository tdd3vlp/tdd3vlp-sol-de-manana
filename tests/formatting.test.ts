import { describe, it, expect } from "vitest";
import { makeSolResponse } from "../src/testing/fixtures.js";
import { shouldChangeTheme } from "../src/conversation/themes.js";
import { removeFalseBold, assembleMessage } from "../src/bot/handlers.js";

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

describe("removeFalseBold", () => {
  it("strips bold from a word that appears unchanged in the user input", () => {
    expect(removeFalseBold("Me gustan las **fiestas**.", "Me gustan las fiestas.")).toBe(
      "Me gustan las fiestas."
    );
  });

  it("preserves bold when the corrected word differs by accent mark", () => {
    expect(removeFalseBold("**Sí**, quiero ir.", "si, quiero ir.")).toBe(
      "**Sí**, quiero ir."
    );
  });

  it("preserves bold when the corrected word is genuinely different", () => {
    expect(removeFalseBold("Quiero **ir** al mercado.", "Quiero ir al mercado.")).toBe(
      "Quiero ir al mercado."
    );
    // "ir" appears in user input unchanged — should be stripped
    expect(removeFalseBold("Quiero **comprar** fruta.", "Quiero ir al mercado.")).toBe(
      "Quiero **comprar** fruta."
    );
  });

  it("handles multiple bold tokens, stripping only false ones", () => {
    const result = removeFalseBold(
      "Quiero **comprar** **fiestas** en el mercado.",
      "Quiero ir fiestas en el mercado."
    );
    expect(result).toBe("Quiero **comprar** fiestas en el mercado.");
  });

  it("is case-insensitive when comparing", () => {
    expect(removeFalseBold("**Hola** amigo.", "hola amigo.")).toBe("Hola amigo.");
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
