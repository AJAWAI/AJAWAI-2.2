import { getModel, getTokenizer, markGenerateReached } from './phiLoader';

export interface GenerationOptions {
  max_new_tokens?: number;
  temperature?: number;
  top_p?: number;
}

const DEFAULT_OPTIONS: GenerationOptions = {
  max_new_tokens: 80,
  temperature: 0.7,
  top_p: 0.9,
};

export async function generateResponse(
  prompt: string,
  options: GenerationOptions = {},
  onChunk?: (text: string) => void
): Promise<string> {
  const model = getModel();
  const tokenizer = getTokenizer();

  if (!model || !tokenizer) {
    throw new Error('Model or tokenizer not loaded');
  }

  const opts = { ...DEFAULT_OPTIONS, ...options };

  console.log('[generate] Generating response for prompt:', prompt.substring(0, 50) + '...');

  // Mark that we've reached the generate path
  markGenerateReached();

  // Tokenize input - returns { input_ids: number[] }
  const inputs = tokenizer(prompt);
  
  // Generate - HuggingFace Transformers.js
  // Use type assertion to handle the API differences
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const output = await (model as any).generate(inputs.input_ids, {
    max_new_tokens: opts.max_new_tokens,
    temperature: opts.temperature,
    top_p: opts.top_p,
    do_sample: true,
    pad_token_id: tokenizer.pad_token_id || 1,
  });

  // Decode output - output is an array of token IDs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const generatedTokens = Array.isArray(output) ? output : [output];
  const response = tokenizer.batch_decode(generatedTokens)[0];

  // Extract just the response part (after the prompt)
  let responseText = response;
  if (response.startsWith(prompt)) {
    responseText = response.substring(prompt.length).trim();
  }

  console.log('[generate] Generated response:', responseText.substring(0, 50) + '...');

  // Simulate streaming if callback provided
  if (onChunk) {
    const words = responseText.split(' ');
    for (let i = 0; i < words.length; i++) {
      onChunk(words[i] + (i < words.length - 1 ? ' ' : ''));
      // Small delay to simulate streaming
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  return responseText;
}
