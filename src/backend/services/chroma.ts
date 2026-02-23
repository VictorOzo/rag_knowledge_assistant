import { ChromaClient } from 'chromadb';

export async function checkChroma(): Promise<{ ok: true; collection: string } | { ok: false; error: string }> {
  const chromaUrl = process.env.CHROMA_URL ?? 'http://localhost:8000';
  const collectionName = process.env.CHROMA_COLLECTION ?? 'rag_docs';

  try {
    const client = new ChromaClient({ path: chromaUrl });
    await client.getOrCreateCollection({
      name: collectionName,
      metadata: { 'hnsw:space': 'cosine' },
    });

    return { ok: true, collection: collectionName };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Unknown Chroma error' };
  }
}
