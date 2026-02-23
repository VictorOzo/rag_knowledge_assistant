const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const embedModel = process.env.EMBED_MODEL ?? 'nomic-embed-text';
const embedConcurrency = Number(process.env.EMBED_CONCURRENCY ?? 4);
const maxRetries = Number(process.env.EMBED_RETRIES ?? 3);

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function embedText(text: string): Promise<number[]> {
  let attempt = 0;

  while (attempt <= maxRetries) {
    try {
      const response = await fetch(`${ollamaBaseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: embedModel, prompt: text }),
      });

      if (!response.ok) {
        throw new Error(`Ollama embeddings failed (${response.status})`);
      }

      const payload = (await response.json()) as { embedding?: number[] };
      if (!payload.embedding || !Array.isArray(payload.embedding)) {
        throw new Error('Invalid embeddings payload');
      }

      return payload.embedding;
    } catch (error) {
      if (attempt >= maxRetries) {
        throw error;
      }

      const backoffMs = 200 * 2 ** attempt;
      await sleep(backoffMs);
      attempt += 1;
    }
  }

  throw new Error('Failed to generate embedding');
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const results: number[][] = new Array(texts.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < texts.length) {
      const current = cursor;
      cursor += 1;
      results[current] = await embedText(texts[current]);
    }
  }

  const workers = Array.from({ length: Math.min(embedConcurrency, Math.max(1, texts.length)) }, () => worker());
  await Promise.all(workers);
  return results;
}
