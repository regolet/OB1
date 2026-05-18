#!/usr/bin/env node

const { initDatabase, closeDatabase, backfillEmbeddings, DB_PATH } = require('./src/database');
const { generateEmbedding, embeddingsEnabled } = require('./src/embeddings');

function readArg(name, fallback = null) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

async function main() {
  const limit = Number(readArg('limit', '100'));
  const project = readArg('project');

  initDatabase();
  console.log(`SuperBrain DB: ${DB_PATH}`);

  if (!embeddingsEnabled()) {
    console.log('Embeddings are disabled by SUPERBRAIN_EMBEDDINGS.');
    return;
  }

  const result = await backfillEmbeddings(generateEmbedding, { project, limit });
  console.log(`Embedding backfill complete: ${JSON.stringify(result)}`);
}

main()
  .catch((err) => {
    console.error(`Embedding backfill failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
