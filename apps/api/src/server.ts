import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import { createPrisma } from "./db";
import { IdempotencyStore } from "./idempotency/idempotency";
import { PaymentStore } from "./payments/payments";
import { LedgerStore } from "./ledger/ledger";
import { WebhookDispatcher, WebhookOutbox, WebhookWorker } from "./webhook/webhook";
import { chargesRouter } from "./api/routes";
import { metricsHandler, metricsMiddleware } from "./metrics";

function getEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function withCORS(req: Request, res: Response, next: NextFunction) {
  const origin = req.header("Origin");
  const frontendOrigin = getEnv("FRONTEND_ORIGIN", "http://localhost:3000");

  if (origin === frontendOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Idempotency-Key");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
}

async function main() {
  const databaseUrl = getEnv(
    "DATABASE_URL",
    "postgres://payflow:payflow@localhost:5434/payflow"
  );
  const webhookSecret = getEnv("WEBHOOK_SECRET", "dev-secret-change-me");
  const webhookUrl = getEnv("WEBHOOK_TARGET_URL", "http://localhost:9999/webhooks/payflow");
  const port = Number(getEnv("PORT", "8095"));

  const prisma = createPrisma(databaseUrl);
  await prisma.$connect();

  const idempotencyStore = new IdempotencyStore(prisma);
  const paymentStore = new PaymentStore(prisma);
  const ledgerStore = new LedgerStore(prisma);
  const outbox = new WebhookOutbox(prisma);
  const dispatcher = new WebhookDispatcher(webhookSecret, webhookUrl);
  const worker = new WebhookWorker(outbox, dispatcher);

  worker.start();

  const app = express();

  app.use(withCORS);
  app.use(metricsMiddleware);
  app.use(express.json({
    limit: "100kb",
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody: Buffer }).rawBody = buf;
    },
  }));

  app.post("/webhooks/payflow", (req, res) => {
  console.log("webhook received", {
    type: req.body?.type,
    paymentId: req.body?.paymentId,
    status: req.body?.status,
  });

  res.status(200).json({
    received: true,
  });
});

  app.get("/metrics", metricsHandler);

  app.get("/health", async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.status(200).json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "database unavailable" });
    }
  });

  app.use(chargesRouter(prisma, idempotencyStore, paymentStore, ledgerStore, outbox));

  const server = app.listen(port, "0.0.0.0", () => {
    console.log(`payflow-ts listening on :${port}`);
  });

  const shutdown = async () => {
    console.log("shutdown signal received");

    server.close(async () => {
      await worker.stop();
      await prisma.$disconnect();
      console.log("server stopped");
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("fatal startup error:", err);
  process.exit(1);
});