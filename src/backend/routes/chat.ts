import { Hono, type Context } from "hono";
import { z } from "zod";
import { embedText } from "../services/embedder.js";
import { generateAnswer } from "../services/llm.js";
import { mmrSearch } from "../services/vectorStore.js";
import {
  fetchPageText,
  searchWeb,
  type WebSearchResult,
} from "../services/web.js";

const chatRouter = new Hono();

const DEFAULT_TOP_K = Number(process.env.DEFAULT_TOP_K ?? 4);
const CONTEXT_CHAR_BUDGET = Number(process.env.CONTEXT_CHAR_BUDGET ?? 3200);

const WEB_DISTANCE_THRESHOLD = Number(
  process.env.WEB_DISTANCE_THRESHOLD ?? 0.55,
);
const WEB_MAX_RESULTS = Number(process.env.WEB_MAX_RESULTS ?? 5);
const WEB_FETCH_PAGES = Number(process.env.WEB_FETCH_PAGES ?? 2);
const WEB_CONTEXT_CHAR_BUDGET = Number(
  process.env.WEB_CONTEXT_CHAR_BUDGET ?? 2000,
);

const LLM_NUM_PREDICT = Number(process.env.LLM_NUM_PREDICT ?? 200);
const LLM_TEMPERATURE = Number(process.env.LLM_TEMPERATURE ?? 0.2);
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE ?? "10m";

const WEB_RATE_LIMIT_RPM = Number(process.env.WEB_RATE_LIMIT_RPM ?? 12);

const RECENCY_HINTS = [
  "today",
  "latest",
  "current",
  "now",
  "weather",
  "news",
  "price",
  "stock",
  "score",
  "this week",
  "recent",
];

type ChatRole = "user" | "assistant";

const chatSchema = z.object({
  message: z.string().min(1).max(4000),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(4000),
      }),
    )
    .max(20)
    .optional(),
  topK: z.number().int().min(1).max(20).optional(),
  web: z.enum(["off", "auto", "on"]).optional(),
  docScope: z
    .object({
      docId: z.string().min(1).max(200).optional(),
    })
    .optional(),
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

function takeLastHistoryTurns(
  history: { role: ChatRole; content: string }[],
  maxTurns = 6,
) {
  return history.slice(Math.max(0, history.length - maxTurns));
}

function allowWebForIp(ip: string): boolean {
  const now = Date.now();
  const refillPerMs = WEB_RATE_LIMIT_RPM / 60_000;
  const existing = ipBuckets.get(ip) ?? {
    tokens: WEB_RATE_LIMIT_RPM,
    lastRefillMs: now,
  };
  const elapsed = Math.max(0, now - existing.lastRefillMs);
  const replenished = Math.min(
    WEB_RATE_LIMIT_RPM,
    existing.tokens + elapsed * refillPerMs,
  );

  if (replenished < 1) {
    ipBuckets.set(ip, { tokens: replenished, lastRefillMs: now });
    return false;
  }

  ipBuckets.set(ip, { tokens: replenished - 1, lastRefillMs: now });
  return true;
}

function getClientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  const real = c.req.header("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

function isSmallTalk(message: string): boolean {
  const m = message.trim().toLowerCase();
  if (m.length <= 2) return true;
  const smallTalk = [
    "hi",
    "hello",
    "hey",
    "good morning",
    "good afternoon",
    "good evening",
    "how are you",
    "what's up",
    "thanks",
    "thank you",
  ];
  return smallTalk.some(
    (s) => m === s || m.startsWith(s + " ") || m.includes(s),
  );
}

function buildRagContext(
  chunks: Array<{ docId: string; index: number; text: string }>,
  budget: number,
) {
  const parts: string[] = [];
  let used = 0;

  for (const chunk of chunks) {
    const annotated = `[DOC ${chunk.docId}:${chunk.index}] ${chunk.text}`;
    if (used + annotated.length > budget) break;
    parts.push(annotated);
    used += annotated.length;
  }

  return { text: parts.join("\n\n"), usedChars: used, parts };
}

function buildWebContext(
  webSources: WebSearchResult[],
  pageTexts: string[],
  budget: number,
) {
  const parts: string[] = [];
  let used = 0;

  for (let i = 0; i < webSources.length; i += 1) {
    const src = webSources[i];
    const pageText = pageTexts[i] ?? "";
    const section = [
      `[WEB ${i + 1}] ${src.title}`,
      src.snippet ? `Snippet: ${src.snippet}` : "",
      pageText ? `Page: ${pageText}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    if (!section) continue;
    if (used + section.length > budget) break;

    parts.push(section);
    used += section.length;
  }

  return { text: parts.join("\n\n"), usedChars: used, parts };
}

function buildChatContext(args: {
  history: { role: ChatRole; content: string }[];
  message: string;
}): string {
  const historyBlock = args.history
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n");

  return [
    "You are a helpful assistant.",
    "Respond naturally and conversationally.",
    "If the user asks about uploaded documents, say they should upload documents first.",
    "",
    "CONVERSATION HISTORY:",
    historyBlock || "[none]",
    "",
    `User message: ${args.message}`,
    "Answer:",
  ].join("\n");
}

function buildDocsFirstContext(args: {
  history: { role: ChatRole; content: string }[];
  message: string;
  docContext: string;
  webContext: string;
}): string {
  const historyBlock = args.history
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n");

  return [
    "You are a helpful assistant with docs-first retrieval behavior.",
    "Use DOCUMENT CONTEXT as the primary source for answers about uploaded documents.",
    "Use WEB CONTEXT only for freshness/time-sensitive facts when relevant.",
    "If document and web evidence conflict for time-sensitive facts, prefer web and mention the discrepancy clearly.",
    "If evidence is missing, say what is uncertain instead of fabricating.",
    "Keep the response concise and actionable.",
    "Citations are required for factual statements:",
    "- Document chunks: [DOC docId:index]",
    "- Web results: [WEB 1], [WEB 2], ... matching provided web sources list order.",
    "",
    "CONVERSATION HISTORY:",
    historyBlock || "[none]",
    "",
    "DOCUMENT CONTEXT:",
    args.docContext || "[none]",
    "",
    "WEB CONTEXT:",
    args.webContext || "[none]",
    "",
    `User message: ${args.message}`,
    "Answer:",
  ].join("\n");
}

chatRouter.post("/", async (c) => {
  try {
    const parsed = chatSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        400,
      );
    }

    const startedAt = Date.now();

    const message = parsed.data.message;
    const history = takeLastHistoryTurns(parsed.data.history ?? [], 6);
    const topK = parsed.data.topK ?? DEFAULT_TOP_K;
    const webMode = parsed.data.web ?? "auto";
    const docId = parsed.data.docScope?.docId;

    // If user is clearly small-talk and web isn't forced, skip RAG entirely.
    const smallTalk = isSmallTalk(message);

    let embedMs = 0;
    let searchMs = 0;
    let webMs = 0;
    let llmMs = 0;

    let chunks: any[] = [];
    let contextCharsUsed = 0;
    let docContextText = "";
    let reasonWeb = "";
    let shouldUseWeb = false;
    let webSources: WebSearchResult[] = [];
    let webContextText = "";
    let topDocDistance: number | null = null;

    if (!smallTalk) {
      const embedStartedAt = Date.now();
      const questionEmbedding = await embedText(message);
      embedMs = Date.now() - embedStartedAt;

      const searchStartedAt = Date.now();
      // NOTE: if your mmrSearch does NOT support docId filtering, remove the 3rd arg.
      chunks = await mmrSearch(
        questionEmbedding,
        topK,
        docId ? { docId } : undefined,
      );
      searchMs = Date.now() - searchStartedAt;

      topDocDistance =
        typeof chunks?.[0]?.distance === "number" ? chunks[0].distance : null;

      const rag = buildRagContext(chunks, CONTEXT_CHAR_BUDGET);
      docContextText = rag.text;
      contextCharsUsed = rag.usedChars;

      const ragMiss = chunks.length === 0 || contextCharsUsed === 0;
      const lowRelevance =
        topDocDistance !== null
          ? topDocDistance > WEB_DISTANCE_THRESHOLD
          : false;
      const recencyTrigger = shouldUseWebByRecency(message);

      if (webMode === "on") {
        shouldUseWeb = true;
        reasonWeb = "forced_on";
      } else if (webMode === "auto") {
        if (recencyTrigger) {
          shouldUseWeb = true;
          reasonWeb = "recency_keywords";
        } else if (ragMiss) {
          shouldUseWeb = true;
          reasonWeb = "rag_miss";
        } else if (lowRelevance) {
          shouldUseWeb = true;
          reasonWeb = "low_doc_relevance";
        }
      }
    } else {
      // Small talk: only allow web if forced on (rarely needed for "hello").
      if (webMode === "on") {
        shouldUseWeb = true;
        reasonWeb = "forced_on_smalltalk";
      }
    }

    if (shouldUseWeb) {
      const ip = getClientIp(c);
      if (!allowWebForIp(ip)) {
        shouldUseWeb = false;
        reasonWeb = "rate_limited";
      }
    }

    if (shouldUseWeb) {
      const webStartedAt = Date.now();
      try {
        webSources = await searchWeb(message, WEB_MAX_RESULTS);
        const fetchCount = Math.min(WEB_FETCH_PAGES, webSources.length);

        const pageTexts: string[] = [];
        for (let i = 0; i < fetchCount; i += 1) {
          const pageText = await fetchPageText(webSources[i].url, 1200).catch(
            () => "",
          );
          pageTexts.push(pageText);
        }

        const web = buildWebContext(
          webSources.slice(0, fetchCount),
          pageTexts,
          WEB_CONTEXT_CHAR_BUDGET,
        );
        webContextText = web.text;
      } catch {
        shouldUseWeb = false;
        webSources = [];
        webContextText = "";
      }
      webMs = Date.now() - webStartedAt;
    }

    // SWITCH: if we have no doc/web context and user is small talk -> normal chat prompt.
    // Otherwise docs-first prompt (even if context is empty, it will encourage honesty).
    const hasEvidence =
      Boolean(docContextText.trim()) || Boolean(webContextText.trim());

    const promptContext = hasEvidence
      ? buildDocsFirstContext({
          history,
          message,
          docContext: docContextText,
          webContext: webContextText,
        })
      : buildChatContext({ history, message });

    const llmStartedAt = Date.now();
    const answer = await generateAnswer({
      question: message,
      context: promptContext,
      numPredict: LLM_NUM_PREDICT,
      temperature: LLM_TEMPERATURE,
      keepAlive: OLLAMA_KEEP_ALIVE,
    });
    llmMs = Date.now() - llmStartedAt;

    const totalMs = Date.now() - startedAt;

    const response: Record<string, unknown> = {
      answer,
      used: {
        rag: Boolean(docContextText.trim()),
        web: shouldUseWeb && Boolean(webContextText.trim()),
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
          type: "doc" as const,
          id: chunk.id,
          docId: chunk.docId,
          index: chunk.index,
          distance: chunk.distance,
        })),
        ...webSources.map((source) => ({
          type: "web" as const,
          title: source.title,
          url: source.url,
          snippet: source.snippet,
        })),
      ],
    };

    if (process.env.NODE_ENV !== "production") {
      response.debug = {
        reasonWeb: reasonWeb || undefined,
        ragChunks: chunks.length,
        topDocDistance,
        smallTalk,
        hasEvidence,
      };
    }

    return c.json(response);
  } catch (error) {
    const details =
      error instanceof Error ? error.message : "Unknown chat error";
    return c.json({ error: "Chat request failed", details }, 500);
  }
});

export default chatRouter;
