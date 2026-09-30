import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { PrismaClient } from "../generated/prisma/client";
import { withTransaction } from "../db";
import {
  IdempotencyStore,
  hashRequest,
  KeyReusedWithDifferentPayloadError,
  STATUS_COMPLETED,
} from "../idempotency/idempotency";
import {
  PaymentStore,
  Payment,
  PaymentNotFoundError,
  InvalidTransitionError,
  STATUS_PENDING,
  STATUS_AUTHORIZED,
  STATUS_CAPTURED,
  STATUS_FAILED,
  STATUS_REFUNDED,
} from "../payments/payments";
import { LedgerStore, buildCaptureEntries, buildRefundEntries } from "../ledger/ledger";
import { WebhookOutbox, WebhookEventNotFoundError } from "../webhook/webhook";
import { validateCharge, PAYMENT_METHOD_DECLINED } from "../validation";
import { chargesTotal } from "../metrics";

interface ChargeResponse {
  id: string;
  status: string;
  amount: number;
  currency: string;
  merchant_id: string;
  customer_id: string;
  created_at?: string;
  failure_reason?: string;
}

function toChargeResponse(payment: Payment, failureReason?: string): ChargeResponse {
  return {
    id: payment.id,
    status: payment.status,
    amount: payment.amount,
    currency: payment.currency,
    merchant_id: payment.merchantId,
    customer_id: payment.customerId,
    created_at: payment.createdAt,
    ...(failureReason ? { failure_reason: failureReason } : {}),
  };
}

function writeError(res: Response, status: number, message: string) {
  res.status(status).json({ error: message });
}

function parseLimit(value: unknown, fallback: number): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, 200);
}

function handleError(res: Response, err: unknown, fallback: string) {
  if (err instanceof PaymentNotFoundError) {
    return writeError(res, 404, err.message);
  }

  if (err instanceof InvalidTransitionError) {
    return writeError(res, 409, err.message);
  }

  console.error(`${fallback}: ${err}`);
  return writeError(res, 500, fallback);
}

