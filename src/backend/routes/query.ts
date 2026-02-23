import { Hono } from 'hono';
import { z } from 'zod';
import { embedText } from '../services/embedder.js';
import { generateAnswer, getPrompt } from '../services/llm.js';
import { mmrSearch } from '../services/vectorStore.js';
import { initAuditDb, logQuery } from '../db/audit.js';

const queryRouter = new Hono();
const DEFAULT_TOP_K = Number(process.env.DEFAULT_TOP_K ?? 5);
const CONTEXT_CHAR_BUDGET = Number(process.env.CONTEXT_CHAR_BUDGET ?? 6000);

const querySchema = z.object({
  question: z.string().min(1).max(1000),
  topK: z.number().int().min(1).max(20).optional(),
});

queryRouter.post('/', async (c) => {
  const audit = initAuditDb();
  if (!audit.ok) {
    return c.json({ error: audit.error }, 500);
  }

  const parsed = querySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: 'Invalid request body', details: parsed.error.flatten() }, 400);
  }

  const { question } = parsed.data;
  const topK = parsed.data.topK ?? DEFAULT_TOP_K;

  const startedAt = Date.now();

  const questionEmbedding = await embedText(question);
  const chunks = await mmrSearch(questionEmbedding, topK);

  const contextParts: string[] = [];
  let contextCharsUsed = 0;

  for (const chunk of chunks) {
    const annotated = `[${chunk.docId}:${chunk.index}] ${chunk.text}`;
    if (contextCharsUsed + annotated.length > CONTEXT_CHAR_BUDGET) {
      break;
    }
    contextParts.push(annotated);
    contextCharsUsed += annotated.length;
  }

  const context = contextParts.join('\n\n');
  const prompt = getPrompt(question, context);
  const answer = await generateAnswer({ question, context });
  const latencyMs = Date.now() - startedAt;

  logQuery({
    question,
    answer,
    prompt,
    latencyMs,
    contextCharsUsed,
    chunks,
  });

  return c.json({
    answer,
    latencyMs,
    contextCharsUsed,
    sources: chunks.map((chunk) => ({
      id: chunk.id,
      docId: chunk.docId,
      index: chunk.index,
      distance: chunk.distance,
    })),
  });
});

export default queryRouter;
