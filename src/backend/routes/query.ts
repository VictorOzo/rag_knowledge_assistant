import { Hono } from 'hono';
import { z } from 'zod';
import { embedText } from '../services/embedder.js';
import { generateAnswer, getPrompt } from '../services/llm.js';
import { mmrSearch } from '../services/vectorStore.js';
import { initAuditDb, logQuery } from '../db/audit.js';

const queryRouter = new Hono();
const DEFAULT_TOP_K = Number(process.env.DEFAULT_TOP_K ?? 4);
const CONTEXT_CHAR_BUDGET = Number(process.env.CONTEXT_CHAR_BUDGET ?? 3200);
const LLM_NUM_PREDICT = Number(process.env.LLM_NUM_PREDICT ?? 220);
const LLM_TEMPERATURE = Number(process.env.LLM_TEMPERATURE ?? 0.2);
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE ?? '10m';

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

  const embedStartedAt = Date.now();
  const questionEmbedding = await embedText(question);
  const embedMs = Date.now() - embedStartedAt;

  const searchStartedAt = Date.now();
  const chunks = await mmrSearch(questionEmbedding, topK);
  const searchMs = Date.now() - searchStartedAt;

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
  const llmStartedAt = Date.now();
  const answer = await generateAnswer({
    question,
    context,
    numPredict: LLM_NUM_PREDICT,
    temperature: LLM_TEMPERATURE,
    keepAlive: OLLAMA_KEEP_ALIVE,
  });
  const llmMs = Date.now() - llmStartedAt;
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
    timings: { embedMs, searchMs, llmMs },
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