export function chargesRouter(
  prisma: PrismaClient,
  idempotency: IdempotencyStore,
  payments: PaymentStore,
  ledger: LedgerStore,
  outbox: WebhookOutbox
): Router {
  const router = Router();

  router.post("/charges", async (req: Request, res: Response) => {
    const key = req.header("Idempotency-Key");

    if (!key || key.length > 255) {
      return writeError(res, 400, "Idempotency-Key header is required (max 255 characters)");
    }

    const parsed = validateCharge(req.body);

    if (!parsed.ok) {
      return writeError(res, 400, parsed.message);
    }

    const body = parsed.value;
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const requestHash = hashRequest(rawBody);

    let claim;

    try {
      claim = await idempotency.claim(body.merchant_id, key, requestHash);
    } catch (err) {
      if (err instanceof KeyReusedWithDifferentPayloadError) {
        return writeError(res, 422, err.message);
      }

      return writeError(res, 500, "could not process idempotency key");
    }

    if (!claim.claimed) {
      if (claim.existing.status === STATUS_COMPLETED) {
        return res.status(claim.existing.responseStatus ?? 200).json(claim.existing.responseBody);
      }

      return writeError(res, 409, "request with this idempotency key is still processing, retry shortly");
    }

    const declined = body.payment_method === PAYMENT_METHOD_DECLINED;

    const payment: Payment = {
      id: uuidv4(),
      idempotencyKey: key,
      amount: body.amount,
      currency: body.currency,
      status: STATUS_PENDING,
      merchantId: body.merchant_id,
      customerId: body.customer_id,
      createdAt: new Date().toISOString(),
    };

    try {
      const result = await withTransaction(prisma, async (tx) => {
        await payments.create(payment, tx);

        const finalStatus = declined ? STATUS_FAILED : STATUS_AUTHORIZED;
        await payments.transition(payment.id, STATUS_PENDING, finalStatus, tx);

        const finalPayment = { ...payment, status: finalStatus };
        await outbox.enqueue(
          declined ? "payment.failed" : "payment.authorized",
          finalPayment,
          tx
        );

        const response = toChargeResponse(
          finalPayment,
          declined ? "card_declined" : undefined
        );
        const httpStatus = declined ? 402 : 201;

        await idempotency.complete(body.merchant_id, key, response, httpStatus, tx);

        return { response, httpStatus };
      });

      chargesTotal.inc({ outcome: declined ? "declined" : "authorized" });
      return res.status(result.httpStatus).json(result.response);
    } catch (err) {
      console.error(`could not create charge: ${err}`);
      await idempotency.release(body.merchant_id, key).catch(() => {});
      return writeError(res, 500, "could not create/authorize payment");
    }
  });

  router.get("/charges", async (req: Request, res: Response) => {
    try {
      const list = await payments.list({
        limit: parseLimit(req.query.limit, 50),
        status: typeof req.query.status === "string" ? req.query.status : undefined,
        merchantId: typeof req.query.merchant_id === "string" ? req.query.merchant_id : undefined,
      });

      res.status(200).json(list.map((payment) => toChargeResponse(payment)));
    } catch (err) {
      handleError(res, err, "could not list payments");
    }
  });

  router.get("/charges/:id", async (req: Request, res: Response) => {
    try {
      const payment = await payments.get(req.params.id as string);
      res.status(200).json(toChargeResponse(payment));
    } catch (err) {
      handleError(res, err, "could not fetch payment");
    }
  });

  router.get("/charges/:id/ledger", async (req: Request, res: Response) => {
    try {
      res.status(200).json(await ledger.getByPayment(req.params.id as string));
    } catch (err) {
      handleError(res, err, "could not fetch ledger entries");
    }
  });

  router.post("/charges/:id/capture", async (req: Request, res: Response) => {
    try {
      const captured = await withTransaction(prisma, async (tx) => {
        const payment = await payments.get(req.params.id as string, tx, true);
        await payments.transition(payment.id, STATUS_AUTHORIZED, STATUS_CAPTURED, tx);

        await ledger.insert(
          buildCaptureEntries(
            payment.id,
            `customer:${payment.customerId}`,
            `merchant:${payment.merchantId}`,
            payment.amount
          ),
          tx
        );

        const updated = { ...payment, status: STATUS_CAPTURED };
        await outbox.enqueue("payment.captured", updated, tx);
        return updated;
      });

      chargesTotal.inc({ outcome: "captured" });
      res.status(200).json(toChargeResponse(captured));
    } catch (err) {
      handleError(res, err, "could not capture payment");
    }
  });

  router.post("/charges/:id/refund", async (req: Request, res: Response) => {
    try {
      const refunded = await withTransaction(prisma, async (tx) => {
        const payment = await payments.get(String(req.params.id), tx, true);
        await payments.transition(payment.id, STATUS_CAPTURED, STATUS_REFUNDED, tx);

        await ledger.insert(
          buildRefundEntries(
            payment.id,
            `customer:${payment.customerId}`,
            `merchant:${payment.merchantId}`,
            payment.amount
          ),
          tx
        );

        const updated = { ...payment, status: STATUS_REFUNDED };
        await outbox.enqueue("payment.refunded", updated, tx);
        return updated;
      });

      chargesTotal.inc({ outcome: "refunded" });
      res.status(200).json(toChargeResponse(refunded));
    } catch (err) {
      handleError(res, err, "could not refund payment");
    }
  });

  router.get("/balances", async (_req: Request, res: Response) => {
    try {
      res.status(200).json(await ledger.getBalances());
    } catch (err) {
      handleError(res, err, "could not fetch balances");
    }
  });

  router.get("/webhook-events", async (req: Request, res: Response) => {
    try {
      res.status(200).json(await outbox.list(parseLimit(req.query.limit, 50)));
    } catch (err) {
      handleError(res, err, "could not list webhook events");
    }
  });

  router.post("/webhook-events/:id/replay", async (req: Request, res: Response) => {
    try {
      await outbox.replay(String(req.params.id));
      res.status(202).json({ status: "replay scheduled", id: req.params.id });
    } catch (err) {
      if (err instanceof WebhookEventNotFoundError) {
        return writeError(res, 404, err.message);
      }

      handleError(res, err, "could not replay webhook event");
    }
  });

  return router;
}