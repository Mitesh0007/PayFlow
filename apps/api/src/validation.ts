export const PAYMENT_METHOD_SUCCESS = "pm_card_success";
export const PAYMENT_METHOD_DECLINED = "pm_card_declined";

const PAYMENT_METHODS = [PAYMENT_METHOD_SUCCESS, PAYMENT_METHOD_DECLINED];
const SUPPORTED_CURRENCIES = ["inr", "usd", "eur", "gbp"];
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_AMOUNT = 100_000_000;

export interface CreateChargeRequest {
  amount: number;
  currency: string;
  merchant_id: string;
  customer_id: string;
  payment_method: string;
}

export type ValidationResult =
  | { ok: true; value: CreateChargeRequest }
  | { ok: false; message: string };

export function validateCharge(body: unknown): ValidationResult {
  if (typeof body !== "object" || body === null) {
    return { ok: false, message: "request body must be a JSON object" };
  }

  const input = body as Record<string, unknown>;

  if (
    typeof input.amount !== "number" ||
    !Number.isInteger(input.amount) ||
    input.amount <= 0 ||
    input.amount > MAX_AMOUNT
  ) {
    return {
      ok: false,
      message: `amount must be a positive integer in minor units up to ${MAX_AMOUNT}`,
    };
  }

  if (
    typeof input.currency !== "string" ||
    !SUPPORTED_CURRENCIES.includes(input.currency.toLowerCase())
  ) {
    return {
      ok: false,
      message: `currency must be one of: ${SUPPORTED_CURRENCIES.join(", ")}`,
    };
  }

  if (typeof input.merchant_id !== "string" || !ID_PATTERN.test(input.merchant_id)) {
    return { ok: false, message: "merchant_id is invalid" };
  }

  if (typeof input.customer_id !== "string" || !ID_PATTERN.test(input.customer_id)) {
    return { ok: false, message: "customer_id is invalid" };
  }

  const paymentMethod = input.payment_method ?? PAYMENT_METHOD_SUCCESS;

  if (typeof paymentMethod !== "string" || !PAYMENT_METHODS.includes(paymentMethod)) {
    return {
      ok: false,
      message: `payment_method must be one of: ${PAYMENT_METHODS.join(", ")}`,
    };
  }

  return {
    ok: true,
    value: {
      amount: input.amount,
      currency: input.currency.toLowerCase(),
      merchant_id: input.merchant_id,
      customer_id: input.customer_id,
      payment_method: paymentMethod,
    },
  };
}