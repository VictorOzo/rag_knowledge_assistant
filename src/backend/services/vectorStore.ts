import { ChromaClient } from 'chromadb';
import type { Chunk } from './chunker.js';

export type RetrievedChunk = {
  id: string;
  text: string;
  docId: string;
  index: number;
  distance: number;
};

const chromaUrl = process.env.CHROMA_URL ?? 'http://localhost:8000';
const collectionName = process.env.CHROMA_COLLECTION ?? 'rag_docs';

let cachedCollection: Awaited<ReturnType<ChromaClient['getOrCreateCollection']>> | null = null;

async function getCollection() {
  if (cachedCollection) {
    return cachedCollection;
  }

  const client = new ChromaClient({ path: chromaUrl });
  cachedCollection = await client.getOrCreateCollection({
    name: collectionName,
    metadata: { 'hnsw:space': 'cosine' },
  });
  return cachedCollection;
}

export async function upsertChunks(chunks: Chunk[], embeddings: number[][]): Promise<void> {
  if (chunks.length === 0) {
    return;
  }

  const collection = await getCollection();
  await collection.upsert({
    ids: chunks.map((chunk) => chunk.id),
    documents: chunks.map((chunk) => chunk.text),
    embeddings,
    metadatas: chunks.map((chunk) => ({ docId: chunk.docId, index: chunk.index })),
  });
}

export async function similaritySearch(queryEmbedding: number[], topK: number): Promise<RetrievedChunk[]> {
  const collection = await getCollection();
  const result = await collection.query({
    queryEmbeddings: [queryEmbedding],
    nResults: topK,
    include: ['documents', 'metadatas', 'distances'],
  });

  const ids = result.ids[0] ?? [];
  const docs = result.documents?.[0] ?? [];
  const metadatas = result.metadatas?.[0] ?? [];
  const distances = result.distances?.[0] ?? [];

  return ids.map((id, idx) => ({
    id,
    text: String(docs[idx] ?? ''),
    docId: String((metadatas[idx] as { docId?: string } | null)?.docId ?? ''),
    index: Number((metadatas[idx] as { index?: number } | null)?.index ?? idx),
    distance: Number(distances[idx] ?? 1),
  }));
}

export async function mmrSearch(queryEmbedding: number[], topK: number): Promise<RetrievedChunk[]> {
  const candidates = await similaritySearch(queryEmbedding, Math.min(30, topK * 3));
  const selected: RetrievedChunk[] = [];

  while (selected.length < topK && candidates.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      const relevance = 1 - candidate.distance;
      const diversityPenalty = selected.some((picked) => picked.docId === candidate.docId) ? 0.2 : 0;
      const score = relevance - diversityPenalty;

      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    selected.push(candidates.splice(bestIndex, 1)[0]);
  }

  return selected;
}

export async function deleteByDocId(docId: string): Promise<number> {
  const collection = await getCollection();
  const result = await collection.get({ where: { docId } as never, include: [] });
  const ids = result.ids ?? [];

  if (ids.length > 0) {
    await collection.delete({ ids });
  }

  return ids.length;
}

export async function getStats(): Promise<{ collection: string; totalChunks: number }> {
  const collection = await getCollection();
  const totalChunks = await collection.count();
  return { collection: collectionName, totalChunks };
}
