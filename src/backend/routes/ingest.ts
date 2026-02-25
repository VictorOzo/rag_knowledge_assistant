// src/backend/routes/ingest.ts
import { Hono } from "hono";
import { chunkText, hashContent } from "../services/chunker.js";
import { embedBatch } from "../services/embedder.js";
import { deleteByDocId, upsertChunks } from "../services/vectorStore.js";
import { initAuditDb, logIngestion } from "../db/audit.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// pdf-parse can be finicky with ESM; require() tends to be most compatible
const ingestRouter = new Hono();

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(["txt", "md", "pdf", "docx"]);

function getExtension(name: string): string {
  const parts = name.toLowerCase().split(".");
  return parts.length > 1 ? (parts.at(-1) ?? "") : "";
}

async function parsePdf(buffer: Buffer): Promise<string> {
  // If your setup uses pdfjs-dist instead, swap this accordingly.
  const pdfParse: unknown = require("pdf-parse-fork"); // recommended if you switched
  if (typeof pdfParse !== "function") {
    throw new Error(`PDF parser is not a function (typeof=${typeof pdfParse})`);
  }
  const result = await (pdfParse as (b: Buffer) => Promise<{ text?: string }>)(
    buffer,
  );
  return String(result?.text ?? "");
}

async function parseDocx(buffer: Buffer): Promise<string> {
  const mammoth: any = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer });
  return String(result?.value ?? "");
}

ingestRouter.post("/", async (c) => {
  const audit = initAuditDb();
  if (!audit.ok) {
    return c.json({ error: audit.error }, 500);
  }

  const body = await c.req.parseBody({ all: true });
  const fileInput = (body as any).file;
  const file = Array.isArray(fileInput) ? fileInput[0] : fileInput;

  if (!(file instanceof File)) {
    return c.json(
      { error: "Expected multipart form-data with a file field." },
      400,
    );
  }

  const ext = getExtension(file.name);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return c.json(
      { error: "Unsupported file type. Allowed: txt, md, pdf, docx." },
      400,
    );
  }

  if (file.size > MAX_FILE_BYTES) {
    return c.json({ error: "File too large. Max size is 10MB." }, 400);
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const docId = hashContent(bytes);

  let text = "";
  if (ext === "pdf") {
    try {
      text = await parsePdf(bytes);
    } catch (err) {
      return c.json(
        {
          error: "Failed to parse PDF",
          details: err instanceof Error ? err.message : String(err),
        },
        400,
      );
    }
  } else if (ext === "docx") {
    try {
      text = await parseDocx(bytes);
    } catch (err) {
      return c.json(
        {
          error: "Failed to parse DOCX",
          details: err instanceof Error ? err.message : String(err),
        },
        400,
      );
    }
  } else {
    text = bytes.toString("utf-8");
  }

  if (!text.trim()) {
    return c.json({ error: "No extractable text found in document." }, 400);
  }

  const chunks = chunkText(text).map((chunk, index) => ({
    ...chunk,
    docId,
    id: `${docId}:${index}`,
    index,
  }));

  const embeddings = await embedBatch(chunks.map((chunk) => chunk.text));
  const replacedChunks = await deleteByDocId(docId);
  await upsertChunks(chunks, embeddings);

  logIngestion({
    fileName: file.name,
    docId,
    chunksCreated: chunks.length,
    replacedChunks,
  });

  return c.json({
    docId,
    chunksCreated: chunks.length,
    replacedChunks,
  });
});

export default ingestRouter;
