import Database from 'better-sqlite3';
import { resolve } from 'node:path';

const auditDbPath = resolve(process.cwd(), process.env.AUDIT_DB_PATH ?? 'audit.db');

let db: Database.Database | null = null;

export function initAuditDb(): { ok: true; path: string } | { ok: false; error: string } {
  try {
    if (!db) {
      db = new Database(auditDbPath);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS health_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        status TEXT NOT NULL
      );
    `);

    return { ok: true, path: auditDbPath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Unknown audit DB error' };
  }
}

export function logHealth(status: string): void {
  if (!db) {
    return;
  }

  const statement = db.prepare('INSERT INTO health_checks (timestamp, status) VALUES (?, ?)');
  statement.run(new Date().toISOString(), status);
}
