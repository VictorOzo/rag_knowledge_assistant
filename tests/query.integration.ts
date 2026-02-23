import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../src/backend/db/audit.js', () => ({
  initAuditDb: () => ({ ok: true as const, path: 'audit.db' }),
  logHealth: () => undefined,
}));

vi.mock('../src/backend/services/chroma.js', () => ({
  checkChroma: async () => ({ ok: true as const, collection: 'rag_docs' }),
}));

describe('health route integration', () => {
  it('returns health payload with mocked dependencies', async () => {
    const { default: healthRoute } = await import('../src/backend/routes/health.js');
    const app = new Hono();
    app.route('/health', healthRoute);

    const res = await app.request('/health');
    const json = (await res.json()) as { status: string; chroma: { ok: boolean }; auditDb: { ok: boolean } };

    expect(res.status).toBe(200);
    expect(json.status).toBe('ok');
    expect(json.chroma.ok).toBe(true);
    expect(json.auditDb.ok).toBe(true);
  });
});
