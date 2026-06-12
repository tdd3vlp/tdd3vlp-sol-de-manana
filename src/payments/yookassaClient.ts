import { config } from "../config/env.js";
import { PLAN_PRICES_RUB } from "../subscription/plans.js";
import type { Plan } from "../subscription/plans.js";

type PaidPlan = Exclude<Plan, "free">;

export interface YooKassaPayment {
  id: string;
  status: "pending" | "waiting_for_capture" | "succeeded" | "canceled";
  amount: { value: string; currency: string };
  metadata: Record<string, string>;
  confirmation: { type: string; confirmation_url?: string };
}

function authHeader(): string {
  const credentials = Buffer.from(
    `${config.yookassaShopId}:${config.yookassaSecretKey}`,
  ).toString("base64");
  return `Basic ${credentials}`;
}

export async function createYookassaPayment(
  plan: PaidPlan,
  telegramChatId: string,
): Promise<YooKassaPayment> {
  const rubles = (PLAN_PRICES_RUB[plan] / 100).toFixed(2);
  const labels: Record<PaidPlan, string> = {
    basic: "Basic — 100 сообщений в день (30 дней)",
    premium: "Premium — 300 сообщений в день (30 дней)",
  };

  const body: Record<string, unknown> = {
    amount: { value: rubles, currency: "RUB" },
    confirmation: { type: "redirect", ...(config.telegramBotUrl ? { return_url: config.telegramBotUrl } : {}) },
    description: labels[plan],
    metadata: { telegramChatId, plan },
    capture: true,
  };

  const response = await fetch("https://api.yookassa.ru/v3/payments", {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
      "Idempotence-Key": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ЮKassa createPayment error ${response.status}: ${text}`);
  }
  return response.json() as Promise<YooKassaPayment>;
}

export async function getYookassaPayment(paymentId: string): Promise<YooKassaPayment> {
  const response = await fetch(
    `https://api.yookassa.ru/v3/payments/${encodeURIComponent(paymentId)}`,
    { headers: { Authorization: authHeader() } },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ЮKassa getPayment error ${response.status}: ${text}`);
  }
  return response.json() as Promise<YooKassaPayment>;
}
