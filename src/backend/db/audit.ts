import Database from 'better-sqlite3';
import { resolve } from 'node:path';

const auditDbPath = resolve(process.cwd(), process.env.AUDIT_DB_PATH ?? 'audit.db');

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(auditDbPath);
    db.pragma('journal_mode = WAL');
  }
  return db;
}

export function initAuditDb(): { ok: true; path: string } | { ok: false; error: string } {
  try {
    const conn = getDb();

    conn.exec(`
      CREATE TABLE IF NOT EXISTS health_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        status TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ingestions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        file_name TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        chunks_created INTEGER NOT NULL,
        replaced_chunks INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS queries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        prompt TEXT NOT NULL,
        latency_ms INTEGER NOT NULL,
        context_chars_used INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS retrieved_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query_id INTEGER NOT NULL,
        chunk_id TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        distance REAL NOT NULL,
        text TEXT NOT NULL,
        FOREIGN KEY (query_id) REFERENCES queries(id)
      );
    `);

    return { ok: true, path: auditDbPath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Unknown audit DB error' };
  }
}

export function logHealth(status: string): void {
  const conn = getDb();
  conn.prepare('INSERT INTO health_checks (timestamp, status) VALUES (?, ?)').run(new Date().toISOString(), status);
}

export function logIngestion(input: {
  fileName: string;
  docId: string;
  chunksCreated: number;
  replacedChunks: number;
}): void {
  const conn = getDb();
  conn.prepare(
    `INSERT INTO ingestions (timestamp, file_name, doc_id, chunks_created, replaced_chunks)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(new Date().toISOString(), input.fileName, input.docId, input.chunksCreated, input.replacedChunks);
}

export function logQuery(input: {
  question: string;
  answer: string;
  prompt: string;
  latencyMs: number;
  contextCharsUsed: number;
  chunks: Array<{ id: string; docId: string; index: number; distance: number; text: string }>;
}): void {
  const conn = getDb();
  const tx = conn.transaction(() => {
    const result = conn
      .prepare(
        `INSERT INTO queries (timestamp, question, answer, prompt, latency_ms, context_chars_used)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(new Date().toISOString(), input.question, input.answer, input.prompt, input.latencyMs, input.contextCharsUsed);

    const queryId = Number(result.lastInsertRowid);
    const insertChunk = conn.prepare(
      `INSERT INTO retrieved_chunks (query_id, chunk_id, doc_id, chunk_index, distance, text)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    for (const chunk of input.chunks) {
      insertChunk.run(queryId, chunk.id, chunk.docId, chunk.index, chunk.distance, chunk.text);
    }
  });

  tx();
}

export function getAuditLog(limit = 20): Array<Record<string, unknown>> {
  const conn = getDb();
  const rows = conn
    .prepare(
      `SELECT q.id, q.timestamp, q.question, q.answer, q.latency_ms, q.context_chars_used,
              COUNT(rc.id) AS chunk_count
       FROM queries q
       LEFT JOIN retrieved_chunks rc ON rc.query_id = q.id
       GROUP BY q.id
       ORDER BY q.id DESC
       LIMIT ?`,
    )
    .all(limit);

  return rows as Array<Record<string, unknown>>;
}

export function getIngestionLog(limit = 20): Array<Record<string, unknown>> {
  const conn = getDb();
  return conn.prepare('SELECT * FROM ingestions ORDER BY id DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>;
}
