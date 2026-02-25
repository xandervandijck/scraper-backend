/**
 * ERP Lead Engine — Express + WebSocket Server
 *
 * Endpoints:
 *   POST /start               – start a scraping job
 *   POST /stop                – request graceful stop
 *   GET  /status              – current job status
 *   GET  /leads               – all leads collected so far
 *   GET  /download/csv        – download CSV export
 *   GET  /download/xlsx       – download Excel export
 *   GET  /config/sectors      – read sectors config
 *   POST /config/sectors      – write sectors config
 *
 * WebSocket: ws://localhost:3001
 *   Server pushes { type, payload } messages on every state change.
 */

import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import path from "path";
import fs from "fs";
import jwt from "jsonwebtoken";

import { generateQueries, loadSectors, saveSectors } from "./queryGenerator.js";
import { getAnalyzer } from "./analyzers/analyzerFactory.js";
import { ScraperEngine } from "./scraper.js";
import { browserManager } from "./searchPuppeteer.js";
import tracker from "./progressTracker.js";
import { exportCSV, exportXLSX } from "./exporter.js";
import cache from "./cache.js";

// SaaS routes
import authRouter from "./routes/auth.js";
import workspacesRouter from "./routes/workspaces.js";
import listsRouter from "./routes/lists.js";
import leadsRouter from "./routes/leads.js";
import scrapeRouter from "./routes/scrape.js";

// ─── Config ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3001;
const OUTPUT_DIR = "./output";

// ─── App setup ───────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// ─── WebSocket — per-user connections ─────────────────────────────────────────

const userSockets = new Map(); // userId → Set<ws>

function broadcastToUser(userId, data) {
  const msg = JSON.stringify(data);
  for (const ws of userSockets.get(userId) ?? []) {
    if (ws.readyState === 1) ws.send(msg);
  }
}
app.set("broadcastToUser", broadcastToUser);

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

wss.on("connection", (ws) => {
  let userId = null;

  // Client must send { type:'auth', token:'...' } to receive targeted events
  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === "auth" && msg.token) {
        const payload = jwt.verify(msg.token, process.env.JWT_SECRET);
        userId = payload.sub;
        if (!userSockets.has(userId)) userSockets.set(userId, new Set());
        userSockets.get(userId).add(ws);
        ws.send(JSON.stringify({ type: "auth_ok" }));
      }
    } catch {}
  });

  ws.on("close", () => {
    if (userId) userSockets.get(userId)?.delete(ws);
  });

  // Legacy: send current status for single-user mode
  ws.send(JSON.stringify({ type: "status", payload: tracker.snapshot() }));
  ws.send(JSON.stringify({ type: "leads", payload: currentJob?.leads ?? [] }));
});

tracker.on("update", (snapshot) => broadcast("status", snapshot));
tracker.on("log", (entry) => broadcast("log", entry));

// ─── SaaS API routes ──────────────────────────────────────────────────────────
app.use("/auth", authRouter);
app.use("/workspaces", workspacesRouter);
app.use("/lists", listsRouter);
app.use("/leads", leadsRouter);
app.use("/scrape", scrapeRouter);

