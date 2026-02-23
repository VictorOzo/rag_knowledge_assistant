import { Hono } from 'hono';
import { z } from 'zod';
import { getAuditLog, getIngestionLog, initAuditDb } from '../db/audit.js';
import { getStats } from '../services/vectorStore.js';

const auditRouter = new Hono();
const limitSchema = z.coerce.number().int().min(1).max(100).default(20);

auditRouter.get('/queries', (c) => {
  const audit = initAuditDb();
  if (!audit.ok) {
    return c.json({ error: audit.error }, 500);
  }

  const parsed = limitSchema.safeParse(c.req.query('limit'));
  const limit = parsed.success ? parsed.data : 20;
  return c.json({ items: getAuditLog(limit) });
});

auditRouter.get('/ingestions', (c) => {
  const audit = initAuditDb();
  if (!audit.ok) {
    return c.json({ error: audit.error }, 500);
  }

  const parsed = limitSchema.safeParse(c.req.query('limit'));
  const limit = parsed.success ? parsed.data : 20;
  return c.json({ items: getIngestionLog(limit) });
});

auditRouter.get('/stats', async (c) => {
  const audit = initAuditDb();
  if (!audit.ok) {
    return c.json({ error: audit.error }, 500);
  }

  const stats = await getStats();
  return c.json(stats);
});

export default auditRouter;
