import type { LedgerEntry, Payment } from "./types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8095";

interface CreatePaymentInput {
  amount: number;
  currency: string;
  merchant_id: string;
  customer_id: string;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });

  const body = (await response.json()) as T | { error?: string };

  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? body.error
        : "Request failed";

    throw new Error(message || "Request failed");
  }

  return body as T;
}

export function createPayment(
  input: CreatePaymentInput,
  idempotencyKey: string
): Promise<Payment> {
  return request<Payment>("/charges", {
    method: "POST",
    headers: {
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(input),
  });
}

export function getPayment(id: string): Promise<Payment> {
  return request<Payment>(`/charges/${id}`);
}

export function capturePayment(id: string): Promise<Payment> {
  return request<Payment>(`/charges/${id}/capture`, {
    method: "POST",
  });
}

export function refundPayment(id: string): Promise<Payment> {
  return request<Payment>(`/charges/${id}/refund`, {
    method: "POST",
  });
}

export function getLedger(id: string): Promise<LedgerEntry[]> {
  return request<LedgerEntry[]>(`/charges/${id}/ledger`);
}