import { Hono } from 'hono';
import { initAuditDb, logHealth } from '../db/audit.js';
import { checkChroma } from '../services/chroma.js';

const healthRoute = new Hono();

healthRoute.get('/', async (c) => {
  const auditDb = initAuditDb();
  const chroma = await checkChroma();

  const status = auditDb.ok && chroma.ok ? 'ok' : 'degraded';
  if (auditDb.ok) {
    logHealth(status);
  }

  return c.json({
    status: 'ok',
    time: new Date().toISOString(),
    models: {
      embed: process.env.EMBED_MODEL ?? 'nomic-embed-text',
      llm: process.env.LLM_MODEL ?? 'gemma3:4b',
    },
    chroma,
    auditDb,
  });
});

export default healthRoute;
