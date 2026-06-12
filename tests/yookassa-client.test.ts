import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config before importing the client
vi.mock("../src/config/env.js", () => ({
  config: {
    yookassaShopId: "test-shop-id",
    yookassaSecretKey: "test-secret-key",
    telegramBotUrl: "https://t.me/test_bot",
  },
}));

vi.mock("../src/subscription/plans.js", () => ({
  PLAN_PRICES_RUB: { basic: 29900, premium: 89900 },
}));

const { createYookassaPayment, getYookassaPayment } = await import(
  "../src/payments/yookassaClient.js"
);

const mockPayment = {
  id: "pay-123",
  status: "pending",
  amount: { value: "299.00", currency: "RUB" },
  metadata: { telegramChatId: "42", plan: "basic" },
  confirmation: { type: "redirect", confirmation_url: "https://yookassa.ru/pay/abc" },
};

describe("createYookassaPayment", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockPayment),
      }),
    );
  });

  it("POSTs to correct URL with Basic auth", async () => {
    await createYookassaPayment("basic", "42", "user@example.com");
    const [url, opts] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.yookassa.ru/v3/payments");
    const auth = (opts.headers as Record<string, string>)["Authorization"];
    expect(auth).toMatch(/^Basic /);
    const decoded = Buffer.from(auth.replace("Basic ", ""), "base64").toString();
    expect(decoded).toBe("test-shop-id:test-secret-key");
  });

  it("sends correct amount in rubles for basic plan", async () => {
    await createYookassaPayment("basic", "42", "user@example.com");
    const [, opts] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(opts.body as string);
    expect(body.amount).toEqual({ value: "299.00", currency: "RUB" });
    expect(body.metadata).toMatchObject({ telegramChatId: "42", plan: "basic" });
  });

  it("sends correct amount for premium plan", async () => {
    await createYookassaPayment("premium", "99", "user@example.com");
    const [, opts] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(opts.body as string);
    expect(body.amount).toEqual({ value: "899.00", currency: "RUB" });
  });

  it("includes Idempotence-Key header", async () => {
    await createYookassaPayment("basic", "42", "user@example.com");
    const [, opts] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(
      (opts.headers as Record<string, string>)["Idempotence-Key"],
    ).toBeTruthy();
  });

  it("includes receipt with customer email and service item", async () => {
    await createYookassaPayment("basic", "42", "user@example.com");
    const [, opts] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(opts.body as string);
    expect(body.receipt.customer.email).toBe("user@example.com");
    expect(body.receipt.items).toHaveLength(1);
    expect(body.receipt.items[0]).toMatchObject({
      quantity: "1.00",
      amount: { value: "299.00", currency: "RUB" },
      vat_code: 1,
      payment_mode: "full_payment",
      payment_subject: "service",
    });
  });

  it("throws on non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve("Unauthorized") }),
    );
    await expect(createYookassaPayment("basic", "42", "user@example.com")).rejects.toThrow("401");
  });

  it("returns the parsed payment object", async () => {
    const result = await createYookassaPayment("basic", "42", "user@example.com");
    expect(result.id).toBe("pay-123");
    expect(result.confirmation.confirmation_url).toBe("https://yookassa.ru/pay/abc");
  });
});

describe("getYookassaPayment", () => {
  it("GETs the correct URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(mockPayment) }),
    );
    await getYookassaPayment("pay-123");
    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe("https://api.yookassa.ru/v3/payments/pay-123");
  });

  it("throws on non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve("Not found") }),
    );
    await expect(getYookassaPayment("bad-id")).rejects.toThrow("404");
  });
});
