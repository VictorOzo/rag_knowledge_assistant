import { createHash } from 'node:crypto';

export type Chunk = {
  id: string;
  docId: string;
  index: number;
  text: string;
};

export function hashContent(content: Buffer | Uint8Array | string): string {
  const input = typeof content === 'string' ? Buffer.from(content, 'utf-8') : Buffer.from(content);
  return createHash('sha256').update(input).digest('hex');
}

export function chunkId(docId: string, chunkIndex: number): string {
  return `${docId}:${chunkIndex}`;
}

function preferredBreakIndex(windowText: string, minBreak: number): number {
  const sentenceEnd = Math.max(
    windowText.lastIndexOf('. '),
    windowText.lastIndexOf('? '),
    windowText.lastIndexOf('! '),
  );

  if (sentenceEnd >= minBreak) {
    return sentenceEnd + 1;
  }

  const newlineBreak = windowText.lastIndexOf('\n');
  if (newlineBreak >= minBreak) {
    return newlineBreak;
  }

  const spaceBreak = windowText.lastIndexOf(' ');
  if (spaceBreak >= minBreak) {
    return spaceBreak;
  }

  return windowText.length;
}

export function chunkText(
  text: string,
  options?: { maxChars?: number; overlapChars?: number; minChunkChars?: number },
): Chunk[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return [];
  }

  const maxChars = options?.maxChars ?? 1200;
  const overlapChars = Math.max(0, options?.overlapChars ?? 200);
  const minChunkChars = options?.minChunkChars ?? 300;

  const docId = hashContent(normalized);
  const chunks: Chunk[] = [];

  let start = 0;
  let idx = 0;

  while (start < normalized.length) {
    const end = Math.min(normalized.length, start + maxChars);
    const windowText = normalized.slice(start, end);
    const breakAt = preferredBreakIndex(windowText, Math.min(minChunkChars, Math.floor(windowText.length / 2)));
    const chunkTextValue = windowText.slice(0, breakAt).trim();

    if (chunkTextValue.length > 0) {
      chunks.push({
        id: chunkId(docId, idx),
        docId,
        index: idx,
        text: chunkTextValue,
      });
      idx += 1;
    }

    if (end >= normalized.length) {
      break;
    }

    const consumed = Math.max(1, breakAt);
    const nextStart = Math.max(0, start + consumed - overlapChars);
    start = nextStart > start ? nextStart : start + consumed;
  }

  return chunks;
}
