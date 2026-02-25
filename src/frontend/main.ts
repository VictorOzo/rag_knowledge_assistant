/// <reference types="vite/client" />

const API_BASE = (
  import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3001"
).replace(/\/+$/, "");
const HEALTH_POLL_MS = 15_000;
const ALLOWED_EXTENSIONS = new Set(["txt", "md", "pdf","docx"]);
const LONG_TEXT_LIMIT = 180;

type HealthResponse = {
  status?: string;
  time?: string;
  models?: { embed?: string; llm?: string };
  chroma?: { ok?: boolean; collection?: string; error?: string };
  auditDb?: { ok?: boolean; path?: string; error?: string };
};

type DocSource = {
  type: "doc";
  id?: string;
  docId: string;
  index: number;
  distance?: number;
};

type WebSource = {
  type: "web";
  title: string;
  url: string;
  snippet?: string;
};

type ChatSource = DocSource | WebSource;

type ChatTurn = {
  role: "user" | "assistant";
  content: string;
};

type ChatResponse = {
  answer: string;
  latencyMs?: number;
  timings?: { embedMs?: number; searchMs?: number; llmMs?: number };
  contextCharsUsed?: number;
  sources?: ChatSource[];
};

type IngestResponse = {
  docId: string;
  chunksCreated: number;
  replacedChunks: number;
};

type AuditList<T> = { items: T[] };

class ApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: unknown;

  constructor(args: {
    message: string;
    status: number;
    url: string;
    body: unknown;
  }) {
    super(args.message);
    this.name = "ApiError";
    this.status = args.status;
    this.url = args.url;
    this.body = args.body;
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function extractErrorMessage(body: unknown, fallback: string): string {
  if (!body) return fallback;
  if (typeof body === "string") return body;

  if (typeof body === "object") {
    const b = body as Record<string, unknown>;
    const err = typeof b.error === "string" ? b.error : "";
    const details =
      typeof b.details === "string"
        ? b.details
        : b.details
          ? JSON.stringify(b.details)
          : "";

    if (err && details) return `${err} — ${details}`;
    if (err) return err;
    if (details) return details;
  }

  return fallback;
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${API_BASE}${path}`;

  const response = await fetch(url, init);
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();

  const isJson = contentType.includes("application/json");
  const body = isJson ? safeJsonParse(text) : text;

  if (!response.ok) {
    const fallback = `${response.status} ${response.statusText}`.trim();
    const message = extractErrorMessage(body, fallback);

    // Always log full context for debugging (especially 400s)
    // eslint-disable-next-line no-console
    console.error("API ERROR", {
      url,
      status: response.status,
      statusText: response.statusText,
      body,
    });

    throw new ApiError({
      message: `${message} (HTTP ${response.status})`,
      status: response.status,
      url,
      body,
    });
  }

  if (!isJson) {
    // If you expect JSON always, keep this strict.
    throw new ApiError({
      message: "Expected JSON response from server.",
      status: response.status,
      url,
      body,
    });
  }

  return body as T;
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing required element: ${id}`);
  return el as T;
}

const healthStatus = byId<HTMLDivElement>("healthStatus");
const bannerContainer = byId<HTMLDivElement>("bannerContainer");
const tabButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".tab-button"),
);
const tabPanels = Array.from(
  document.querySelectorAll<HTMLElement>(".tab-panel"),
);

const chatTranscript = byId<HTMLDivElement>("chatTranscript");
const chatInput = byId<HTMLTextAreaElement>("chatInput");
const sendBtn = byId<HTMLButtonElement>("sendBtn");
const cancelQueryBtn = byId<HTMLButtonElement>("cancelQueryBtn");
const topKInput = byId<HTMLInputElement>("topKInput");
const webModeInput = byId<HTMLSelectElement>("webModeInput");

const fileInput = byId<HTMLInputElement>("fileInput");
const uploadBtn = byId<HTMLButtonElement>("uploadBtn");
const ingestResults = byId<HTMLDivElement>("ingestResults");

const refreshAuditBtn = byId<HTMLButtonElement>("refreshAuditBtn");
const queriesContainer = byId<HTMLDivElement>("queriesContainer");
const ingestionsContainer = byId<HTMLDivElement>("ingestionsContainer");
const statsContainer = byId<HTMLDivElement>("statsContainer");

let activeQueryController: AbortController | null = null;
let healthTimer: number | undefined;
const chatHistory: ChatTurn[] = [];
const HISTORY_LIMIT = 12;

function showBanner(
  kind: "success" | "error",
  text: string,
  timeoutMs = 4500,
): void {
  const banner = document.createElement("div");
  banner.className = `banner ${kind}`;
  banner.textContent = text;
  bannerContainer.appendChild(banner);

  window.setTimeout(() => banner.remove(), timeoutMs);
}

