import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/config/env.js", () => ({
  config: { errorChannelId: "777" },
}));

import { config } from "../src/config/env.js";
import { reportUserVisibleError } from "../src/bot/errorNotifier.js";

const sendMessage = vi.fn().mockResolvedValue({});
const api = { sendMessage };

beforeEach(() => {
  vi.clearAllMocks();
  (config as { errorChannelId: string }).errorChannelId = "777";
});

describe("reportUserVisibleError", () => {
  it("sends a structured report with all provided fields", async () => {
    await reportUserVisibleError(api, {
      handler: "handleMessage",
      error: new Error("LLM exploded"),
      telegramChatId: "123",
      telegramUserId: "456",
      plan: "free",
      mode: "dialogue",
      inputPreview: "No se, 1000€?",
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendMessage.mock.calls[0];
    expect(chatId).toBe("777");
    expect(text).toContain("❌ Sol user-visible error");
    expect(text).toContain("handler: handleMessage");
    expect(text).toContain("chat: 123");
    expect(text).toContain("user: 456");
    expect(text).toContain("plan: free");
    expect(text).toContain("mode: dialogue");
    expect(text).toContain("error: Error: LLM exploded");
    expect(text).toContain('input: "No se, 1000€?"');
  });

  it("omits missing fields instead of printing undefined", async () => {
    await reportUserVisibleError(api, {
      handler: "enterDialogueMode",
      error: "boom",
    });
    const [, text] = sendMessage.mock.calls[0];
    expect(text).toContain("error: boom");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("chat:");
    expect(text).not.toContain("input:");
  });

  it("marks warning severity as user-unaffected", async () => {
    await reportUserVisibleError(api, {
      handler: "saveDeliveredTurn",
      error: new Error("db down"),
      severity: "warning",
    });
    const [, text] = sendMessage.mock.calls[0];
    expect(text).toContain("⚠️ Sol error (user unaffected)");
    expect(text).not.toContain("❌");
  });

  it("truncates input preview to 200 characters", async () => {
    await reportUserVisibleError(api, {
      handler: "handleMessage",
      error: new Error("x"),
      inputPreview: "а".repeat(500),
    });
    const [, text] = sendMessage.mock.calls[0];
    const inputLine = text.split("\n").find((l: string) => l.startsWith("input:"));
    expect(inputLine.length).toBeLessThanOrEqual(210);
  });

  it("does nothing when errorChannelId is not configured", async () => {
    (config as { errorChannelId: string }).errorChannelId = "";
    await reportUserVisibleError(api, { handler: "x", error: "y" });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("swallows sendMessage failures", async () => {
    sendMessage.mockRejectedValueOnce(new Error("telegram down"));
    await expect(
      reportUserVisibleError(api, { handler: "x", error: "y" }),
    ).resolves.toBeUndefined();
  });
});
