import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

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

// Records a successful payment exactly once. Telegram may redeliver the same
// update; the unique telegramPaymentChargeId makes the second insert a no-op.
// Returns false when this charge was already recorded.
export async function recordPaymentOnce(data: PaymentRecord): Promise<boolean> {
  try {
    await prisma.payment.create({ data });
    return true;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return false;
    }
    throw error;
  }
}
