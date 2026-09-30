import { createHash } from "crypto";
import { PrismaClient } from "../generated/prisma/client";
import { Db } from "../db";

export const STATUS_PROCESSING = "processing";
export const STATUS_COMPLETED = "completed";

const STALE_AFTER_SECONDS = 30;

export class KeyReusedWithDifferentPayloadError extends Error {
  constructor() {
    super("idempotency key reused with a different request payload");
    this.name = "KeyReusedWithDifferentPayloadError";
  }
}

export interface IdempotencyRecord {
  key: string;
  status: string;
  requestHash: string;
  responseBody: unknown;
  responseStatus: number | null;
}

export function hashRequest(body: Buffer | string): string {
  return createHash("sha256").update(body).digest("hex");
}

export class IdempotencyStore {
  constructor(private prisma: PrismaClient) {}

  async claim(
    merchantId: string,
    key: string,
    requestHash: string
  ): Promise<{ claimed: true } | { claimed: false; existing: IdempotencyRecord }> {
    const inserted = await this.prisma.idempotencyKey.createMany({
      data: [{ merchantId, key, status: STATUS_PROCESSING, requestHash }],
      skipDuplicates: true,
    });

    if (inserted.count === 1) {
      return { claimed: true };
    }

    const existing = await this.get(merchantId, key);

    if (existing.requestHash !== requestHash) {
      throw new KeyReusedWithDifferentPayloadError();
    }

    if (existing.status === STATUS_PROCESSING) {
      const takeover = await this.prisma.idempotencyKey.updateMany({
        where: {
          merchantId,
          key,
          status: STATUS_PROCESSING,
          lockedAt: {
            lt: new Date(Date.now() - STALE_AFTER_SECONDS * 1000),
          },
        },
        data: { lockedAt: new Date() },
      });

      if (takeover.count === 1) {
        return { claimed: true };
      }
    }

    return { claimed: false, existing };
  }

  async get(merchantId: string, key: string): Promise<IdempotencyRecord> {
    const row = await this.prisma.idempotencyKey.findUnique({
      where: { merchantId_key: { merchantId, key } },
    });

    if (!row) {
      throw new Error(`idempotency key ${key} not found`);
    }

    return {
      key: row.key,
      status: row.status,
      requestHash: row.requestHash,
      responseBody: row.responseBody,
      responseStatus: row.responseStatus,
    };
  }

  async complete(
    merchantId: string,
    key: string,
    responseBody: unknown,
    responseStatus: number,
    db: Db = this.prisma
  ): Promise<void> {
    await db.idempotencyKey.update({
      where: { merchantId_key: { merchantId, key } },
      data: {
        status: STATUS_COMPLETED,
        responseBody: responseBody as object,
        responseStatus,
        completedAt: new Date(),
      },
    });
  }

  async release(merchantId: string, key: string): Promise<void> {
    await this.prisma.idempotencyKey.deleteMany({
      where: { merchantId, key, status: STATUS_PROCESSING },
    });
  }
}