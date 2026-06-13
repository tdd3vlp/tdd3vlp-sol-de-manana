import http from "node:http";
import { createHmac } from "node:crypto";
import type { Bot } from "grammy";
import type { Context } from "grammy";
import { config } from "../config/env.js";
import { getYookassaPayment } from "../payments/yookassaClient.js";
import { recordYooKassaPaymentAndUpgradeOnce } from "../db/payments.js";
import { PLAN_PRICES_RUB } from "../subscription/plans.js";
import type { Plan } from "../subscription/plans.js";
import { buildDialogueKeyboard } from "./handlers.js";
import { notifyErrorChannel } from "./errorNotifier.js";
import { prisma } from "../db/prisma.js";
import {
  getTodaySession,
  getProgressState,
  computeDayNumber,
  getThemeForDay,
} from "../db/practiceSession.js";

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

  // The three checks below return 200 (so ЮKassa stops retrying) but mean a
  // succeeded payment was NOT turned into an upgrade — alert the error channel.
  if (payment.amount.currency !== "RUB") {
    console.error("Unexpected currency in ЮKassa payment:", payment.amount.currency);
    void notifyErrorChannel(
      bot,
      `ЮKassa payment ${payment.id}: unexpected currency ${payment.amount.currency}, no upgrade applied`,
    );
    return { status: 200, message: "ok" };
  }

  const plan = payment.metadata?.plan as PaidPlan | undefined;
  const telegramChatId = payment.metadata?.telegramChatId;

  if (!plan || (plan !== "basic" && plan !== "premium") || !telegramChatId) {
    console.error("ЮKassa payment missing valid metadata:", payment.metadata);
    void notifyErrorChannel(
      bot,
      `ЮKassa payment ${payment.id}: missing or invalid metadata, no upgrade applied`,
    );
    return { status: 200, message: "ok" };
  }

  const expectedKopecks = PLAN_PRICES_RUB[plan];
  const actualKopecks = Math.round(parseFloat(payment.amount.value) * 100);
  if (actualKopecks !== expectedKopecks) {
    console.error(`ЮKassa amount mismatch: expected ${expectedKopecks} got ${actualKopecks}`);
    void notifyErrorChannel(
      bot,
      `ЮKassa payment ${payment.id}: amount mismatch (expected ${expectedKopecks}, got ${actualKopecks} kopecks), no upgrade applied`,
    );
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

// ─── Telegram initData validation ────────────────────────────────────────────

function validateTelegramInitData(
  rawInitData: string,
  botToken: string,
): { userId: string } | null {
  try {
    const params = new URLSearchParams(rawInitData);
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");

    const checkString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");

    const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
    const expectedHash = createHmac("sha256", secretKey).update(checkString).digest("hex");

    if (expectedHash !== hash) return null;

    const userStr = params.get("user");
    if (!userStr) return null;
    const user = JSON.parse(userStr) as { id?: number };
    if (!user.id) return null;

    return { userId: String(user.id) };
  } catch {
    return null;
  }
}

async function handleProgressRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const authHeader = req.headers["authorization"] ?? "";
  const prefix = "TelegramInitData ";
  if (!authHeader.startsWith(prefix)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing initData" }));
    return;
  }

  const rawInitData = authHeader.slice(prefix.length);
  const validated = validateTelegramInitData(rawInitData, config.telegramBotToken);
  if (!validated) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid initData" }));
    return;
  }

  const { userId } = validated;

  try {
    const chat = await prisma.chat.findUnique({
      where: { telegramChatId: userId },
    });

    if (!chat) {
      const zeroed = {
        streak: 0,
        challengeCompletedCount: 0,
        currentDayNumber: 1,
        weeklyActiveDates: [] as string[],
        today: { status: "none", dayNumber: 1, dayLabel: "Знакомство" },
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(zeroed));
      return;
    }

    const todaySession = await getTodaySession(chat.id);
    const state = getProgressState(chat, todaySession);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(state));
  } catch (error) {
    console.error("Progress endpoint error:", error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal server error" }));
  }
}

function clientIp(req: http.IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return first?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}

export function startWebhookServer(bot: Bot<Context>): http.Server {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";

    if (req.method === "GET" && url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "GET" && url === "/api/progress") {
      void handleProgressRequest(req, res);
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
        // A wrong token here usually means the URL registered in the ЮKassa
        // dashboard is stale or truncated — make that visible in the logs.
        console.warn(
          `Webhook 404 (token mismatch): POST ${webhookPrefix}${pathToken.slice(0, 8)}… (${pathToken.length} chars) from ${clientIp(req)}`,
        );
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

    console.warn(`HTTP 404: ${req.method} ${url} from ${clientIp(req)}`);
    res.writeHead(404).end();
  });

  server.listen(config.port, () => {
    console.log(`HTTP server listening on port ${config.port}`);
  });

  return server;
}
