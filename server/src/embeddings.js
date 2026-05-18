const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
const MAX_INPUT_CHARS = 12000;

let embedder = null;
let loading = null;
let warned = false;

function embeddingsEnabled() {
  const value = String(process.env.SUPERBRAIN_EMBEDDINGS || '1').toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(value);
}

function warnOnce(message) {
  if (warned || process.env.SUPERBRAIN_EMBEDDINGS_QUIET === '1') return;
  warned = true;
  process.stderr.write(`SuperBrain embeddings disabled for this call: ${message}\n`);
}

async function getEmbedder() {
  if (!embeddingsEnabled()) return null;
  if (embedder) return embedder;
  if (loading) return loading;

  loading = (async () => {
    const { pipeline } = require('@xenova/transformers');
    return pipeline('feature-extraction', process.env.SUPERBRAIN_EMBEDDING_MODEL || DEFAULT_MODEL, {
      quantized: true,
    });
  })();

  try {
    embedder = await loading;
    return embedder;
  } catch (err) {
    loading = null;
    warnOnce(err.message);
    return null;
  }
}

async function generateEmbedding(text) {
  if (!text || typeof text !== 'string') return null;

  const embedderPipeline = await getEmbedder();
  if (!embedderPipeline) return null;

  try {
    const result = await embedderPipeline(text.slice(0, MAX_INPUT_CHARS), {
      pooling: 'mean',
      normalize: true,
    });
    return Array.from(result.data);
  } catch (err) {
    warnOnce(err.message);
    return null;
  }
}

module.exports = {
  DEFAULT_MODEL,
  embeddingsEnabled,
  generateEmbedding,
};
