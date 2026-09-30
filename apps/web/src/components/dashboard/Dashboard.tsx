"use client";

import { useEffect, useState } from "react";

import {
  capturePayment,
  createPayment,
  getLedger,
  getPayment,
  refundPayment,
} from "../../lib/api";
import type { LedgerEntry, Payment } from "../../lib/types";

const initialForm = {
  amount: "1000",
  currency: "INR",
  merchant_id: "merchant_demo",
  customer_id: "customer_demo",
};

function formatAmount(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(amount / 100);
}

function statusClass(status: Payment["status"]): string {
  return `status status-${status}`;
}

export default function Dashboard() {
  const [form, setForm] = useState(initialForm);
  const [paymentId, setPaymentId] = useState("");
  const [payment, setPayment] = useState<Payment | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!paymentId) {
      return;
    }

    getPayment(paymentId)
      .then(setPayment)
      .catch((requestError: Error) => setError(requestError.message));
  }, [paymentId]);

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setMessage("");
    setLedger([]);

    try {
      const createdPayment = await createPayment(
        {
          amount: Number(form.amount),
          currency: form.currency,
          merchant_id: form.merchant_id,
          customer_id: form.customer_id,
        },
        crypto.randomUUID()
      );

      setPayment(createdPayment);
      setPaymentId(createdPayment.id);
      setMessage("Payment created successfully");
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Could not create payment"
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleAction(action: () => Promise<Payment>) {
    if (!payment) {
      return;
    }

    setLoading(true);
    setError("");
    setMessage("");

    try {
      const updatedPayment = await action();
      setPayment(updatedPayment);
      setMessage("Payment updated successfully");
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Could not update payment"
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleLedger() {
    if (!payment) {
      return;
    }

    setLoading(true);
    setError("");

    try {
      setLedger(await getLedger(payment.id));
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Could not load ledger"
      );
    } finally {
      setLoading(false);
    }
  }

  const canCapture = payment?.status === "authorized";
  const canRefund = payment?.status === "captured";

  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">PayFlow</p>
          <h1>Payment operations</h1>
          <p className="muted">Create, capture, refund, and inspect payments.</p>
        </div>
        <span className="system-status">API connected locally</span>
      </header>

      <section className="dashboard-grid">
        <form className="card payment-form" onSubmit={handleCreate}>
          <div className="card-heading">
            <div>
              <p className="eyebrow">New payment</p>
              <h2>Create charge</h2>
            </div>
          </div>

          <label>
            Amount in minor units
            <input
              type="number"
              min="1"
              value={form.amount}
              onChange={(event) =>
                setForm({ ...form, amount: event.target.value })
              }
              required
            />
          </label>

          <label>
            Currency
            <input
              value={form.currency}
              onChange={(event) =>
                setForm({ ...form, currency: event.target.value.toUpperCase() })
              }
              maxLength={3}
              required
            />
          </label>

          <label>
            Merchant ID
            <input
              value={form.merchant_id}
              onChange={(event) =>
                setForm({ ...form, merchant_id: event.target.value })
              }
              required
            />
          </label>

          <label>
            Customer ID
            <input
              value={form.customer_id}
              onChange={(event) =>
                setForm({ ...form, customer_id: event.target.value })
              }
              required
            />
          </label>

          <button type="submit" disabled={loading}>
            {loading ? "Processing..." : "Create payment"}
          </button>
        </form>

        <section className="card payment-card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">Selected payment</p>
              <h2>Payment details</h2>
            </div>
            {payment && (
              <span className={statusClass(payment.status)}>{payment.status}</span>
            )}
          </div>

          {!payment ? (
            <div className="empty-state">Create a payment to view details.</div>
          ) : (
            <>
              <div className="payment-amount">
                {formatAmount(payment.amount, payment.currency)}
              </div>

              <dl className="details-list">
                <div>
                  <dt>Payment ID</dt>
                  <dd>{payment.id}</dd>
                </div>
                <div>
                  <dt>Merchant</dt>
                  <dd>{payment.merchant_id}</dd>
                </div>
                <div>
                  <dt>Customer</dt>
                  <dd>{payment.customer_id}</dd>
                </div>
              </dl>

              <div className="button-row">
                <button
                  type="button"
                  disabled={!canCapture || loading}
                  onClick={() => handleAction(() => capturePayment(payment.id))}
                >
                  Capture
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!canRefund || loading}
                  onClick={() => handleAction(() => refundPayment(payment.id))}
                >
                  Refund
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={loading}
                  onClick={handleLedger}
                >
                  View ledger
                </button>
              </div>
            </>
          )}
        </section>
      </section>

      {(message || error) && (
        <div className={error ? "alert alert-error" : "alert alert-success"}>
          {error || message}
        </div>
      )}

      {ledger.length > 0 && (
        <section className="card ledger-card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">Accounting</p>
              <h2>Ledger entries</h2>
            </div>
          </div>

          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Reason</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((entry) => (
                  <tr key={entry.id}>
                    <td>{entry.account}</td>
                    <td>{entry.reason}</td>
                    <td>{formatAmount(entry.amount, payment?.currency ?? "INR")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}