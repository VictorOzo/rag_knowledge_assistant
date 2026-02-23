const button = document.querySelector<HTMLButtonElement>('#healthButton');
const output = document.querySelector<HTMLPreElement>('#healthOutput');

const backendBaseUrl = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:3001';

if (!button || !output) {
  throw new Error('Missing required UI elements');
}

button.addEventListener('click', async () => {
  output.textContent = 'Checking backend health...';

  try {
    const response = await fetch(`${backendBaseUrl}/health`);

    if (!response.ok) {
      output.textContent = `Health check failed with status ${response.status}`;
      return;
    }

    const payload = await response.json();
    output.textContent = JSON.stringify(payload, null, 2);
  } catch (error) {
    output.textContent = `Request failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
});
