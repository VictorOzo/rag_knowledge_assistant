# RAG Knowledge Assistant

A Retrieval-Augmented Generation (RAG) app for uploading documents, retrieving relevant chunks, and generating grounded answers with source references.

## What this app does end-to-end

1. **Ingest documents** (`.txt`, `.md`, `.pdf`) via the frontend or API.
2. Extract text and chunk content into overlapping pieces.
3. Generate embeddings using Ollama's embedding model.
4. Store chunk vectors + metadata in Chroma.
5. Accept user questions in chat.
6. Retrieve document context first (MMR search) and optionally add web context.
7. Ask Ollama to answer with citations, preferring docs first and web second.
8. Return answer + timing breakdown + sources to the frontend.
9. Persist audit records in SQLite.

## Docs-first, web-second behavior

`POST /chat` always starts with document retrieval. Web usage is controlled by `web` mode:

- `off`: never use web.
- `auto` (default): use web when recency keywords are detected, RAG misses, or top match relevance is weak.
- `on`: always attempt web enrichment.

If no documents are ingested, chat still works as a normal assistant (web in `auto` or `on`, or model-only when web is disabled/unavailable).

## Tech stack

- **Backend API:** Hono + TypeScript
- **Frontend:** Vite (vanilla) + TypeScript + plain CSS
- **LLM + embeddings:** Ollama
- **Vector DB:** Chroma
- **Audit persistence:** SQLite (`better-sqlite3`)

## Features

- Three-tab frontend:
  - **Chat**: ask questions, topK control, web mode toggle, cancel requests.
  - **Ingest**: upload one or many files sequentially.
  - **Audit**: inspect recent queries, ingestions, and vector-store stats.
- `POST /chat` response includes:
  - `used` flags (rag/web), detailed timings, context usage, and source lists.
- Safe frontend rendering: all response text uses `textContent` (no raw HTML injection).

## Project structure

```text
src/
  backend/
    db/
    routes/     # health, ingest, query, chat, audit
    services/   # chunking, embeddings, llm, vector-store, web
  frontend/
    index.html
    main.ts
    styles/
```

## Local development

### Prerequisites

- Node.js 18+
- Ollama running locally (LLM + embedding model pulled)
- Chroma server running locally

### Install

```bash
npm install
```

### Start

```bash
npm run dev
```

Or separately:

```bash
npm run chroma
npm run dev:backend
npm run dev:frontend
```

## Environment variables

Core:

- `PORT` (default `3001`)
- `FRONTEND_ORIGIN` (default `http://localhost:5173`)
- `VITE_API_BASE` (default `http://127.0.0.1:3001`)
- `AUDIT_DB_PATH` (default `audit.db`)
- `CHROMA_URL` (default `http://localhost:8000`)
- `CHROMA_COLLECTION` (default `rag_docs`)
- `OLLAMA_BASE_URL` (default `http://localhost:11434`)
- `LLM_MODEL` (default `gemma3:4b`)
- `EMBED_MODEL` (default `nomic-embed-text`)
- `DEFAULT_TOP_K` (default `4`)
- `CONTEXT_CHAR_BUDGET` (default `3200`)
- `LLM_NUM_PREDICT` (default `220`)
- `LLM_TEMPERATURE` (default `0.2`)
- `OLLAMA_KEEP_ALIVE` (default `10m`)
- `EMBED_CONCURRENCY` (default `4`)
- `EMBED_RETRIES` (default `3`)

### Example `.env`

```env
PORT=3001
FRONTEND_ORIGIN=http://localhost:5173
VITE_API_BASE=http://127.0.0.1:3001
AUDIT_DB_PATH=audit.db
CHROMA_URL=http://localhost:8000
CHROMA_COLLECTION=rag_docs
OLLAMA_BASE_URL=http://localhost:11434
LLM_MODEL=gemma3:4b
EMBED_MODEL=nomic-embed-text
DEFAULT_TOP_K=4
CONTEXT_CHAR_BUDGET=3200
LLM_NUM_PREDICT=220
LLM_TEMPERATURE=0.2
OLLAMA_KEEP_ALIVE=10m
```


## Performance tuning knobs

For faster responses and better latency/quality tradeoffs, tune:

- `DEFAULT_TOP_K`: fallback retrieval depth when client does not send `topK` (UI still overrides this when set).
- `CONTEXT_CHAR_BUDGET`: max characters included in retrieved context before LLM call.
- `LLM_NUM_PREDICT`: hard cap on generated tokens from Ollama (`options.num_predict`).
- `OLLAMA_KEEP_ALIVE`: keeps model loaded between requests to avoid cold starts.

## API examples (PowerShell-friendly)

### Ingest

```bash
curl -X POST "http://127.0.0.1:3001/ingest" -F "file=@/path/to/file.md"
```

### Chat (web auto)

```bash
curl -X POST "http://127.0.0.1:3001/chat" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "What changed in NVIDIA stock today?",
    "topK": 4,
    "web": "auto"
  }'
```

### Chat (web off)

```bash
curl -X POST "http://127.0.0.1:3001/chat" \
  -H "Content-Type: application/json" \
  -d '{"message":"Summarize my uploaded architecture doc", "web":"off"}'
```

### Chat (web on)

```bash
curl -X POST "http://127.0.0.1:3001/chat" \
  -H "Content-Type: application/json" \
  -d '{"message":"Give me latest weather in Tokyo", "web":"on"}'
```

## Troubleshooting

- **Web search returns empty**
  - Some networks block DuckDuckGo HTML endpoint. Try again or switch network.
  - Keep `web=off` for docs-only responses.

- **Timeouts on web mode**
  - Lower `WEB_FETCH_PAGES` and/or `WEB_MAX_RESULTS`.
  - Increase `WEB_TIMEOUT_MS` if your network is slow.

- **CORS errors from frontend**
  - Ensure backend `FRONTEND_ORIGIN` matches your frontend URL.

- **`chroma` command missing**
  - Install Chroma CLI or run a containerized Chroma instance.

## Security note

The frontend renders model answers and source text with `textContent` to reduce XSS risk.
