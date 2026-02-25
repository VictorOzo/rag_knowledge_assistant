# RAG Knowledge Assistant

A Retrieval-Augmented Generation (RAG) app for uploading documents, retrieving relevant chunks, and generating grounded answers with source references.

## What this app does end-to-end

1. **Ingest documents** (`.txt`, `.md`, `.pdf`) via the frontend or API.
2. **Extract text** (including PDF parsing) and **chunk** content into overlapping pieces.
3. Generate **embeddings** using Ollama's embedding model.
4. Store chunk vectors + metadata in **Chroma**.
5. Accept user questions from the Chat tab.
6. Embed the question and retrieve relevant chunks from Chroma (MMR + similarity flow).
7. Build a context window and ask Ollama LLM to answer using only that context.
8. Return answer + chunk sources to the frontend.
9. Persist audit records (queries + ingestions + health checks) in **SQLite**.

## Tech stack

- **Backend API:** Hono + TypeScript
- **Frontend:** Vite (vanilla) + TypeScript + plain CSS
- **LLM + embeddings:** Ollama
- **Vector DB:** Chroma
- **Audit persistence:** SQLite (`better-sqlite3`)

## Features

- Three-tab frontend:
  - **Chat**: ask questions, see answer + source chunks, topK control, cancel requests.
  - **Ingest**: upload one or many files sequentially, with per-file results.
  - **Audit**: inspect recent queries, recent ingestions, and vector-store stats.
- Backend health polling every 15 seconds from frontend.
- Safe frontend rendering: all response text is rendered via `textContent` (no `dangerouslySetInnerHTML`).

## Project structure (brief)

```text
src/
  backend/
    db/         # SQLite audit logging
    routes/     # health, ingest, query, audit API routes
    services/   # chunking, embeddings, llm calls, vector-store operations
  frontend/
    styles/     # app CSS
    index.html  # frontend layout
    main.ts     # frontend behavior and API calls
tests/          # unit/integration tests
```

## Local development

## Prerequisites

- Node.js 18+
- Ollama running locally (with both LLM and embedding model pulled)
- Chroma server running locally

### 1) Install dependencies

```bash
npm install
```

### 2) Start services

You can run all services together:

```bash
npm run dev
```

Or run separately:

```bash
npm run chroma
npm run dev:backend
npm run dev:frontend
```

- Frontend default: `http://localhost:5173`
- Backend default: `http://127.0.0.1:3001` (or `http://localhost:3001`)
- Chroma default: `http://localhost:8000`

## Environment variables

Typical variables used in this project:

- `PORT` (backend HTTP port, default `3001`)
- `FRONTEND_ORIGIN` (CORS allow-origin, default `http://localhost:5173`)
- `VITE_API_BASE` (frontend API base URL, default `http://127.0.0.1:3001`)
- `AUDIT_DB_PATH` (SQLite path, default `audit.db`)
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

### Ingest (multipart with `curl.exe`)

```powershell
curl.exe -X POST "http://127.0.0.1:3001/ingest" `
  -F "file=@C:/path/to/notes.md"
```

### Query (`Invoke-RestMethod`)

```powershell
$body = @{ question = "What are the main points in notes.md?"; topK = 5 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3001/query" -ContentType "application/json" -Body $body
```

## Troubleshooting

- **404 on API routes**
  - Ensure backend routes are mounted and backend is running on the expected port.
  - Confirm frontend `VITE_API_BASE` points to that backend URL.

- **Windows `curl` quoting/form issues**
  - Prefer `curl.exe` (not PowerShell alias) for multipart uploads.
  - For JSON requests, `Invoke-RestMethod` is usually easier and less error-prone.

- **`pdf-parse` import/runtime issues (ESM/CJS shape)**
  - This project uses dynamic import and falls back to `mod.default ?? mod` to support both module shapes.

## Security note

The frontend intentionally renders all model answers, source text, and audit text with DOM `textContent` to reduce XSS risk. No HTML from API responses is injected into the page.
