import type { SolResponse } from "../llm/schemas.js";
import type { Chat, Message } from "@prisma/client";

export function makeSolResponse(overrides: Partial<SolResponse> = {}): SolResponse {
  return {
    inputLanguage: "spanish",
    isTooShort: false,
    correctionOrTranslation: null,
    reminder: null,
    continuation: "Buenas. ¿En qué puedo ayudarte hoy?",
    theme: "moving to Spain",
    shouldChangeTheme: false,
    ...overrides,
  };
}

export function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: "chat-1",
    telegramChatId: "123456",
    currentTheme: "moving to Spain",
    themeReplyCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    chatId: "chat-1",
    role: "user",
    text: "Hola, me llamo Juan.",
    llmJson: null,
    createdAt: new Date(),
    ...overrides,
  };
}
