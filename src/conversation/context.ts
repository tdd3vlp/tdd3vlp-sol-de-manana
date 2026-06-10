import type { Message } from "@prisma/client";

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

// Assistant rows store the final formatted bot message — with "Corrección:" /
// "En español:" prefixes and **bold** markers. Feeding that back to the model
// contradicts the prompt's plain-text rules and teaches it to imitate the
// formatting, so the context uses the clean continuation from llmJson instead.
// The correction line is not needed in history: the user's original message
// with its mistakes is already there.
function assistantContent(m: Message): string {
  if (m.llmJson) {
    try {
      const parsed = JSON.parse(m.llmJson) as { continuation?: unknown };
      if (typeof parsed.continuation === "string" && parsed.continuation.trim()) {
        return parsed.continuation;
      }
    } catch {
      // malformed llmJson — fall through to stripping the stored text
    }
  }
  const stripped = m.text
    .split("\n\n")
    .filter((p) => !/^\s*(?:Corrección|En español):/i.test(p))
    .join("\n\n")
    .replace(/\*\*/g, "")
    .trim();
  return stripped || m.text.replace(/\*\*/g, "").trim();
}

export function buildLLMContext(messages: Message[]): LLMMessage[] {
  return messages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.role === "assistant" ? assistantContent(m) : m.text,
  }));
}
