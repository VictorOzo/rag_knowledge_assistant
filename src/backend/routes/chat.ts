import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { embedText } from '../services/embedder.js';
import { generateAnswerFromPrompt } from '../services/llm.js';
import { mmrSearch } from '../services/vectorStore.js';
import { fetchPageText, searchWeb, type WebSearchResult } from '../services/web.js';

const chatRouter = new Hono();

const DEFAULT_TOP_K = Number(process.env.DEFAULT_TOP_K ?? 4);
const CONTEXT_CHAR_BUDGET = Number(process.env.CONTEXT_CHAR_BUDGET ?? 3200);
const WEB_DISTANCE_THRESHOLD = Number(process.env.WEB_DISTANCE_THRESHOLD ?? 0.55);
const WEB_MAX_RESULTS = Number(process.env.WEB_MAX_RESULTS ?? 5);
const WEB_FETCH_PAGES = Number(process.env.WEB_FETCH_PAGES ?? 2);
const WEB_CONTEXT_CHAR_BUDGET = Number(process.env.WEB_CONTEXT_CHAR_BUDGET ?? 2000);
const LLM_NUM_PREDICT = Number(process.env.LLM_NUM_PREDICT ?? 200);
const LLM_TEMPERATURE = Number(process.env.LLM_TEMPERATURE ?? 0.2);
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE ?? '10m';
const WEB_RATE_LIMIT_RPM = Number(process.env.WEB_RATE_LIMIT_RPM ?? 12);

const RECENCY_HINTS = [
  'today',
  'latest',
  'current',
  'now',
  'weather',
  'news',
  'price',
  'stock',
  'score',
  '2026',
  '2025',
  'this week',
  'recent',
];

type ChatRole = 'user' | 'assistant';

const chatSchema = z.object({
  message: z.string().min(1).max(4000),
  history: z.array(
    z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string().min(1).max(4000),
    }),
  ).max(20).optional(),
  topK: z.number().int().min(1).max(20).optional(),
  web: z.enum(['off', 'auto', 'on']).optional(),
  docScope: z.object({
    docId: z.string().min(1).max(200).optional(),
  }).optional(),
});

type RateBucket = {
  tokens: number;
  lastRefillMs: number;
};

const ipBuckets = new Map<string, RateBucket>();

function shouldUseWebByRecency(text: string): boolean {
  const normalized = text.toLowerCase();
  return RECENCY_HINTS.some((hint) => normalized.includes(hint));
}

function takeLastHistoryTurns(history: { role: ChatRole; content: string }[], maxTurns = 6) {
  return history.slice(Math.max(0, history.length - maxTurns));
}

