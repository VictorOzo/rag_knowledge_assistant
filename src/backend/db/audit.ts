// src/backend/db/audit.ts
import Database from "better-sqlite3";
import { resolve } from "node:path";

const auditDbPath = resolve(
  process.cwd(),
  process.env.AUDIT_DB_PATH ?? "audit.db",
);

let db: Database.Database | null = null;

export type IngestionLogRow = {
  id: number;
  timestamp: string;
  fileName: string;
  docId: string;
  chunksCreated: number;
  replacedChunks: number;
};

export type QueryLogRow = {
  id: number;
  timestamp: string;
  question: string;
  answer: string;
  prompt: string;
  latencyMs: number;
  contextCharsUsed: number;
  sourcesJson: string;
};

export function initAuditDb():
  | { ok: true; path: string }
  | { ok: false; error: string } {
  try {
    if (!db) {
      db = new Database(auditDbPath);
      db.pragma("journal_mode = WAL");
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS health_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        status TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ingestions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        fileName TEXT NOT NULL,
        docId TEXT NOT NULL,
        chunksCreated INTEGER NOT NULL,
        replacedChunks INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS queries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        prompt TEXT NOT NULL,
        latencyMs INTEGER NOT NULL,
        contextCharsUsed INTEGER NOT NULL,
        sourcesJson TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ingestions_timestamp ON ingestions(timestamp);
      CREATE INDEX IF NOT EXISTS idx_queries_timestamp ON queries(timestamp);
    `);

    return { ok: true, path: auditDbPath };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown audit DB error",
    };
  }
}

function getDbOrThrow(): Database.Database {
  if (!db) {
    throw new Error("Audit DB not initialized. Call initAuditDb() first.");
  }
  return db;
}

export function logHealth(status: string): void {
  if (!db) return;
  const statement = db.prepare(
    "INSERT INTO health_checks (timestamp, status) VALUES (?, ?)",
  );
  statement.run(new Date().toISOString(), status);
}

export function logIngestion(args: {
  fileName: string;
  docId: string;
  chunksCreated: number;
  replacedChunks: number;
}): void {
  const database = getDbOrThrow();
  const stmt = database.prepare(
    `INSERT INTO ingestions (timestamp, fileName, docId, chunksCreated, replacedChunks)
     VALUES (?, ?, ?, ?, ?)`,
  );
  stmt.run(
    new Date().toISOString(),
    args.fileName,
    args.docId,
    args.chunksCreated,
    args.replacedChunks,
  );
}

export function logQuery(args: {
  question: string;
  answer: string;
  prompt: string;
  latencyMs: number;
  contextCharsUsed: number;
  chunks: Array<{
    id: string;
    docId: string;
    index: number;
    distance?: number;
  }>;
}): void {
  const database = getDbOrThrow();
  const sourcesJson = JSON.stringify(
    args.chunks.map((c) => ({
      id: c.id,
      docId: c.docId,
      index: c.index,
      distance: c.distance ?? null,
    })),
  );

  const stmt = database.prepare(
    `INSERT INTO queries (timestamp, question, answer, prompt, latencyMs, contextCharsUsed, sourcesJson)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  stmt.run(
    new Date().toISOString(),
    args.question,
    args.answer,
    args.prompt,
    args.latencyMs,
    args.contextCharsUsed,
    sourcesJson,
  );
}

export function getIngestionLog(limit = 20): IngestionLogRow[] {
  const database = getDbOrThrow();
  const stmt = database.prepare(
    `SELECT id, timestamp, fileName, docId, chunksCreated, replacedChunks
     FROM ingestions
     ORDER BY id DESC
     LIMIT ?`,
  );
  return stmt.all(limit) as IngestionLogRow[];
}

export function getAuditLog(
  limit = 20,
): Array<Omit<QueryLogRow, "sourcesJson"> & { sources: unknown }> {
  const database = getDbOrThrow();
  const stmt = database.prepare(
    `SELECT id, timestamp, question, answer, prompt, latencyMs, contextCharsUsed, sourcesJson
     FROM queries
     ORDER BY id DESC
     LIMIT ?`,
  );

  const rows = stmt.all(limit) as QueryLogRow[];
  return rows.map((r) => ({
    id: r.id,
    timestamp: r.timestamp,
    question: r.question,
    answer: r.answer,
    prompt: r.prompt,
    latencyMs: r.latencyMs,
    contextCharsUsed: r.contextCharsUsed,
    sources: safeJsonParse(r.sourcesJson),
  }));
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
}