function makeSpinnerLabel(labelText: string): HTMLSpanElement {
  const label = document.createElement("span");
  const spinner = document.createElement("span");
  spinner.className = "spinner";
  label.appendChild(spinner);
  label.appendChild(document.createTextNode(labelText));
  return label;
}

function setTab(tabName: string): void {
  tabButtons.forEach((button) => {
    const isActive = button.dataset.tab === tabName;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });

  tabPanels.forEach((panel) => {
    const isActive = panel.id === `tab-${tabName}`;
    panel.classList.toggle("active", isActive);
    panel.hidden = !isActive;
  });

  if (tabName === "audit") void loadAuditData();
}

tabButtons.forEach((button) => {
  button.addEventListener("click", () => setTab(button.dataset.tab ?? "chat"));
});

function appendMessage(
  role: "user" | "assistant",
  text: string,
  options?: {
    used?: { rag?: boolean; web?: boolean };
    timings?: ChatResponse["timings"];
    contextCharsUsed?: number;
    sources?: ChatSource[];
  },
): HTMLElement {
  const wrapper = document.createElement("article");
  wrapper.className = `message ${role}`;

  const messageText = document.createElement("div");
  messageText.textContent = text;
  wrapper.appendChild(messageText);

  if (role === "assistant" && options) {
    const metaLines: string[] = [];
    if (options.used) {
      const usedDocs = options.used.rag ? "✅" : "❌";
      const usedWeb = options.used.web ? "✅" : "❌";
      metaLines.push(`Used: Docs ${usedDocs} Web ${usedWeb}`);
    }

    if (options.timings) {
      const t = options.timings;
      metaLines.push(
        `Timings: total ${t.totalMs ?? "?"} ms (embed ${t.embedMs ?? "?"} / search ${t.searchMs ?? "?"} / web ${t.webMs ?? "?"} / llm ${t.llmMs ?? "?"} ms)`,
      );
    }

    if (typeof options.contextCharsUsed === "number") {
      metaLines.push(`Context chars: ${options.contextCharsUsed}`);
    }

    if (metaLines.length > 0) {
      const meta = document.createElement("div");
      meta.className = "sources";
      meta.textContent = metaLines.join("\n");
      wrapper.appendChild(meta);
    }

    const sources = options.sources ?? [];
    const docSources = sources.filter((source): source is DocSource => source.type === "doc");
    const webSources = sources.filter((source): source is WebSource => source.type === "web");

    if (docSources.length > 0 || webSources.length > 0) {
      const sourcesBlock = document.createElement("div");
      sourcesBlock.className = "sources";

      const heading = document.createElement("strong");
      heading.textContent = "Sources:";
      sourcesBlock.appendChild(heading);

      if (docSources.length > 0) {
        const docsTitle = document.createElement("div");
        docsTitle.textContent = "Document sources:";
        sourcesBlock.appendChild(docsTitle);

        const docList = document.createElement("ul");
        docSources.forEach((source) => {
          const item = document.createElement("li");
          const distanceText =
            typeof source.distance === "number"
              ? ` (distance: ${source.distance.toFixed(4)})`
              : "";
          item.textContent = `[DOC ${source.docId}:${source.index}]${distanceText}`;
          docList.appendChild(item);
        });
        sourcesBlock.appendChild(docList);
      }

      if (webSources.length > 0) {
        const webTitle = document.createElement("div");
        webTitle.textContent = "Web sources:";
        sourcesBlock.appendChild(webTitle);

        const webList = document.createElement("ul");
        webSources.forEach((source, idx) => {
          const item = document.createElement("li");
          const snippet = source.snippet ? ` — ${source.snippet}` : "";
          item.textContent = `[WEB ${idx + 1}] ${source.title} (${source.url})${snippet}`;
          webList.appendChild(item);
        });
        sourcesBlock.appendChild(webList);
      }

      wrapper.appendChild(sourcesBlock);
    }
  }

  chatTranscript.appendChild(wrapper);
  chatTranscript.scrollTop = chatTranscript.scrollHeight;
  return wrapper;
}

function getTopKValue(): number {
  const parsed = Number(topKInput.value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    topKInput.value = "4";
    return 4;
  }
  return parsed;
}

