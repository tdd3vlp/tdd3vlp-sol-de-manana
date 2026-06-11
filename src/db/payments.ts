import { Prisma } from "@prisma/client";
import type { Chat } from "@prisma/client";
import { prisma } from "./prisma.js";
import { upgradeChatPlan } from "./chatHistory.js";

export interface PaymentRecord {
  telegramChatId: string;
  plan: string;
  amount: number;
  currency: string;
  telegramPaymentChargeId: string;
  providerPaymentChargeId: string | null;
  isRecurring: boolean;
  expiresAt: Date | null;
}

// Records a successful payment and activates the plan in one transaction:
// if either write fails, neither is applied, so a payment can never end up
// recorded without its plan upgrade. Telegram may redeliver the same update;
// the unique telegramPaymentChargeId fails the whole transaction with P2002,
// so a duplicate neither re-records nor re-upgrades.
// Returns the upgraded chat, or null when this charge was already recorded.
export async function recordPaymentAndUpgradeOnce(
  data: PaymentRecord
): Promise<Chat | null> {
  try {
    const [, chat] = await prisma.$transaction([
      prisma.payment.create({ data }),
      upgradeChatPlan(data.telegramChatId, data.plan, data.expiresAt),
    ]);
    return chat;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return null;
    }
    throw error;
  }
}
