import { describe, it, expect } from "vitest";
import { countSentences } from "../src/conversation/sentenceCounter.js";

describe("countSentences", () => {
  it("returns 0 for empty string", () => {
    expect(countSentences("")).toBe(0);
  });

  it("returns 0 for whitespace-only string", () => {
    expect(countSentences("   ")).toBe(0);
  });

  it("returns 1 for a single sentence without terminator (floor at 1)", () => {
    expect(countSentences("Quiero ir al mercado")).toBe(1);
  });

  it("returns 1 for a single sentence with a period", () => {
    expect(countSentences("Quiero ir al mercado.")).toBe(1);
  });

  it("returns 2 for two sentences separated by period", () => {
    expect(countSentences("Me llamo Juan. Soy de Rusia.")).toBe(2);
  });

  it("returns 3 for three sentences with mixed terminators", () => {
    expect(countSentences("¿Cómo estás? Bien, gracias. ¡Y tú!")).toBe(3);
  });

  it("returns 1 for short valid response 'sí'", () => {
    expect(countSentences("sí")).toBe(1);
  });

  it("returns 1 for short valid response 'no'", () => {
    expect(countSentences("no")).toBe(1);
  });

  it("returns 1 for short valid response 'да' (Russian)", () => {
    expect(countSentences("да")).toBe(1);
  });

  it("returns 1 for short valid response 'vale'", () => {
    expect(countSentences("vale")).toBe(1);
  });

  it("returns 1 for '¡Hola!' (opening + closing punctuation)", () => {
    expect(countSentences("¡Hola!")).toBe(1);
  });

  it("returns 1 for '¿Cómo estás?' (question with opening marker)", () => {
    expect(countSentences("¿Cómo estás?")).toBe(1);
  });

  it("counts newline as a sentence boundary", () => {
    expect(countSentences("Primera línea\nSegunda línea")).toBe(2);
  });

  it("does not count empty lines as sentences", () => {
    expect(countSentences("Hola.\n\nAdiós.")).toBe(2);
  });

  it("returns 1 for text with ellipsis", () => {
    expect(countSentences("Bueno…")).toBe(1);
  });

  it("short valid response is case-insensitive", () => {
    expect(countSentences("SÍ")).toBe(1);
    expect(countSentences("Vale")).toBe(1);
  });
});