async function sendQuestion(): Promise<void> {
  const message = chatInput.value.trim();
  if (!message) {
    showBanner("error", "Please type a question before sending.");
    return;
  }

  if (activeQueryController) {
    showBanner(
      "error",
      "A query is already running. Cancel it before sending another.",
    );
    return;
  }

  appendMessage("user", message);
  chatHistory.push({ role: "user", content: message });
  if (chatHistory.length > HISTORY_LIMIT) {
    chatHistory.splice(0, chatHistory.length - HISTORY_LIMIT);
  }

  chatInput.value = "";

  const thinkingMessage = appendMessage("assistant", "thinking...");
  thinkingMessage.firstElementChild?.replaceWith(
    makeSpinnerLabel("thinking..."),
  );

  activeQueryController = new AbortController();
  sendBtn.disabled = true;
  cancelQueryBtn.disabled = false;

  try {
    const payload = await apiFetch<ChatResponse>("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        history: chatHistory.slice(-6),
        topK: getTopKValue(),
        web: webModeInput.value,
      }),
      signal: activeQueryController.signal,
    });

    thinkingMessage.remove();
    const timings = payload.timings;
    const breakdown = timings
      ? ` (embed ${timings.embedMs ?? "?"} ms / search ${timings.searchMs ?? "?"} ms / llm ${timings.llmMs ?? "?"} ms)`
      : "";
    const meta = `\n\nLatency: ${payload.latencyMs ?? "?"} ms${breakdown} | Context chars: ${payload.contextCharsUsed ?? "?"}`;
    appendMessage(
      "assistant",
      `${payload.answer}${meta}`,
      payload.sources ?? [],
    );
  } catch (error) {
    thinkingMessage.remove();
    if (error instanceof DOMException && error.name === "AbortError") {
      appendMessage("assistant", "Query canceled.");
    } else {
      const errMsg =
        error instanceof Error ? error.message : "Unknown query error";
      appendMessage("assistant", `Error: ${errMsg}`);
      showBanner("error", `Query failed: ${errMsg}`);
    }
  } finally {
    activeQueryController = null;
    sendBtn.disabled = false;
    cancelQueryBtn.disabled = true;
  }
}

sendBtn.addEventListener("click", () => void sendQuestion());
cancelQueryBtn.addEventListener("click", () => activeQueryController?.abort());

chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void sendQuestion();
  }
});

async function updateHealth(): Promise<void> {
  try {
    const health = await apiFetch<HealthResponse>("/health");

    const chromaPart = health.chroma?.ok
      ? `Chroma: ok (${health.chroma.collection ?? "collection"})`
      : `Chroma: error (${health.chroma?.error ?? "unknown"})`;

    const auditPart = health.auditDb?.ok
      ? `Audit: ok`
      : health.auditDb
        ? `Audit: error (${health.auditDb.error ?? "unknown"})`
        : `Audit: n/a`;

    healthStatus.textContent = [
      `Backend: ${health.status ?? "unknown"}`,
      `LLM: ${health.models?.llm ?? "n/a"}`,
      `Embed: ${health.models?.embed ?? "n/a"}`,
      chromaPart,
      auditPart,
    ].join("\n");
  } catch (error) {
    healthStatus.textContent = `Backend unavailable\n${error instanceof Error ? error.message : "Unknown error"}`;
  }
}

async function uploadFiles(): Promise<void> {
  const files = fileInput.files ? Array.from(fileInput.files) : [];
  if (files.length === 0) {
    showBanner("error", "Choose at least one file to ingest.");
    return;
  }

  uploadBtn.disabled = true;

  try {
    for (const file of files) {
      const ext = file.name.includes(".")
        ? (file.name.split(".").pop()?.toLowerCase() ?? "")
        : "";
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        showBanner(
          "error",
          `Unsupported file type for ${file.name}. Use txt, md, or pdf.`,
        );
        continue;
      }

      const pendingCard = document.createElement("div");
      pendingCard.className = "result-card";
      pendingCard.appendChild(makeSpinnerLabel(`Uploading ${file.name}...`));
      ingestResults.prepend(pendingCard);

      const formData = new FormData();
      // IMPORTANT: backend expects field name "file"
      formData.set("file", file);

      try {
        const result = await apiFetch<IngestResponse>("/ingest", {
          method: "POST",
          body: formData, // IMPORTANT: do NOT set Content-Type header for FormData
        });

        pendingCard.textContent = "";
        const title = document.createElement("strong");
        title.textContent = file.name;
        pendingCard.appendChild(title);

        const details = document.createElement("div");
        details.className = "kv";
        details.textContent = `docId: ${result.docId} | chunksCreated: ${result.chunksCreated} | replacedChunks: ${result.replacedChunks}`;
        pendingCard.appendChild(details);

        showBanner("success", `Ingested: ${file.name}`);
      } catch (error) {
        pendingCard.textContent = `Failed ${file.name}: ${error instanceof Error ? error.message : "Unknown error"}`;
        pendingCard.classList.add("error");
      }
    }
  } finally {
    uploadBtn.disabled = false;
    fileInput.value = "";
  }
}

uploadBtn.addEventListener("click", () => void uploadFiles());

