import "dotenv/config";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { Hono } from "hono";
import { logger } from "hono/logger";

import healthRoute from "./routes/health.js";
import ingestRouter from "./routes/ingest.js";
import queryRouter from "./routes/query.js";
import auditRouter from "./routes/audit.js";

const app = new Hono();

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: process.env.FRONTEND_ORIGIN ?? "http://localhost:5173",
  }),
);

app.route("/health", healthRoute);
app.route("/ingest", ingestRouter);
app.route("/query", queryRouter);
app.route("/audit", auditRouter);

const port = Number(process.env.PORT ?? 3001);

serve({
  fetch: app.fetch,
  port,
});

console.log(`Backend listening on http://localhost:${port}`);
