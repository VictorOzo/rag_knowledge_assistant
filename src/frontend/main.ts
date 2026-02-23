const API = 'http://localhost:3001';

const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.tab'));
const panels = Array.from(document.querySelectorAll<HTMLElement>('.panel'));

function showTab(id: string): void {
  for (const tab of tabs) {
    tab.classList.toggle('is-active', tab.dataset.tab === id);
  }
  for (const panel of panels) {
    panel.classList.toggle('is-active', panel.id === id);
  }
}

for (const tab of tabs) {
  tab.addEventListener('click', () => showTab(tab.dataset.tab ?? 'chat'));
}

const questionInput = document.querySelector<HTMLTextAreaElement>('#question');
const askButton = document.querySelector<HTMLButtonElement>('#askButton');
const chatOutput = document.querySelector<HTMLPreElement>('#chatOutput');

if (!questionInput || !askButton || !chatOutput) {
  throw new Error('Missing chat elements');
}

askButton.addEventListener('click', async () => {
  const question = questionInput.value.trim();
  if (!question) {
    chatOutput.textContent = 'Please enter a question.';
    return;
  }

  chatOutput.textContent = 'Querying...';

  try {
    const response = await fetch(`${API}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });

    const payload = await response.json();
    chatOutput.textContent = JSON.stringify(payload, null, 2);
  } catch (error) {
    chatOutput.textContent = `Query failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
});

const fileInput = document.querySelector<HTMLInputElement>('#fileInput');
const uploadButton = document.querySelector<HTMLButtonElement>('#uploadButton');
const dropzone = document.querySelector<HTMLLabelElement>('#dropzone');
const ingestOutput = document.querySelector<HTMLPreElement>('#ingestOutput');

if (!fileInput || !uploadButton || !dropzone || !ingestOutput) {
  throw new Error('Missing ingest elements');
}

function setFile(file: File): void {
  const dt = new DataTransfer();
  dt.items.add(file);
  fileInput.files = dt.files;
  dropzone.textContent = `Selected: ${file.name}`;
}

dropzone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropzone.classList.add('dragover');
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('dragover');
});

dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropzone.classList.remove('dragover');
  const file = event.dataTransfer?.files?.[0];
  if (file) {
    setFile(file);
  }
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) {
    dropzone.textContent = `Selected: ${file.name}`;
  }
});

uploadButton.addEventListener('click', async () => {
  const file = fileInput.files?.[0];
  if (!file) {
    ingestOutput.textContent = 'Select a file first.';
    return;
  }

  ingestOutput.textContent = 'Uploading...';
  const formData = new FormData();
  formData.set('file', file);

  try {
    const response = await fetch(`${API}/ingest`, {
      method: 'POST',
      body: formData,
    });

    const payload = await response.json();
    ingestOutput.textContent = JSON.stringify(payload, null, 2);
  } catch (error) {
    ingestOutput.textContent = `Upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
});

const refreshAuditButton = document.querySelector<HTMLButtonElement>('#refreshAuditButton');
const auditStats = document.querySelector<HTMLPreElement>('#auditStats');
const auditQueries = document.querySelector<HTMLPreElement>('#auditQueries');

if (!refreshAuditButton || !auditStats || !auditQueries) {
  throw new Error('Missing audit elements');
}

refreshAuditButton.addEventListener('click', async () => {
  auditStats.textContent = 'Loading stats...';
  auditQueries.textContent = 'Loading queries...';

  try {
    const [statsResponse, queriesResponse] = await Promise.all([
      fetch(`${API}/audit/stats`),
      fetch(`${API}/audit/queries?limit=10`),
    ]);

    const statsPayload = await statsResponse.json();
    const queriesPayload = await queriesResponse.json();

    auditStats.textContent = JSON.stringify(statsPayload, null, 2);
    auditQueries.textContent = JSON.stringify(queriesPayload, null, 2);
  } catch (error) {
    const message = `Audit fetch failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    auditStats.textContent = message;
    auditQueries.textContent = message;
  }
});
