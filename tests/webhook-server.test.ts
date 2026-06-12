import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("../src/config/env.js", () => ({
  config: {
    yookassaWebhookToken: "test-secret-token",
    port: 0, // OS assigns a free port — no conflicts between test runs
    errorChannelId: "",
  },
}));

vi.mock("../src/subscription/plans.js", () => ({
  PLAN_PRICES_RUB: { basic: 29900, premium: 89900 },
}));

const mockGetPayment = vi.fn();
vi.mock("../src/payments/yookassaClient.js", () => ({
  getYookassaPayment: mockGetPayment,
}));

const mockRecordPayment = vi.fn();
vi.mock("../src/db/payments.js", () => ({
  recordYooKassaPaymentAndUpgradeOnce: mockRecordPayment,
}));

vi.mock("../src/bot/handlers.js", () => ({
  buildDialogueKeyboard: vi.fn(() => ({})),
}));

const mockNotifyError = vi.fn();
vi.mock("../src/bot/errorNotifier.js", () => ({
  notifyErrorChannel: mockNotifyError,
}));

const mockSendMessage = vi.fn().mockResolvedValue({});
const mockBot = { api: { sendMessage: mockSendMessage } } as unknown as import("grammy").Bot;

const { startWebhookServer } = await import("../src/bot/webhookServer.js");

function waitForListening(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (server.listening) { resolve(); return; }
    server.once("listening", resolve);
  });
}

function req(
  port: number,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {},
    };
    const request = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

describe("webhook server", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = startWebhookServer(mockBot);
    await waitForListening(server);
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET /health returns 200 with ok:true", async () => {
    const res = await req(port, "GET", "/health");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it("unknown path returns 404", async () => {
    const res = await req(port, "GET", "/unknown");
    expect(res.status).toBe(404);
  });

  it("wrong webhook token returns 404", async () => {
    const res = await req(
      port,
      "POST",
      "/webhooks/yookassa/wrong-token",
      JSON.stringify({ event: "payment.succeeded", object: { id: "pay-1" } }),
    );
    expect(res.status).toBe(404);
  });

  it("unknown event type returns 200 without processing", async () => {
    const res = await req(
      port,
      "POST",
      "/webhooks/yookassa/test-secret-token",
      JSON.stringify({ event: "payment.canceled", object: { id: "pay-1" } }),
    );
    expect(res.status).toBe(200);
    expect(mockGetPayment).not.toHaveBeenCalled();
  });

  it("returns 500 when getYookassaPayment fails (so ЮKassa retries)", async () => {
    mockGetPayment.mockRejectedValueOnce(new Error("Network error"));
    const res = await req(
      port,
      "POST",
      "/webhooks/yookassa/test-secret-token",
      JSON.stringify({ event: "payment.succeeded", object: { id: "pay-1" } }),
    );
    expect(res.status).toBe(500);
    expect(mockRecordPayment).not.toHaveBeenCalled();
  });

  it("returns 500 when DB write fails (so ЮKassa retries)", async () => {
    mockGetPayment.mockResolvedValueOnce({
      id: "pay-1",
      status: "succeeded",
      amount: { value: "299.00", currency: "RUB" },
      metadata: { telegramChatId: "42", plan: "basic" },
    });
    mockRecordPayment.mockRejectedValueOnce(new Error("DB error"));
    const res = await req(
      port,
      "POST",
      "/webhooks/yookassa/test-secret-token",
      JSON.stringify({ event: "payment.succeeded", object: { id: "pay-1" } }),
    );
    expect(res.status).toBe(500);
  });

  it("returns 200 for duplicate payment (already recorded)", async () => {
    mockGetPayment.mockResolvedValueOnce({
      id: "pay-1",
      status: "succeeded",
      amount: { value: "299.00", currency: "RUB" },
      metadata: { telegramChatId: "42", plan: "basic" },
    });
    mockRecordPayment.mockResolvedValueOnce(null); // duplicate → null
    const res = await req(
      port,
      "POST",
      "/webhooks/yookassa/test-secret-token",
      JSON.stringify({ event: "payment.succeeded", object: { id: "pay-1" } }),
    );
    expect(res.status).toBe(200);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("records payment and sends confirmation on success", async () => {
    mockGetPayment.mockResolvedValueOnce({
      id: "pay-1",
      status: "succeeded",
      amount: { value: "299.00", currency: "RUB" },
      metadata: { telegramChatId: "42", plan: "basic" },
    });
    mockRecordPayment.mockResolvedValueOnce({ plan: "basic", mode: "dialogue" });
    const res = await req(
      port,
      "POST",
      "/webhooks/yookassa/test-secret-token",
      JSON.stringify({ event: "payment.succeeded", object: { id: "pay-1" } }),
    );
    expect(res.status).toBe(200);
    expect(mockRecordPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        telegramChatId: "42",
        plan: "basic",
        yookassaPaymentId: "pay-1",
        amountKopecks: 29900,
      }),
    );
    expect(mockSendMessage).toHaveBeenCalledWith(
      "42",
      expect.stringContaining("Basic"),
      expect.any(Object),
    );
  });

  it("rejects payment with mismatched amount (returns 200, no recording)", async () => {
    mockGetPayment.mockResolvedValueOnce({
      id: "pay-1",
      status: "succeeded",
      amount: { value: "1.00", currency: "RUB" },
      metadata: { telegramChatId: "42", plan: "basic" },
    });
    const res = await req(
      port,
      "POST",
      "/webhooks/yookassa/test-secret-token",
      JSON.stringify({ event: "payment.succeeded", object: { id: "pay-1" } }),
    );
    expect(res.status).toBe(200);
    expect(mockRecordPayment).not.toHaveBeenCalled();
    expect(mockNotifyError).toHaveBeenCalledWith(
      mockBot,
      expect.stringContaining("amount mismatch"),
    );
  });

  it("alerts the error channel on invalid metadata (no upgrade applied)", async () => {
    mockGetPayment.mockResolvedValueOnce({
      id: "pay-1",
      status: "succeeded",
      amount: { value: "299.00", currency: "RUB" },
      metadata: {},
    });
    const res = await req(
      port,
      "POST",
      "/webhooks/yookassa/test-secret-token",
      JSON.stringify({ event: "payment.succeeded", object: { id: "pay-1" } }),
    );
    expect(res.status).toBe(200);
    expect(mockRecordPayment).not.toHaveBeenCalled();
    expect(mockNotifyError).toHaveBeenCalledWith(
      mockBot,
      expect.stringContaining("metadata"),
    );
  });

  it("does not alert the error channel on successful payment", async () => {
    mockGetPayment.mockResolvedValueOnce({
      id: "pay-2",
      status: "succeeded",
      amount: { value: "299.00", currency: "RUB" },
      metadata: { telegramChatId: "42", plan: "basic" },
    });
    mockRecordPayment.mockResolvedValueOnce({ plan: "basic", mode: "dialogue" });
    const res = await req(
      port,
      "POST",
      "/webhooks/yookassa/test-secret-token",
      JSON.stringify({ event: "payment.succeeded", object: { id: "pay-2" } }),
    );
    expect(res.status).toBe(200);
    expect(mockNotifyError).not.toHaveBeenCalled();
  });
});
