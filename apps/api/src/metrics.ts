import * as client from "prom-client";
import { Request, Response, NextFunction } from "express";

client.collectDefaultMetrics();

export const chargesTotal = new client.Counter({
  name: "payflow_charges_total",
  help: "Total payment operations, partitioned by outcome.",
  labelNames: ["outcome"],
});

const httpDuration = new client.Histogram({
  name: "payflow_http_request_duration_seconds",
  help: "HTTP request duration in seconds.",
  labelNames: ["method", "route", "status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
});

export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const end = httpDuration.startTimer();

  res.on("finish", () => {
    end({
      method: req.method,
      route: req.path,
      status: String(res.statusCode),
    });
  });

  next();
}

export async function metricsHandler(_req: Request, res: Response) {
  res.set("Content-Type", client.register.contentType);
  res.end(await client.register.metrics());
}