function appendKeyValue(
  container: HTMLElement,
  label: string,
  value: string,
): void {
  const row = document.createElement("div");
  row.className = "kv";
  row.textContent = `${label}: ${value}`;
  container.appendChild(row);
}

function renderExpandableText(
  parent: HTMLElement,
  label: string,
  value: unknown,
): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const wrap = document.createElement("div");
  wrap.className = "kv";

  const content = document.createElement("div");
  const isLong = text.length > LONG_TEXT_LIMIT;
  let expanded = false;

  const setText = (): void => {
    const visibleText =
      expanded || !isLong ? text : `${text.slice(0, LONG_TEXT_LIMIT)}...`;
    content.textContent = `${label}: ${visibleText}`;
  };

  setText();
  wrap.appendChild(content);

  if (isLong) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "expand-toggle";
    toggle.textContent = "Show more";
    toggle.addEventListener("click", () => {
      expanded = !expanded;
      toggle.textContent = expanded ? "Show less" : "Show more";
      setText();
    });
    wrap.appendChild(toggle);
  }

  parent.appendChild(wrap);
}

function clearAndMessage(container: HTMLElement, text: string): void {
  container.textContent = "";
  const empty = document.createElement("div");
  empty.className = "kv";
  empty.textContent = text;
  container.appendChild(empty);
}

async function loadAuditData(): Promise<void> {
  refreshAuditBtn.disabled = true;
  clearAndMessage(queriesContainer, "Loading recent queries...");
  clearAndMessage(ingestionsContainer, "Loading recent ingestions...");
  clearAndMessage(statsContainer, "Loading stats...");

  try {
    const [queries, ingestions, stats] = await Promise.all([
      apiFetch<AuditList<Record<string, unknown>>>("/audit/queries?limit=20"),
      apiFetch<AuditList<Record<string, unknown>>>(
        "/audit/ingestions?limit=20",
      ),
      apiFetch<Record<string, unknown>>("/audit/stats"),
    ]);

    queriesContainer.textContent = "";
    if (queries.items.length === 0) {
      clearAndMessage(queriesContainer, "No query records yet.");
    } else {
      for (const item of queries.items) {
        const card = document.createElement("article");
        card.className = "audit-card";
        appendKeyValue(card, "id", String(item.id ?? "n/a"));
        appendKeyValue(card, "timestamp", String(item.timestamp ?? "n/a"));
        renderExpandableText(card, "question", item.question ?? "");
        renderExpandableText(card, "answer", item.answer ?? "");
        renderExpandableText(card, "sources", item.sources ?? []);
        appendKeyValue(card, "latencyMs", String(item.latencyMs ?? "n/a"));
        queriesContainer.appendChild(card);
      }
    }

    ingestionsContainer.textContent = "";
    if (ingestions.items.length === 0) {
      clearAndMessage(ingestionsContainer, "No ingestion records yet.");
    } else {
      for (const item of ingestions.items) {
        const card = document.createElement("article");
        card.className = "audit-card";
        appendKeyValue(card, "id", String(item.id ?? "n/a"));
        appendKeyValue(card, "timestamp", String(item.timestamp ?? "n/a"));
        appendKeyValue(card, "fileName", String(item.fileName ?? "n/a"));
        appendKeyValue(card, "docId", String(item.docId ?? "n/a"));
        appendKeyValue(
          card,
          "chunksCreated",
          String(item.chunksCreated ?? "n/a"),
        );
        appendKeyValue(
          card,
          "replacedChunks",
          String(item.replacedChunks ?? "n/a"),
        );
        ingestionsContainer.appendChild(card);
      }
    }

    statsContainer.textContent = "";
    const statsCard = document.createElement("article");
    statsCard.className = "audit-card";
    Object.entries(stats).forEach(([key, value]) =>
      renderExpandableText(statsCard, key, value),
    );
    statsContainer.appendChild(statsCard);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown audit error";
    showBanner("error", `Failed to load audit data: ${message}`);
    clearAndMessage(queriesContainer, `Error: ${message}`);
    clearAndMessage(ingestionsContainer, `Error: ${message}`);
    clearAndMessage(statsContainer, `Error: ${message}`);
  } finally {
    refreshAuditBtn.disabled = false;
  }
}

refreshAuditBtn.addEventListener("click", () => void loadAuditData());

cancelQueryBtn.disabled = true;
appendMessage("assistant", "Hi! Ask a question. I will use your docs first and web search when needed.");
void updateHealth();
healthTimer = window.setInterval(() => void updateHealth(), HEALTH_POLL_MS);

window.addEventListener("beforeunload", () => {
  if (healthTimer) window.clearInterval(healthTimer);
  activeQueryController?.abort();
});
