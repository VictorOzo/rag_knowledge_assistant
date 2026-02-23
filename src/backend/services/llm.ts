const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const llmModel = process.env.LLM_MODEL ?? 'gemma3:4b';

export function getPrompt(question: string, context: string): string {
  return [
    'You are a retrieval QA assistant.',
    'Use ONLY the provided context to answer the question.',
    'If the answer is not in context, say you do not know based on the provided documents.',
    '',
    'Context:',
    context || '[no context]',
    '',
    `Question: ${question}`,
    'Answer:',
  ].join('\n');
}

export async function generateAnswer(params: { question: string; context: string }): Promise<string> {
  const prompt = getPrompt(params.question, params.context);

  const response = await fetch(`${ollamaBaseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: llmModel,
      prompt,
      stream: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama generate failed (${response.status})`);
  }

  const payload = (await response.json()) as { response?: string };
  return payload.response?.trim() || 'I do not know based on the provided documents.';
}
