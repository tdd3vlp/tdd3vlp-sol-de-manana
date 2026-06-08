import type { Message } from "@prisma/client";

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export function buildLLMContext(messages: Message[]): LLMMessage[] {
  return messages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.text,
  }));
}
