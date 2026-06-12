import http from "node:http";
import type { Bot } from "grammy";
import type { Context } from "grammy";
import { config } from "../config/env.js";
import { getYookassaPayment } from "../payments/yookassaClient.js";
import { recordYooKassaPaymentAndUpgradeOnce } from "../db/payments.js";
import { PLAN_PRICES_RUB } from "../subscription/plans.js";
import type { Plan } from "../subscription/plans.js";
import { buildDialogueKeyboard } from "./handlers.js";

type PaidPlan = Exclude<Plan, "free">;

const PAYMENT_PERIOD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function handleYooKassaWebhook(
  body: string,
  bot: Bot<Context>,
): Promise<{ status: number; message: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { status: 400, message: "Invalid JSON" };
  }

  const event = (parsed as Record<string, unknown>).event;
  const obj = (parsed as Record<string, unknown>).object as Record<string, unknown> | undefined;

  // Only process successful payments; acknowledge everything else immediately.
  if (event !== "payment.succeeded" || !obj?.id) {
    return { status: 200, message: "ok" };
  }

  const paymentId = String(obj.id);

  // Always re-fetch from ЮKassa API — never trust the webhook body for amounts.
  let payment;
  try {
    payment = await getYookassaPayment(paymentId);
  } catch (error) {
    console.error("ЮKassa getPayment failed:", error);
    // Return 500 so ЮKassa retries delivery for up to 24 hours.
    return { status: 500, message: "payment fetch failed" };
  }

  if (payment.status !== "succeeded") {
    return { status: 200, message: "ok" };
  }

  if (payment.amount.currency !== "RUB") {
    console.error("Unexpected currency in ЮKassa payment:", payment.amount.currency);
    return { status: 200, message: "ok" };
  }

  const plan = payment.metadata?.plan as PaidPlan | undefined;
  const telegramChatId = payment.metadata?.telegramChatId;

  if (!plan || (plan !== "basic" && plan !== "premium") || !telegramChatId) {
    console.error("ЮKassa payment missing valid metadata:", payment.metadata);
    return { status: 200, message: "ok" };
  }

  const expectedKopecks = PLAN_PRICES_RUB[plan];
  const actualKopecks = Math.round(parseFloat(payment.amount.value) * 100);
  if (actualKopecks !== expectedKopecks) {
    console.error(`ЮKassa amount mismatch: expected ${expectedKopecks} got ${actualKopecks}`);
    return { status: 200, message: "ok" };
  }

  const expiresAt = new Date(Date.now() + PAYMENT_PERIOD_MS);

  let upgraded;
  try {
    upgraded = await recordYooKassaPaymentAndUpgradeOnce({
      telegramChatId,
      plan,
      yookassaPaymentId: payment.id,
      amountKopecks: actualKopecks,
      expiresAt,
    });
  } catch (error) {
    console.error("ЮKassa payment DB write failed:", error);
    return { status: 500, message: "db write failed" };
  }

  if (!upgraded) {
    console.warn(`Duplicate ЮKassa payment ignored: ${payment.id}`);
    return { status: 200, message: "ok" };
  }

  const confirmations: Record<PaidPlan, string> = {
    basic: "Подписка Basic активирована. Теперь у тебя 100 сообщений в день.",
    premium: "Подписка Premium активирована. Теперь у тебя 300 сообщений в день.",
  };

  try {
    await bot.api.sendMessage(telegramChatId, confirmations[plan], {
      reply_markup: buildDialogueKeyboard(upgraded.plan, undefined),
    });
  } catch (error) {
    // Notification failure is non-fatal; plan is already activated.
    console.error("Failed to send payment confirmation to user:", error);
  }

  return { status: 200, message: "ok" };
}

export function startWebhookServer(bot: Bot<Context>): http.Server {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";

    if (req.method === "GET" && url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ЮKassa webhook: POST /webhooks/yookassa/<token>
    const webhookPrefix = "/webhooks/yookassa/";
    if (req.method === "POST" && url.startsWith(webhookPrefix)) {
      const pathToken = url.slice(webhookPrefix.length);
      if (
        !config.yookassaWebhookToken ||
        pathToken !== config.yookassaWebhookToken
      ) {
        res.writeHead(404).end();
        return;
      }

      readBody(req)
        .then((body) => handleYooKassaWebhook(body, bot))
        .then(({ status, message }) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message }));
        })
        .catch((error) => {
          console.error("Webhook handler crashed:", error);
          res.writeHead(500).end();
        });
      return;
    }

    res.writeHead(404).end();
  });

  server.listen(config.port, () => {
    console.log(`HTTP server listening on port ${config.port}`);
  });

  return server;
}
