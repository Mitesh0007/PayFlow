import { PrismaClient } from "../generated/prisma/client";
import { v4 as uuidv4 } from "uuid";
import { Db } from "../db";

const PLATFORM_FEE_BPS = 290;

export interface LedgerEntry {
  id: string;
  paymentId: string;
  account: string;
  amount: number;
  reason: string;
}

export interface AccountBalance {
  account: string;
  balance: number;
  entries: number;
}

function platformFee(amount: number): number {
  return Math.floor((amount * PLATFORM_FEE_BPS) / 10000);
}

export function buildCaptureEntries(paymentId: string, customerAccount: string, merchantAccount: string, amount: number): LedgerEntry[] {
  const fee = platformFee(amount);

  return [
    { id: uuidv4(), paymentId, account: customerAccount, amount: -amount, reason: "capture" },
    { id: uuidv4(), paymentId, account: merchantAccount, amount: amount - fee, reason: "capture" },
    { id: uuidv4(), paymentId, account: "platform:fees", amount: fee, reason: "capture_fee" },
  ];
}

export function buildRefundEntries(paymentId: string, customerAccount: string, merchantAccount: string, amount: number): LedgerEntry[] {
  const fee = platformFee(amount);

  return [
    { id: uuidv4(), paymentId, account: customerAccount, amount, reason: "refund" },
    { id: uuidv4(), paymentId, account: merchantAccount, amount: -(amount - fee), reason: "refund" },
    { id: uuidv4(), paymentId, account: "platform:fees", amount: -fee, reason: "refund_fee" },
  ];
}

export function verifyBalanced(entries: LedgerEntry[]): void {
  const sum = entries.reduce((total, entry) => total + entry.amount, 0);

  if (sum !== 0) {
    throw new Error(`ledger entries do not balance: sum = ${sum}, expected 0`);
  }
}

export class LedgerStore {
  constructor(private prisma: PrismaClient) {}

  async insert(entries: LedgerEntry[], db: Db): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    verifyBalanced(entries);

    await db.ledgerEntry.createMany({
      data: entries.map((entry) => ({
        id: entry.id,
        paymentId: entry.paymentId,
        account: entry.account,
        amount: BigInt(entry.amount),
        reason: entry.reason,
      })),
    });
  }

  async getByPayment(paymentId: string): Promise<LedgerEntry[]> {
    const rows = await this.prisma.ledgerEntry.findMany({
      where: { paymentId },
      orderBy: [{ createdAt: "asc" }, { amount: "asc" }],
    });

    return rows.map((row) => ({
      id: row.id,
      paymentId: row.paymentId,
      account: row.account,
      amount: Number(row.amount),
      reason: row.reason,
    }));
  }

  async getBalances(): Promise<{ accounts: AccountBalance[]; total: number }> {
    const groups = await this.prisma.ledgerEntry.groupBy({
      by: ["account"],
      _sum: { amount: true },
      _count: { _all: true },
      orderBy: { account: "asc" },
    });

    const accounts = groups.map((group) => ({
      account: group.account,
      balance: Number(group._sum.amount ?? 0),
      entries: group._count._all,
    }));

    return {
      accounts,
      total: accounts.reduce((sum, item) => sum + item.balance, 0),
    };
  }
}