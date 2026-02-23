import { describe, expect, it } from 'vitest';
import { chunkId, chunkText, hashContent } from '../src/backend/services/chunker.js';

describe('chunker', () => {
  it('produces deterministic hash for same content bytes', () => {
    const a = hashContent(Buffer.from('hello'));
    const b = hashContent(Buffer.from('hello'));
    expect(a).toBe(b);
  });

  it('builds deterministic chunk ids', () => {
    expect(chunkId('doc123', 0)).toBe('doc123:0');
    expect(chunkId('doc123', 7)).toBe('doc123:7');
  });

  it('chunks text with overlap-aware progression', () => {
    const text = 'One. Two. Three. Four. Five. Six. Seven. Eight. Nine. Ten.';
    const chunks = chunkText(text, { maxChars: 18, overlapChars: 5, minChunkChars: 8 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].id.endsWith(':0')).toBe(true);
    expect(chunks[1].id.endsWith(':1')).toBe(true);
  });
});
