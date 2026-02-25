type WebSearchResult = {
  title: string;
  url: string;
  snippet?: string;
};

type CacheEntry = {
  expiresAt: number;
  items: WebSearchResult[];
};

const SEARCH_TIMEOUT_MS = Number(process.env.WEB_TIMEOUT_MS ?? 8000);
const CACHE_TTL_MS = Number(process.env.WEB_CACHE_TTL_MS ?? 300000);
const DDG_SEARCH_URL = 'https://html.duckduckgo.com/html/';

const searchCache = new Map<string, CacheEntry>();

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x2F;/g, '/');
}

function stripHtml(value: string): string {
  return decodeHtml(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractDdgUrl(rawHref: string): string | null {
  if (!rawHref) return null;
  if (rawHref.startsWith('/l/?')) {
    const localUrl = new URL(rawHref, 'https://duckduckgo.com');
    const uddg = localUrl.searchParams.get('uddg');
    return uddg && isHttpUrl(uddg) ? uddg : null;
  }
  return isHttpUrl(rawHref) ? rawHref : null;
}

export async function searchWeb(query: string, limit = 5): Promise<WebSearchResult[]> {
  const key = query.trim().toLowerCase();
  const now = Date.now();
  const cached = searchCache.get(key);

  if (cached && cached.expiresAt > now) {
    return cached.items.slice(0, limit);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  try {
    const body = new URLSearchParams({ q: query });
    const response = await fetch(DDG_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'rag-knowledge-assistant/1.0',
      },
      body: body.toString(),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Web search failed (${response.status} ${response.statusText})`);
    }

    const html = await response.text();
    const results: WebSearchResult[] = [];
    const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;

    while ((match = resultRegex.exec(html)) && results.length < limit) {
      const resolvedUrl = extractDdgUrl(decodeHtml(match[1]));
      if (!resolvedUrl) continue;

      const title = stripHtml(match[2]).slice(0, 200);
      if (!title) continue;

      const afterMatch = html.slice(match.index, Math.min(html.length, match.index + 1800));
      const snippetMatch = afterMatch.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)
        ?? afterMatch.match(/<div[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
      const snippet = snippetMatch ? stripHtml(snippetMatch[1]).slice(0, 320) : undefined;

      results.push({ title, url: resolvedUrl, snippet });
    }

    searchCache.set(key, {
      expiresAt: now + CACHE_TTL_MS,
      items: results,
    });

    return results;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchPageText(url: string, maxChars = 1600): Promise<string> {
  if (!isHttpUrl(url)) {
    throw new Error('Only http/https URLs are supported');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'rag-knowledge-assistant/1.0',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Fetch page failed (${response.status} ${response.statusText})`);
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      return '';
    }

    const text = await response.text();
    const stripped = stripHtml(text);
    return stripped.slice(0, maxChars);
  } finally {
    clearTimeout(timeout);
  }
}

export type { WebSearchResult };
