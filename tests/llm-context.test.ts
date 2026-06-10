import { describe, it, expect } from "vitest";
import { buildLLMContext } from "../src/conversation/context.js";
import { makeMessage, makeSolResponse } from "../src/testing/fixtures.js";

describe("buildLLMContext", () => {
  it("passes user messages through unchanged", () => {
    const result = buildLLMContext([
      makeMessage({ role: "user", text: "Si, me gustaria" }),
    ]);
    expect(result).toEqual([{ role: "user", content: "Si, me gustaria" }]);
  });

  it("uses the clean continuation from llmJson for assistant messages", () => {
    const response = makeSolResponse({
      correctionOrTranslation: "Corrección: Sí, me gustaría.",
      continuation: "¡Qué bien! ¿Adónde quieres ir?",
    });
    const result = buildLLMContext([
      makeMessage({
        role: "assistant",
        text: "Corrección: **Sí**, me **gustaría**.\n\n¡Qué bien! ¿Adónde quieres ir?",
        llmJson: JSON.stringify(response),
      }),
    ]);
    expect(result[0].content).toBe("¡Qué bien! ¿Adónde quieres ir?");
  });

  it("strips prefixes and bold markers when llmJson is missing", () => {
    const result = buildLLMContext([
      makeMessage({
        role: "assistant",
        text: "Corrección: **Sí**, me **gustaría**.\n\n¡Qué bien! ¿Adónde quieres ir?",
        llmJson: null,
      }),
    ]);
    expect(result[0].content).toBe("¡Qué bien! ¿Adónde quieres ir?");
  });

  it("strips En español prefix lines when llmJson is malformed", () => {
    const result = buildLLMContext([
      makeMessage({
        role: "assistant",
        text: "En español: **Quiero alquilar un piso.**\n\nEs una buena prioridad. ¿Dónde buscas?",
        llmJson: "{not json",
      }),
    ]);
    expect(result[0].content).toBe(
      "Es una buena prioridad. ¿Dónde buscas?",
    );
  });

  it("falls back to the stored text without bold markers when stripping empties the message", () => {
    const result = buildLLMContext([
      makeMessage({
        role: "assistant",
        text: "Corrección: **No sé**.",
        llmJson: null,
      }),
    ]);
    expect(result[0].content).toBe("Corrección: No sé.");
  });
});
