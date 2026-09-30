import { createHmac } from "crypto";
import { v4 as uuidv4 } from "uuid";
import { Prisma, PrismaClient } from "../generated/prisma/client";
import { Db } from "../db";
import { Payment } from "../payments/payments";

export const WEBHOOK_PENDING = "pending";
export const WEBHOOK_DELIVERED = "delivered";
export const WEBHOOK_FAILED = "failed";

const LEASE_SECONDS = 30;

export interface WebhookEvent {
  id: string;
  type: string;
  paymentId: string;
  status: string;
  amount: number;
  currency: string;
  timestamp: string;
}

export interface WebhookEventRecord {
  id: string;
  paymentId: string;
  type: string;
  deliveryStatus: string;
  attempts: number;
  lastError: string | null;
  responseStatus: number | null;
  createdAt: string;
  deliveredAt: string | null;
  nextAttemptAt: string;
}

export class WebhookEventNotFoundError extends Error {
  constructor(id: string) {
    super(`webhook event ${id} not found`);
    this.name = "WebhookEventNotFoundError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class WebhookOutbox {
  constructor(private prisma: PrismaClient) {}

  async enqueue(type: string, payment: Payment, db: Db = this.prisma): Promise<void> {
    const event: WebhookEvent = {
      id: uuidv4(),
      type,
      paymentId: payment.id,
      status: payment.status,
      amount: payment.amount,
      currency: payment.currency,
      timestamp: new Date().toISOString(),
    };

    await db.webhookEvent.create({
      data: {
        id: event.id,
        paymentId: payment.id,
        type,
        payload: event as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async claimDue(limit: number): Promise<{ id: string; payload: WebhookEvent; attempts: number }[]> {
    return this.prisma.$queryRaw<{ id: string; payload: WebhookEvent; attempts: number }[]>`
      UPDATE webhook_events
      SET next_attempt_at = now() + make_interval(secs => ${LEASE_SECONDS}::double precision)
      WHERE id IN (
        SELECT id FROM webhook_events
        WHERE status = ${WEBHOOK_PENDING} AND next_attempt_at <= now()
        ORDER BY created_at
        LIMIT ${limit}::int
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, payload, attempts
    `;
  }

  async markDelivered(id: string, attempts: number, responseStatus: number | null): Promise<void> {
    await this.prisma.webhookEvent.update({
      where: { id },
      data: {
        status: WEBHOOK_DELIVERED,
        attempts,
        responseStatus,
        lastError: null,
        deliveredAt: new Date(),
      },
    });
  }

  async markFailed(id: string, attempts: number, error: string | null, responseStatus: number | null, terminal: boolean, delayMs: number): Promise<void> {
    await this.prisma.webhookEvent.update({
      where: { id },
      data: {
        status: terminal ? WEBHOOK_FAILED : WEBHOOK_PENDING,
        attempts,
        lastError: error,
        responseStatus,
        nextAttemptAt: new Date(Date.now() + delayMs),
      },
    });
  }

  async list(limit: number): Promise<WebhookEventRecord[]> {
    const rows = await this.prisma.webhookEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return rows.map((row) => ({
      id: row.id,
      paymentId: row.paymentId,
      type: row.type,
      deliveryStatus: row.status,
      attempts: row.attempts,
      lastError: row.lastError,
      responseStatus: row.responseStatus,
      createdAt: row.createdAt.toISOString(),
      deliveredAt: row.deliveredAt?.toISOString() ?? null,
      nextAttemptAt: row.nextAttemptAt.toISOString(),
    }));
  }

  async replay(id: string): Promise<void> {
    const result = await this.prisma.webhookEvent.updateMany({
      where: { id },
      data: {
        status: WEBHOOK_PENDING,
        attempts: 0,
        nextAttemptAt: new Date(),
        lastError: null,
      },
    });

    if (result.count === 0) {
      throw new WebhookEventNotFoundError(id);
    }
  }
}

export class WebhookDispatcher {
  constructor(private secret: string, private targetUrl: string) {}

  private sign(timestamp: number, payload: string): string {
    return createHmac("sha256", this.secret).update(`${timestamp}.${payload}`).digest("hex");
  }

  async deliver(event: WebhookEvent): Promise<{ ok: boolean; status: number | null; error: string | null }> {
    const payload = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = this.sign(timestamp, payload);

    try {
      const response = await fetch(this.targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-PayFlow-Signature": `t=${timestamp},v1=${signature}`,
        },
        body: payload,
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        return { ok: true, status: response.status, error: null };
      }

      return {
        ok: false,
        status: response.status,
        error: `non-2xx response: ${response.status}`,
      };
    } catch (err) {
      return { ok: false, status: null, error: String(err) };
    }
  }
}

export class WebhookWorker {
  private running = false;
  private loop: Promise<void> | null = null;

  constructor(
    private outbox: WebhookOutbox,
    private dispatcher: WebhookDispatcher,
    private intervalMs = 1000,
    private maxAttempts = 5,
    private baseDelayMs = 500
  ) {}

  start(): void {
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.loop) {
      await this.loop;
    }
  }

  private async run(): Promise<void> {
    while (this.running) {
      let processed = 0;

      try {
        processed = await this.tick();
      } catch (err) {
        console.error(`webhook worker: tick failed: ${err}`);
      }

      if (processed === 0) {
        await sleep(this.intervalMs);
      }
    }
  }

  private async tick(): Promise<number> {
    const jobs = await this.outbox.claimDue(10);

    for (const job of jobs) {
      const attempts = job.attempts + 1;
      const result = await this.dispatcher.deliver(job.payload);

      if (result.ok) {
        await this.outbox.markDelivered(job.id, attempts, result.status);
        continue;
      }

      const terminal = attempts >= this.maxAttempts;
      const delayMs = this.baseDelayMs * Math.pow(2, attempts - 1);

      console.error(`webhook: attempt ${attempts}/${this.maxAttempts} failed for event ${job.id}: ${result.error}`);

      await this.outbox.markFailed(job.id, attempts, result.error, result.status, terminal, delayMs);
    }

    return jobs.length;
  }
}