function buildPrompt(args: {
  message: string;
  history: { role: ChatRole; content: string }[];
  docContext: string;
  webContext: string;
}): string {
  const historyBlock = args.history
    .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`)
    .join('\n');

  return [
    'You are a helpful assistant with docs-first retrieval behavior.',
    'Use DOCUMENT CONTEXT as the primary source.',
    'Use WEB CONTEXT for freshness/time-sensitive facts when relevant.',
    'If document and web evidence conflict for time-sensitive facts, prefer web and mention the discrepancy clearly.',
    'If no evidence is available, say what is uncertain instead of fabricating.',
    'Keep the response concise and actionable.',
    'Citations are required for factual statements:',
    '- Document chunks: [DOC docId:index]',
    '- Web results: [WEB 1], [WEB 2], ... matching provided web sources list order.',
    '',
    'CONVERSATION HISTORY:',
    historyBlock || '[none]',
    '',
    'DOCUMENT CONTEXT:',
    args.docContext || '[none]',
    '',
    'WEB CONTEXT:',
    args.webContext || '[none]',
    '',
    `User message: ${args.message}`,
    'Answer:',
  ].join('\n');
}

function allowWebForIp(ip: string): boolean {
  const now = Date.now();
  const refillPerMs = WEB_RATE_LIMIT_RPM / 60_000;
  const existing = ipBuckets.get(ip) ?? { tokens: WEB_RATE_LIMIT_RPM, lastRefillMs: now };
  const elapsed = Math.max(0, now - existing.lastRefillMs);
  const replenished = Math.min(WEB_RATE_LIMIT_RPM, existing.tokens + elapsed * refillPerMs);

  if (replenished < 1) {
    ipBuckets.set(ip, { tokens: replenished, lastRefillMs: now });
    return false;
  }

  ipBuckets.set(ip, { tokens: replenished - 1, lastRefillMs: now });
  return true;
}

function getClientIp(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  const real = c.req.header('x-real-ip');
  if (real) {
    return real.trim();
  }
  return 'unknown';
}

chatRouter.post('/', async (c) => {
  try {
    const parsed = chatSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'Invalid request body', details: parsed.error.flatten() }, 400);
    }

    const startedAt = Date.now();
    const message = parsed.data.message;
    const history = takeLastHistoryTurns(parsed.data.history ?? [], 6);
    const topK = parsed.data.topK ?? DEFAULT_TOP_K;
    const webMode = parsed.data.web ?? 'auto';
    const docId = parsed.data.docScope?.docId;

    const embedStartedAt = Date.now();
    const questionEmbedding = await embedText(message);
    const embedMs = Date.now() - embedStartedAt;

    const searchStartedAt = Date.now();
    const chunks = await mmrSearch(questionEmbedding, topK, docId ? { docId } : undefined);
    const searchMs = Date.now() - searchStartedAt;

    const docContextParts: string[] = [];
    let contextCharsUsed = 0;

    for (const chunk of chunks) {
      const annotated = `[DOC ${chunk.docId}:${chunk.index}] ${chunk.text}`;
      if (contextCharsUsed + annotated.length > CONTEXT_CHAR_BUDGET) {
        break;
      }
      docContextParts.push(annotated);
      contextCharsUsed += annotated.length;
    }

    const ragMiss = chunks.length === 0 || contextCharsUsed === 0;
    const topDocDistance = chunks[0]?.distance;
    const lowRelevance = typeof topDocDistance === 'number' ? topDocDistance > WEB_DISTANCE_THRESHOLD : false;
    const recencyTrigger = shouldUseWebByRecency(message);

    let shouldUseWeb = false;
    let reasonWeb = '';

    if (webMode === 'on') {
      shouldUseWeb = true;
      reasonWeb = 'forced_on';
    } else if (webMode === 'auto') {
      if (recencyTrigger) {
        shouldUseWeb = true;
        reasonWeb = 'recency_keywords';
      } else if (ragMiss) {
        shouldUseWeb = true;
        reasonWeb = 'rag_miss';
      } else if (lowRelevance) {
        shouldUseWeb = true;
        reasonWeb = 'low_doc_relevance';
      }
    }

    let webMs = 0;
    let webSources: WebSearchResult[] = [];
    const webContextParts: string[] = [];

    if (shouldUseWeb) {
      const ip = getClientIp(c);
      if (!allowWebForIp(ip)) {
        shouldUseWeb = false;
        reasonWeb = 'rate_limited';
      }
    }

    if (shouldUseWeb) {
      const webStartedAt = Date.now();
      try {
        webSources = await searchWeb(message, WEB_MAX_RESULTS);

        const fetchCount = Math.min(WEB_FETCH_PAGES, webSources.length);
        let webChars = 0;

        for (let i = 0; i < fetchCount; i += 1) {
          const result = webSources[i];
          const pageText = await fetchPageText(result.url, 1200).catch(() => '');
          const section = [
            `[WEB ${i + 1}] ${result.title}`,
            result.snippet ? `Snippet: ${result.snippet}` : '',
            pageText ? `Page: ${pageText}` : '',
          ].filter(Boolean).join('\n');

          if (!section) continue;
          if (webChars + section.length > WEB_CONTEXT_CHAR_BUDGET) break;

          webContextParts.push(section);
          webChars += section.length;
        }
      } catch {
        shouldUseWeb = false;
        webSources = [];
      }
      webMs = Date.now() - webStartedAt;
    }

    const prompt = buildPrompt({
      message,
      history,
      docContext: docContextParts.join('\n\n'),
      webContext: webContextParts.join('\n\n'),
    });

    const llmStartedAt = Date.now();
    const answer = await generateAnswerFromPrompt({
      prompt,
      numPredict: LLM_NUM_PREDICT,
      temperature: LLM_TEMPERATURE,
      keepAlive: OLLAMA_KEEP_ALIVE,
    });
    const llmMs = Date.now() - llmStartedAt;
    const totalMs = Date.now() - startedAt;

    const response: Record<string, unknown> = {
      answer,
      used: {
        rag: docContextParts.length > 0,
        web: shouldUseWeb && webContextParts.length > 0,
      },
      timings: {
        embedMs,
        searchMs,
        webMs,
        llmMs,
        totalMs,
      },
      contextCharsUsed,
      sources: [
        ...chunks.map((chunk) => ({
          type: 'doc' as const,
          id: chunk.id,
          docId: chunk.docId,
          index: chunk.index,
          distance: chunk.distance,
        })),
        ...webSources.map((source) => ({
          type: 'web' as const,
          title: source.title,
          url: source.url,
          snippet: source.snippet,
        })),
      ],
    };

    if (process.env.NODE_ENV !== 'production') {
      response.debug = {
        reasonWeb: reasonWeb || undefined,
        ragChunks: chunks.length,
        topDocDistance: typeof topDocDistance === 'number' ? topDocDistance : null,
      };
    }

    return c.json(response);
  } catch (error) {
    const details = error instanceof Error ? error.message : 'Unknown chat error';
    return c.json({ error: 'Chat request failed', details }, 500);
  }
});

export default chatRouter;
