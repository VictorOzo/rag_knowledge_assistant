import { Hono } from 'hono';
import pdfParse from 'pdf-parse';
import { chunkText, hashContent } from '../services/chunker.js';
import { embedBatch } from '../services/embedder.js';
import { deleteByDocId, upsertChunks } from '../services/vectorStore.js';
import { initAuditDb, logIngestion } from '../db/audit.js';

const ingestRouter = new Hono();

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['txt', 'md', 'pdf']);

function getExtension(name: string): string {
  const parts = name.toLowerCase().split('.');
  return parts.length > 1 ? parts.at(-1) ?? '' : '';
}

ingestRouter.post('/', async (c) => {
  const audit = initAuditDb();
  if (!audit.ok) {
    return c.json({ error: audit.error }, 500);
  }

  const body = await c.req.parseBody({ all: true });
  const fileInput = body.file;
  const file = Array.isArray(fileInput) ? fileInput[0] : fileInput;

  if (!(file instanceof File)) {
    return c.json({ error: 'Expected multipart form-data with a file field.' }, 400);
  }

  const ext = getExtension(file.name);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return c.json({ error: 'Unsupported file type. Allowed: txt, md, pdf.' }, 400);
  }

  if (file.size > MAX_FILE_BYTES) {
    return c.json({ error: 'File too large. Max size is 10MB.' }, 400);
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const docId = hashContent(bytes);

  let text = '';
  if (ext === 'pdf') {
    const pdfResult = await pdfParse(bytes);
    text = pdfResult.text;
  } else {
    text = bytes.toString('utf-8');
  }

  const chunks = chunkText(text).map((chunk, index) => ({ ...chunk, docId, id: `${docId}:${index}`, index }));

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