// Global error handler
app.use((err, req, res, _next) => {
  console.error("[Server] Unhandled error:", err.message);
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

// ─── Job state ────────────────────────────────────────────────────────────────

let currentJob = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// ─── REST endpoints ───────────────────────────────────────────────────────────

/**
 * POST /start
 * Body: {
 *   targetLeads: number,
 *   sectorKeys: string[],
 *   countryKeys: string[],
 *   minScore: number,
 *   emailValidation: boolean,
 *   deepValidation: boolean,
 *   concurrency: number,
 *   usePuppeteer: boolean,
 * }
 */
app.post("/start", async (req, res) => {
  if (tracker.status === "running") {
    return res.status(409).json({ error: "A job is already running" });
  }

  const {
    targetLeads = 1000,
    sectorKeys = [],
    countryKeys = [],
    minScore = 50,
    emailValidation = true,
    deepValidation = false,
    concurrency = 5,
    usePuppeteer = true,
  } = req.body;

  cache.clear();
  ensureOutputDir();

  const queries = generateQueries({ sectorKeys, countryKeys });

  if (queries.length === 0) {
    return res
      .status(400)
      .json({
        error: "No queries generated. Check sectorKeys and countryKeys.",
      });
  }

  const source = usePuppeteer ? "Puppeteer" : "HTTP";
  const engine = new ScraperEngine({
    concurrency,
    minScore,
    emailValidation,
    deepValidation,
    usePuppeteer,
  });
  currentJob = { engine, leads: [], config: req.body };

  tracker.start(queries.length);
  tracker.log(
    "info",
    `Job gestart [${source}]: ${queries.length} queries, target ${targetLeads} leads`,
  );

  res.json({ ok: true, queries: queries.length, searchSource: source });

  runJob(engine, queries, targetLeads, currentJob).catch((err) => {
    tracker.log("error", `Job crashed: ${err.message}`);
    tracker.stop();
  });
});

/**
 * POST /stop
 */
app.post("/stop", (req, res) => {
  if (!currentJob || tracker.status !== "running") {
    return res.status(400).json({ error: "No active job to stop" });
  }
  currentJob.engine.requestStop();
  tracker.requestStop();
  tracker.log("warn", "Stop aangevraagd...");
  res.json({ ok: true });
});

/**
 * GET /status
 */
app.get("/status", (req, res) => {
  res.json({
    ...tracker.snapshot(),
    searchSource:
      currentJob?.config?.usePuppeteer === false ? "HTTP" : "Puppeteer",
    puppeteerActive: browserManager.isRunning,
  });
});

/**
 * GET /leads
 */
app.get("/leads", (req, res) => {
  const leads = currentJob?.leads ?? [];
  const page = parseInt(req.query.page ?? "1");
  const limit = parseInt(req.query.limit ?? "50");
  const minScore = parseInt(req.query.minScore ?? "0");
  const search = (req.query.search ?? "").toLowerCase();

  let filtered = leads.filter((l) => l.erpScore >= minScore);
  if (search) {
    filtered = filtered.filter(
      (l) =>
        l.companyName?.toLowerCase().includes(search) ||
        l.website?.toLowerCase().includes(search) ||
        l.email?.toLowerCase().includes(search) ||
        l.sector?.toLowerCase().includes(search),
    );
  }

  const total = filtered.length;
  const start = (page - 1) * limit;
  const data = filtered.slice(start, start + limit);
  res.json({ total, page, limit, data });
});

/**
 * GET /download/csv
 */
app.get("/download/csv", async (req, res) => {
  const leads = currentJob?.leads ?? [];
  if (leads.length === 0)
    return res.status(404).json({ error: "No leads to export" });
  try {
    const filepath = await exportCSV(leads, "leads_export.csv");
    res.download(path.resolve(filepath), "erp_leads.csv");
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /download/xlsx
 */
app.get("/download/xlsx", async (req, res) => {
  const leads = currentJob?.leads ?? [];
  if (leads.length === 0)
    return res.status(404).json({ error: "No leads to export" });
  try {
    const filepath = exportXLSX(leads, "leads_export.xlsx");
    res.download(path.resolve(filepath), "erp_leads.xlsx");
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /config/sectors
 */
app.get("/config/sectors", (req, res) => {
  try {
    const useCase = req.query.useCase ?? 'erp';
    if (useCase === 'erp') {
      return res.json(loadSectors());
    }
    // For other use cases, return sectors from the analyzer
    const analyzer = getAnalyzer(useCase);
    if (analyzer.sectors) {
      return res.json(analyzer.sectors);
    }
    res.json([]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /config/sectors
 * Body: array of sector objects
 */
app.post("/config/sectors", (req, res) => {
  const sectors = req.body;
  if (!Array.isArray(sectors)) {
    return res
      .status(400)
      .json({ error: "Body must be an array of sector objects" });
  }
  // Basic validation
  for (const s of sectors) {
    if (!s.key || !s.label || !Array.isArray(s.queries)) {
      return res
        .status(400)
        .json({ error: "Each sector needs key, label, and queries[]" });
    }
  }
  try {
    saveSectors(sectors);
    res.json({ ok: true, count: sectors.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Job runner ───────────────────────────────────────────────────────────────

async function runJob(engine, queries, targetLeads, job) {
  for (const querySpec of queries) {
    if (engine.stopRequested) break;
    if (job.leads.length >= targetLeads) {
      tracker.log("success", `Doelstelling bereikt: ${job.leads.length} leads`);
      break;
    }

    tracker.setContext(querySpec.sector, querySpec.country);

    await engine.runQuery(querySpec, {
      sector: querySpec.sector,
      country: querySpec.country,
      onDomainFound: (count) => tracker.addDomain(count),
      onLeadFound: (lead) => {
        job.leads.push(lead);
        broadcast("lead", lead);
        tracker.completeDomain(1);
      },
      onLog: (level, msg) => tracker.log(level, msg),
      onError: () => {
        tracker.addError();
        tracker.completeDomain(0);
      },
      onSearchProgress: (info) => {
        broadcast("search_progress", info);
        if (info.blocked) {
          tracker.log(
            "warn",
            `  Geblokkeerd bij "${info.query}" — adaptieve vertraging actief`,
          );
        }
      },
    });

    tracker.completeQuery();
  }

  if (job.leads.length > 0) {
    try {
      ensureOutputDir();
      await exportCSV(job.leads, "leads_auto.csv");
      exportXLSX(job.leads, "leads_auto.xlsx");
      tracker.log(
        "success",
        `Auto-export: ${job.leads.length} leads opgeslagen`,
      );
    } catch (err) {
      tracker.log("warn", `Auto-export mislukt: ${err.message}`);
    }
  }

  tracker.stop();
  tracker.log(
    "success",
    `Job klaar. Totaal: ${job.leads.length} leads gevonden.`,
  );
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

async function shutdown() {
  console.log("\n[Server] Shutting down...");
  if (currentJob?.engine) currentJob.engine.requestStop();
  await browserManager.close();
  httpServer.close(() => process.exit(0));
}

// ─── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`ERP Lead Engine backend running on http://localhost:${PORT}`);
  console.log(`WebSocket available on ws://localhost:${PORT}`);
  cache.startCleanup();
});

export default app;
