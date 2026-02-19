/**
 * Embedding provider abstraction.
 *
 * Priority: local WASM (@xenova/transformers) → remote fallback (Gemini free tier).
 * Gracefully degrades if neither is available.
 */

let pipeline: any = null;
let embedder: any = null;
let available = false;
let providerName = 'none';

const EMBEDDING_DIM = 384;
const MODEL_NAME = 'Xenova/nomic-embed-text-v1.5';

/**
 * Initialize the embedding provider.
 * Tries local WASM first, then Gemini fallback.
 */
export async function initializeEmbeddings(): Promise<boolean> {
  // Try local @xenova/transformers (WASM, no native deps)
  try {
    // Dynamic import — optional dependency, only available in Docker
    const mod = await (Function('return import("@xenova/transformers")')() as Promise<any>);
    pipeline = mod.pipeline;
    console.log('[Embeddings] Loading local model (this may take a moment on first run)...');
    embedder = await pipeline('feature-extraction', MODEL_NAME, {
      quantized: true,
    });
    available = true;
    providerName = 'local-wasm';
    console.log(`[Embeddings] Local WASM model loaded: ${MODEL_NAME} (${EMBEDDING_DIM}d)`);
    return true;
  } catch (e) {
    console.log('[Embeddings] Local model not available:', (e as Error).message);
  }

  // Gemini free tier fallback
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    providerName = 'gemini';
    available = true;
    console.log('[Embeddings] Using Gemini free tier for embeddings');
    return true;
  }

  console.log('[Embeddings] No embedding provider available (install @xenova/transformers or set GEMINI_API_KEY)');
  return false;
}

/**
 * Generate embedding for a text string.
 * Returns a Float32Array of EMBEDDING_DIM dimensions, or null if unavailable.
 */
export async function embed(text: string): Promise<Float32Array | null> {
  if (!available) return null;

  // Truncate very long texts (most embedding models have a ~512 token limit)
  const truncated = text.slice(0, 2000);

  if (providerName === 'local-wasm' && embedder) {
    try {
      const result = await embedder(truncated, { pooling: 'mean', normalize: true });
      return new Float32Array(result.data);
    } catch (e) {
      console.log('[Embeddings] Local embed error:', (e as Error).message);
      return null;
    }
  }

  if (providerName === 'gemini') {
    return embedWithGemini(truncated);
  }

  return null;
}

/**
 * Batch embed multiple texts.
 */
export async function embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
  // For local WASM, process sequentially to avoid memory issues
  const results: (Float32Array | null)[] = [];
  for (const text of texts) {
    results.push(await embed(text));
  }
  return results;
}

async function embedWithGemini(text: string): Promise<Float32Array | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'models/text-embedding-004',
          content: { parts: [{ text }] },
          outputDimensionality: EMBEDDING_DIM,
        }),
      },
    );

    if (!response.ok) {
      console.log(`[Embeddings] Gemini API error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    const values = data?.embedding?.values;
    if (!values || !Array.isArray(values)) return null;
    return new Float32Array(values);
  } catch (e) {
    console.log('[Embeddings] Gemini embed error:', (e as Error).message);
    return null;
  }
}

export function isEmbeddingsAvailable(): boolean {
  return available;
}

export function getEmbeddingDim(): number {
  return EMBEDDING_DIM;
}

export function getEmbeddingsProvider(): string {
  return providerName;
}

export function shutdownEmbeddings(): void {
  embedder = null;
  pipeline = null;
  available = false;
  providerName = 'none';
}
