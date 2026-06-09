// TODO: Implement YooKassa payment integration
// Docs: https://yookassa.ru/developers/api
// Required env vars: YOOKASSA_SHOP_ID, YOOKASSA_SECRET_KEY

export interface YooKassaPaymentParams {
  amount: number;
  currency: "RUB";
  description: string;
  returnUrl: string;
  metadata?: Record<string, string>;
}

export interface YooKassaPaymentResult {
  paymentId: string;
  paymentUrl: string;
}

export async function createPayment(
  _params: YooKassaPaymentParams
): Promise<YooKassaPaymentResult> {
  throw new Error("YooKassa integration not yet implemented");
}

export async function verifyPayment(
  _paymentId: string
): Promise<{ status: "pending" | "succeeded" | "cancelled" }> {
  throw new Error("YooKassa integration not yet implemented");
}
