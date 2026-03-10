import { Tensor } from '@xenova/transformers';
import { getModel, getTokenizer } from './phiLoader';

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

  // Tokenize input
  const inputs = tokenizer(prompt);
  
  // Create tensor from input IDs
  const inputIds = new Tensor('int64', inputs.input_ids, [1, inputs.input_ids.length]);

  // Generate
  const outputs = await model.generate(inputIds, {
    max_new_tokens: opts.max_new_tokens,
    temperature: opts.temperature,
    top_p: opts.top_p,
    do_sample: true,
    pad_token_id: tokenizer.pad_token_id || 1, // Default to 1 (usually eos/pad)
  });

  // Decode output
  const generatedTokens = outputs[0];
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
