import { Prisma, PrismaClient } from "../generated/prisma/client";
import { Db } from "../db";

export const STATUS_PENDING = "pending";
export const STATUS_AUTHORIZED = "authorized";
export const STATUS_CAPTURED = "captured";
export const STATUS_FAILED = "failed";
export const STATUS_REFUNDED = "refunded";

const allowedTransitions: Record<string, string[]> = {
  [STATUS_PENDING]: [STATUS_AUTHORIZED, STATUS_FAILED],
  [STATUS_AUTHORIZED]: [STATUS_CAPTURED, STATUS_FAILED],
  [STATUS_CAPTURED]: [STATUS_REFUNDED],
};

export function canTransition(from: string, to: string): boolean {
  return (allowedTransitions[from] ?? []).includes(to);
}

export class PaymentNotFoundError extends Error {
  constructor(id: string) {
    super(`payment ${id} not found`);
    this.name = "PaymentNotFoundError";
  }
}

export class InvalidTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransitionError";
  }
}

export interface Payment {
  id: string;
  idempotencyKey: string;
  amount: number;
  currency: string;
  status: string;
  merchantId: string;
  customerId: string;
  createdAt?: string;
}

export interface PaymentFilter {
  limit: number;
  status?: string;
  merchantId?: string;
}

type PaymentRow = Prisma.PaymentGetPayload<object>;

function toPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    amount: Number(row.amount),
    currency: row.currency,
    status: row.status,
    merchantId: row.merchantId,
    customerId: row.customerId,
    createdAt: row.createdAt.toISOString(),
  };
}

export class PaymentStore {
  constructor(private prisma: PrismaClient) {}

  async create(payment: Payment, db: Db = this.prisma): Promise<void> {
    await db.payment.create({
      data: {
        id: payment.id,
        idempotencyKey: payment.idempotencyKey,
        amount: BigInt(payment.amount),
        currency: payment.currency,
        status: STATUS_PENDING,
        merchantId: payment.merchantId,
        customerId: payment.customerId,
      },
    });
  }

  async get(id: string, db: Db = this.prisma, forUpdate = false): Promise<Payment> {
    if (forUpdate) {
      await db.$queryRaw`SELECT id FROM payments WHERE id = ${id} FOR UPDATE`;
    }

    const row = await db.payment.findUnique({ where: { id } });

    if (!row) {
      throw new PaymentNotFoundError(id);
    }

    return toPayment(row);
  }

  async list(filter: PaymentFilter, db: Db = this.prisma): Promise<Payment[]> {
    const rows = await db.payment.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.merchantId ? { merchantId: filter.merchantId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: filter.limit,
    });

    return rows.map(toPayment);
  }

  async transition(id: string, from: string, to: string, db: Db = this.prisma): Promise<void> {
    if (!canTransition(from, to)) {
      throw new InvalidTransitionError(`invalid payment state transition: ${from} -> ${to}`);
    }

    const result = await db.payment.updateMany({
      where: { id, status: from },
      data: { status: to, updatedAt: new Date() },
    });

    if (result.count === 0) {
      throw new InvalidTransitionError(`payment ${id} is not currently in status ${from}`);
    }
  }
}