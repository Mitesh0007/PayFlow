export type PaymentStatus =
  | "pending"
  | "authorized"
  | "captured"
  | "failed"
  | "refunded";

export interface Payment {
  id: string;
  status: PaymentStatus;
  amount: number;
  currency: string;
  merchant_id: string;
  customer_id: string;
}

export interface LedgerEntry {
  id: string;
  paymentId: string;
  account: string;
  amount: number;
  reason: string;
}

export interface ApiError {
  error: string;
}