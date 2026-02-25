const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const llmModel = process.env.LLM_MODEL ?? 'gemma3:4b';
const defaultNumPredict = Number(process.env.LLM_NUM_PREDICT ?? 220);
const defaultTemperature = Number(process.env.LLM_TEMPERATURE ?? 0.2);
const defaultKeepAlive = process.env.OLLAMA_KEEP_ALIVE ?? '10m';

type GenerateAnswerParams = {
  question: string;
  context: string;
  numPredict?: number;
  temperature?: number;
  keepAlive?: string;
};

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

export async function generateAnswer(params: GenerateAnswerParams): Promise<string> {
  const prompt = getPrompt(params.question, params.context);
  const numPredict = Number.isFinite(params.numPredict)
    ? Number(params.numPredict)
    : defaultNumPredict;
  const temperature = Number.isFinite(params.temperature)
    ? Number(params.temperature)
    : defaultTemperature;
  const keepAlive = params.keepAlive ?? defaultKeepAlive;

  const response = await fetch(`${ollamaBaseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: llmModel,
      prompt: params.prompt,
      stream: false,
      keep_alive: keepAlive,
      options: {
        num_predict: numPredict,
        temperature,
      },
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(
      `Ollama generate failed (${response.status} ${response.statusText}): ${bodyText || 'No response body'}`,
    );
  }

  const payload = (await response.json()) as { response?: string };
  return payload.response?.trim() || 'I do not know based on the provided documents.';
}

export async function generateAnswer(params: GenerateAnswerParams): Promise<string> {
  const prompt = getPrompt(params.question, params.context);
  return generateAnswerFromPrompt({
    prompt,
    numPredict: params.numPredict,
    temperature: params.temperature,
    keepAlive: params.keepAlive,
  });
}
