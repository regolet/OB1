const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_DIR = process.env.SUPERBRAIN_DIR || path.join(os.homedir(), '.superbrain');
const DB_PATH = path.join(DB_DIR, 'brain.db');

const DEFAULT_LIMIT = 10;
const MAX_SCAN_ROWS = 2000;
const EXPORT_VERSION = 2;

const STOP_WORDS = new Set([
  'a', 'about', 'after', 'all', 'also', 'am', 'an', 'and', 'are', 'as', 'at',
  'be', 'because', 'been', 'before', 'but', 'by', 'can', 'could', 'did', 'do',
  'does', 'for', 'from', 'had', 'has', 'have', 'how', 'i', 'if', 'in', 'into',
  'is', 'it', 'its', 'just', 'me', 'my', 'need', 'needs', 'no', 'not', 'of',
  'on', 'or', 'our', 'ours', 'so', 'that', 'the', 'their', 'them', 'then',
  'there', 'this', 'to', 'up', 'use', 'was', 'we', 'what', 'when', 'where',
  'which', 'who', 'why', 'will', 'with', 'you', 'your'
]);

let db = null;

function nowIso() {
  return new Date().toISOString();
}

function currentProject() {
  return cleanString(process.env.SUPERBRAIN_PROJECT || process.env.SUPERBRAIN_WORKSPACE || '');
}

function cleanString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const cleaned = cleanString(String(value));
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

function inferStaleDays(content, metadata) {
  if (metadata.stale_days === null || metadata.stale_days === 0) return null;

  const explicit = clamp(metadata.stale_days, 1, 3650);
  if (explicit) return explicit;

  const type = String(metadata.type || '').toLowerCase();
  if (type === 'current_state' || type === 'task') return 30;
  if (type === 'incident') return 180;
  if (type === 'reference' || type === 'person_note') return 365;

  const text = `${content} ${JSON.stringify(metadata)}`.toLowerCase();
  if (/\b(ip|router|server|deploy|deployment|port|host|ssh|password|token|key|env|path|permission|ownership|chmod|chown|endpoint|url)\b/.test(text)) {
    return 90;
  }

  return null;
}

function inferMemoryTier(metadata = {}) {
  const explicit = cleanString(metadata.memory_tier || metadata.tier);
  if (explicit) return explicit;

  const type = String(metadata.type || '').toLowerCase();
  if (['task', 'current_state', 'todo'].includes(type)) return 'working';
  if (['incident', 'session_summary', 'milestone'].includes(type)) return 'episodic';
  if (['procedure', 'workflow', 'runbook', 'playbook'].includes(type)) return 'procedural';
  return 'semantic';
}

function inferImportance(metadata = {}) {
  const explicit = clamp(metadata.importance, 0, 1);
  if (explicit !== null) return explicit;

  let score = 0.45;
  const tier = inferMemoryTier(metadata);
  if (tier === 'procedural') score += 0.2;
  if (tier === 'working') score += 0.1;
  if (Array.isArray(metadata.action_items) && metadata.action_items.length) score += 0.15;
  if (Array.isArray(metadata.entities) && metadata.entities.length) score += 0.05;
  if (Number.isFinite(Number(metadata.confidence))) score += Number(metadata.confidence) * 0.15;
  return Math.max(0, Math.min(1, score));
}

function defaultConfidence(source) {
  const s = String(source || '').toLowerCase();
  if (s === 'user' || s === 'manual' || s === 'tool') return 0.9;
  if (s === 'imported') return 0.75;
  if (s === 'inferred') return 0.6;
  if (s === 'mcp') return 0.85;
  return 0.8;
}

function normalizeMetadata(content, metadata = {}, existing = {}) {
  const source = cleanString(metadata.source) || cleanString(existing.source) || 'user';
  const project = cleanString(metadata.project) || cleanString(existing.project) || currentProject();
  const type = cleanString(metadata.type) || cleanString(existing.type) || 'observation';
  const confidence = clamp(
    metadata.confidence !== undefined ? metadata.confidence : existing.confidence,
    0,
    1
  ) ?? defaultConfidence(source);
  const verifiedAt = cleanString(metadata.verified_at) || cleanString(existing.verified_at) || null;
  const staleAfter = cleanString(metadata.stale_after)
    || cleanString(existing.stale_after)
    || (() => {
      const staleDays = inferStaleDays(content, { ...existing, ...metadata, type, source, project });
      return staleDays ? addDays(new Date(), staleDays) : null;
    })();
  const memoryTier = inferMemoryTier({ ...existing, ...metadata, type });
  const importance = inferImportance({ ...existing, ...metadata, type, memory_tier: memoryTier, confidence });
  const expiresAt = cleanString(metadata.expires_at) || cleanString(existing.expires_at) || null;

  return {
    ...existing,
    ...metadata,
    type,
    topics: uniqueStrings([...(existing.topics || []), ...(metadata.topics || [])]),
    people: uniqueStrings([...(existing.people || []), ...(metadata.people || [])]),
    action_items: uniqueStrings([...(existing.action_items || []), ...(metadata.action_items || [])]),
    entities: uniqueStrings([...(existing.entities || []), ...(metadata.entities || [])]),
    source,
    project,
    confidence,
    verified_at: verifiedAt,
    stale_after: staleAfter,
    memory_tier: memoryTier,
    importance,
    expires_at: expiresAt,
  };
}

function mergeMetadata(base = {}, incoming = {}) {
  const merged = { ...base, ...incoming };
  merged.topics = uniqueStrings([...(base.topics || []), ...(incoming.topics || [])]);
  merged.people = uniqueStrings([...(base.people || []), ...(incoming.people || [])]);
  merged.action_items = uniqueStrings([...(base.action_items || []), ...(incoming.action_items || [])]);
  merged.entities = uniqueStrings([...(base.entities || []), ...(incoming.entities || [])]);
  merged.confidence = Math.max(Number(base.confidence || 0), Number(incoming.confidence || 0)) || defaultConfidence(merged.source);
  merged.importance = Math.max(Number(base.importance || 0), Number(incoming.importance || 0)) || inferImportance(merged);
  return merged;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/['']/g, '')
    .match(/[a-z0-9][a-z0-9_.:/-]{1,}/g)
    ?.filter((token) => !STOP_WORDS.has(token) && token.length > 1)
    .slice(0, 80) || [];
}

function buildFtsQuery(query) {
  const tokens = tokenize(query)
    .map((token) => token.replace(/[^a-z0-9_]/g, ''))
    .filter(Boolean)
    .slice(0, 12);
  if (!tokens.length) return null;
  return tokens.map((token) => `${token}*`).join(' OR ');
}

function metadataText(metadata) {
  return [
    metadata.type,
    metadata.memory_tier,
    metadata.project,
    metadata.source,
    ...(metadata.topics || []),
    ...(metadata.people || []),
    ...(metadata.entities || []),
    ...(metadata.action_items || []),
  ].filter(Boolean).join(' ');
}

function rowToThought(row) {
  if (!row) return null;
  const metadata = normalizeMetadata(row.content, parseJson(row.metadata), {
    type: row.type,
    source: row.source,
    project: row.project,
    confidence: row.confidence,
    verified_at: row.verified_at,
    stale_after: row.stale_after,
    memory_tier: row.memory_tier,
    importance: row.importance,
    expires_at: row.expires_at,
  });
  // Destructure to exclude embedding from output (it's huge and wastes tokens)
  const { embedding: _embedding, ...rest } = row;
  return {
    ...rest,
    type: row.type || metadata.type,
    source: row.source || metadata.source,
    project: row.project || metadata.project,
    confidence: row.confidence ?? metadata.confidence,
    verified_at: row.verified_at || metadata.verified_at,
    stale_after: row.stale_after || metadata.stale_after,
    memory_tier: row.memory_tier || metadata.memory_tier,
    importance: row.importance ?? metadata.importance,
    expires_at: row.expires_at || metadata.expires_at,
    metadata,
    stale_warning: getStaleWarning({ ...row, metadata }),
  };
}

function getStaleWarning(thought) {
  const staleAfter = thought.stale_after || thought.metadata?.stale_after;
  if (!staleAfter) return null;

  const staleTime = Date.parse(staleAfter);
  if (!Number.isFinite(staleTime) || Date.now() <= staleTime) return null;

  const days = Math.max(1, Math.floor((Date.now() - staleTime) / 86400000));
  return {
    severity: days >= 30 ? 'stale' : 'warn',
    days_overdue: days,
    stale_after: staleAfter,
    message: `This memory became stale ${days} day(s) ago. Verify before relying on it.`,
  };
}

function ensureColumn(table, name, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

function dropFtsTriggers() {
  db.exec(`
    DROP TRIGGER IF EXISTS thoughts_ai;
    DROP TRIGGER IF EXISTS thoughts_ad;
    DROP TRIGGER IF EXISTS thoughts_au;
  `);
}

function createFtsTriggers() {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS thoughts_ai AFTER INSERT ON thoughts BEGIN
      INSERT INTO thoughts_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS thoughts_ad AFTER DELETE ON thoughts BEGIN
      INSERT INTO thoughts_fts(thoughts_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS thoughts_au AFTER UPDATE ON thoughts BEGIN
      INSERT INTO thoughts_fts(thoughts_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      INSERT INTO thoughts_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
  `);
}

function syncDerivedColumns() {
  const rows = db.prepare(`
    SELECT id, content, metadata, type, source, project, confidence, verified_at,
           stale_after, memory_tier, importance, expires_at
    FROM thoughts
    WHERE type IS NULL OR source IS NULL OR confidence IS NULL
       OR memory_tier IS NULL OR importance IS NULL
  `).all();

  const update = db.prepare(`
    UPDATE thoughts
    SET metadata = ?, type = ?, source = ?, project = ?, confidence = ?,
        verified_at = ?, stale_after = ?, memory_tier = ?, importance = ?, expires_at = ?
    WHERE id = ?
  `);

  const tx = db.transaction((items) => {
    for (const row of items) {
      const metadata = normalizeMetadata(row.content, parseJson(row.metadata), row);
      update.run(
        JSON.stringify(metadata),
        metadata.type,
        metadata.source,
        metadata.project,
        metadata.confidence,
        metadata.verified_at,
        metadata.stale_after,
        metadata.memory_tier,
        metadata.importance,
        metadata.expires_at,
        row.id
      );
    }
  });

  if (rows.length) tx(rows);
}

function initDatabase() {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS thoughts (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      type TEXT,
      source TEXT,
      project TEXT,
      confidence REAL DEFAULT 0.8,
      verified_at TEXT,
      stale_after TEXT,
      memory_tier TEXT,
      importance REAL DEFAULT 0.5,
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  ensureColumn('thoughts', 'type', 'TEXT');
  ensureColumn('thoughts', 'source', 'TEXT');
  ensureColumn('thoughts', 'project', 'TEXT');
  ensureColumn('thoughts', 'confidence', 'REAL DEFAULT 0.8');
  ensureColumn('thoughts', 'verified_at', 'TEXT');
  ensureColumn('thoughts', 'stale_after', 'TEXT');
  ensureColumn('thoughts', 'memory_tier', 'TEXT');
  ensureColumn('thoughts', 'importance', 'REAL DEFAULT 0.5');
  ensureColumn('thoughts', 'expires_at', 'TEXT');
  ensureColumn('thoughts', 'embedding', 'TEXT');
  ensureColumn('thoughts', 'access_count', 'INTEGER DEFAULT 0');
  ensureColumn('thoughts', 'last_accessed', 'TEXT');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_thoughts_created_at ON thoughts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_thoughts_project ON thoughts(project);
    CREATE INDEX IF NOT EXISTS idx_thoughts_type ON thoughts(type);
    CREATE INDEX IF NOT EXISTS idx_thoughts_source ON thoughts(source);
    CREATE INDEX IF NOT EXISTS idx_thoughts_stale_after ON thoughts(stale_after);
    CREATE INDEX IF NOT EXISTS idx_thoughts_memory_tier ON thoughts(memory_tier);
    CREATE INDEX IF NOT EXISTS idx_thoughts_importance ON thoughts(importance DESC);
  `);

  db.function('vec_distance', { deterministic: true }, (a, b) => {
    if (!a || !b) return 1;
    try {
      const vecA = JSON.parse(a);
      const vecB = JSON.parse(b);
      if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length) return 1;
      let dotProduct = 0;
      let magA = 0;
      let magB = 0;
      for (let i = 0; i < vecA.length; i++) {
        const valueA = Number(vecA[i]);
        const valueB = Number(vecB[i]);
        dotProduct += valueA * valueB;
        magA += valueA * valueA;
        magB += valueB * valueB;
      }
      if (!magA || !magB) return 1;
      const cosine = dotProduct / (Math.sqrt(magA) * Math.sqrt(magB));
      return 1 - Math.max(-1, Math.min(1, cosine));
    } catch {
      return 1;
    }
  });

  dropFtsTriggers();

  let ftsAvailable = false;
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS thoughts_fts USING fts5(
        content,
        content='thoughts',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );
    `);
    ftsAvailable = true;
  } catch {
    // FTS5 may be unavailable in a custom SQLite build. LIKE fallback still works.
  }

  syncDerivedColumns();

  if (ftsAvailable) {
    db.exec("INSERT INTO thoughts_fts(thoughts_fts) VALUES('rebuild')");
    createFtsTriggers();
  }

  return db;
}

function buildWhere(filters = {}, params = []) {
  const clauses = ['1=1'];

  if (filters.project && filters.projectScope === 'only') {
    clauses.push("(project = ? OR json_extract(metadata, '$.project') = ?)");
    params.push(filters.project, filters.project);
  }

  if (filters.type) {
    clauses.push("(type = ? OR json_extract(metadata, '$.type') = ?)");
    params.push(filters.type, filters.type);
  }

  if (filters.source) {
    clauses.push("(source = ? OR json_extract(metadata, '$.source') = ?)");
    params.push(filters.source, filters.source);
  }

  if (filters.memory_tier) {
    clauses.push("(memory_tier = ? OR json_extract(metadata, '$.memory_tier') = ?)");
    params.push(filters.memory_tier, filters.memory_tier);
  }

  if (filters.topic) {
    clauses.push('metadata LIKE ?');
    params.push(`%"${filters.topic}"%`);
  }

  if (filters.person) {
    clauses.push('metadata LIKE ?');
    params.push(`%"${filters.person}"%`);
  }

  return clauses.join(' AND ');
}

function scoreThought(thought, queryTokens, query, options = {}) {
  const content = thought.content.toLowerCase();
  const meta = thought.metadata || {};
  const haystack = `${thought.content} ${metadataText(meta)}`.toLowerCase();
  const hayTokens = new Set(tokenize(haystack));
  let score = 0;

  for (const token of queryTokens) {
    if (hayTokens.has(token)) score += 2;
    else if (haystack.includes(token)) score += 1;
  }

  const phrase = String(query || '').trim().toLowerCase();
  if (phrase && content.includes(phrase)) score += 6;

  if (options.project && thought.project === options.project) score += options.projectScope === 'boost' ? 3 : 1;
  if (options.topic && (meta.topics || []).some((t) => t.toLowerCase() === options.topic.toLowerCase())) score += 2;
  if (options.person && (meta.people || []).some((p) => p.toLowerCase() === options.person.toLowerCase())) score += 2;
  if (thought.confidence) score += Number(thought.confidence) * 0.75;
  if (thought.importance) score += Number(thought.importance) * 1.25;
  if (thought.memory_tier === 'procedural') score += 0.5;

  const created = Date.parse(`${thought.created_at}Z`);
  if (Number.isFinite(created)) {
    const ageDays = Math.max(0, (Date.now() - created) / 86400000);
    score += Math.max(0, 1.5 - ageDays / 180);
  }

  if (thought.access_count) {
    score += Math.min(2, thought.access_count * 0.1);
  }

  if (thought.last_accessed) {
    const accessed = Date.parse(`${thought.last_accessed}Z`);
    if (Number.isFinite(accessed)) {
      const daysSinceAccess = Math.max(0, (Date.now() - accessed) / 86400000);
      score -= Math.min(1, daysSinceAccess / 365);
    }
  }

  return score;
}

function searchThoughts(query, optionsOrLimit = {}, queryEmbedding = null) {
  const options = typeof optionsOrLimit === 'number'
    ? { limit: optionsOrLimit }
    : { ...(optionsOrLimit || {}) };
  const limit = clamp(options.limit || DEFAULT_LIMIT, 1, 100) || DEFAULT_LIMIT;
  const project = cleanString(options.project) || currentProject();
  const projectScope = options.project_scope || options.projectScope || (project ? 'boost' : 'all');
  const filters = {
    ...options,
    project,
    projectScope,
    type: cleanString(options.type),
    source: cleanString(options.source),
    memory_tier: cleanString(options.memory_tier),
    topic: cleanString(options.topic),
    person: cleanString(options.person),
  };
  const params = [];
  const where = buildWhere(filters, params);
  const queryTokens = tokenize(query);
  const ids = new Set();
  const rows = [];

  const ftsQuery = buildFtsQuery(query);
  if (ftsQuery) {
    try {
      const ftsParams = queryEmbedding ? [JSON.stringify(queryEmbedding), ftsQuery, ...params, Math.max(limit * 5, 50)] : [ftsQuery, ...params, Math.max(limit * 5, 50)];
      const ftsRows = db.prepare(`
        SELECT t.*, rank AS fts_rank${queryEmbedding ? `, vec_distance(t.embedding, ?) AS vec_score` : ''}
        FROM thoughts_fts fts
        JOIN thoughts t ON t.rowid = fts.rowid
        WHERE thoughts_fts MATCH ?
          AND ${where}
        ORDER BY rank
        LIMIT ?
      `).all(...ftsParams);
      for (const row of ftsRows) {
        ids.add(row.id);
        rows.push(row);
      }
    } catch {
      // FTS syntax can reject unusual input; the hybrid scan below is the fallback.
    }
  }

  const queryParams = queryEmbedding ? [JSON.stringify(queryEmbedding), ...params, MAX_SCAN_ROWS] : [...params, MAX_SCAN_ROWS];
  const scanRows = db.prepare(`
    SELECT *${queryEmbedding ? `, vec_distance(embedding, ?) AS vec_score` : ''}
    FROM thoughts
    WHERE ${where}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...queryParams);

  for (const row of scanRows) {
    if (!ids.has(row.id)) rows.push(row);
  }

  const includeStale = options.exclude_stale ? false : true;
  const finalThoughts = rows
    .map(rowToThought)
    .filter(Boolean)
    .filter((thought) => includeStale || !thought.stale_warning)
    .map((thought) => {
      const lexicalScore = queryTokens.length ? scoreThought(thought, queryTokens, query, filters) : 1;
      const ftsBoost = thought.fts_rank !== undefined ? 3 : 0;
      const vecSimilarity = thought.vec_score !== undefined ? (1 - thought.vec_score) : 0;
      const vecBoost = vecSimilarity > 0.3 ? vecSimilarity * 15 : 0;
      return { ...thought, relevance: lexicalScore + ftsBoost + vecBoost, similarity: vecSimilarity };
    })
    .filter((thought) => !queryTokens.length || thought.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit);

  if (finalThoughts.length) {
    try {
      const idsToUpdate = finalThoughts.map((t) => t.id);
      const placeholders = idsToUpdate.map(() => '?').join(',');
      db.prepare(`
        UPDATE thoughts
        SET access_count = coalesce(access_count, 0) + 1, last_accessed = datetime('now')
        WHERE id IN (${placeholders})
      `).run(...idsToUpdate);
    } catch {
      // Ignore errors updating access count
    }
  }

  return finalThoughts;
}

function getRecentThoughts({ type, topic, person, project, source, memory_tier, days, limit = 20, exclude_stale = false } = {}) {
  const params = [];
  const filters = {
    type: cleanString(type),
    topic: cleanString(topic),
    person: cleanString(person),
    source: cleanString(source),
    memory_tier: cleanString(memory_tier),
    project: cleanString(project),
    projectScope: project ? 'only' : 'all',
  };
  let sql = `SELECT * FROM thoughts WHERE ${buildWhere(filters, params)}`;

  if (days) {
    sql += " AND created_at >= datetime('now', ?)";
    params.push(`-${days} days`);
  }

  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(clamp(limit, 1, 100) || 20);

  return db.prepare(sql).all(...params)
    .map(rowToThought)
    .filter((thought) => !exclude_stale || !thought.stale_warning);
}

function getThoughtStats() {
  const total = db.prepare('SELECT COUNT(*) as total FROM thoughts').get().total;
  const allThoughts = db.prepare(`
    SELECT id, content, metadata, type, source, project, confidence, verified_at,
           stale_after, memory_tier, importance, expires_at, access_count,
           last_accessed, created_at, updated_at
    FROM thoughts
    ORDER BY created_at DESC
  `).all().map(rowToThought);

  const types = {}, topics = {}, people = {}, projects = {}, sources = {}, tiers = {};
  let oldest = null, newest = null, stale_count = 0;

  for (const thought of allThoughts) {
    const m = thought.metadata || {};
    if (!newest) newest = thought.created_at;
    oldest = thought.created_at;
    if (thought.type) types[thought.type] = (types[thought.type] || 0) + 1;
    if (thought.project) projects[thought.project] = (projects[thought.project] || 0) + 1;
    if (thought.source) sources[thought.source] = (sources[thought.source] || 0) + 1;
    if (thought.memory_tier) tiers[thought.memory_tier] = (tiers[thought.memory_tier] || 0) + 1;
    if (thought.stale_warning) stale_count += 1;
    if (Array.isArray(m.topics)) for (const t of m.topics) topics[t] = (topics[t] || 0) + 1;
    if (Array.isArray(m.people)) for (const p of m.people) people[p] = (people[p] || 0) + 1;
  }

  return { total, oldest, newest, types, topics, people, projects, sources, tiers, stale_count };
}

function captureThought(content, metadata = {}, embedding = null) {
  const normalized = normalizeMetadata(content, metadata);
  const existing = db.prepare('SELECT * FROM thoughts WHERE content = ?').get(content);

  if (existing) {
    const current = rowToThought(existing);
    const merged = normalizeMetadata(content, mergeMetadata(current.metadata, normalized), current);
    db.prepare(`
      UPDATE thoughts
      SET metadata = ?, type = ?, source = ?, project = ?, confidence = ?,
          verified_at = ?, stale_after = ?, memory_tier = ?, importance = ?,
          expires_at = ?, embedding = COALESCE(?, embedding), updated_at = datetime('now')
      WHERE id = ?
    `).run(
      JSON.stringify(merged),
      merged.type,
      merged.source,
      merged.project,
      merged.confidence,
      merged.verified_at,
      merged.stale_after,
      merged.memory_tier,
      merged.importance,
      merged.expires_at,
      embedding ? JSON.stringify(embedding) : null,
      existing.id
    );
    return { id: existing.id, action: 'updated', metadata: merged };
  }

  const id = metadata.id && /^[a-zA-Z0-9_-]{8,80}$/.test(metadata.id)
    ? metadata.id
    : crypto.randomBytes(16).toString('hex');

  db.prepare(`
    INSERT INTO thoughts
      (id, content, metadata, type, source, project, confidence, verified_at,
       stale_after, memory_tier, importance, expires_at, embedding, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    id,
    content,
    JSON.stringify(normalized),
    normalized.type,
    normalized.source,
    normalized.project,
    normalized.confidence,
    normalized.verified_at,
    normalized.stale_after,
    normalized.memory_tier,
    normalized.importance,
    normalized.expires_at,
    embedding ? JSON.stringify(embedding) : null
  );
  return { id, action: 'created', metadata: normalized };
}

function fetchThought(id) {
  const row = db.prepare('SELECT * FROM thoughts WHERE id = ?').get(id);
  return rowToThought(row);
}

function similarity(a, b) {
  const aTokens = new Set(tokenize(`${a.content} ${metadataText(a.metadata || {})}`));
  const bTokens = new Set(tokenize(`${b.content} ${metadataText(b.metadata || {})}`));
  if (!aTokens.size || !bTokens.size) return 0;

  let shared = 0;
  for (const token of aTokens) if (bTokens.has(token)) shared += 1;
  const union = new Set([...aTokens, ...bTokens]).size;
  const jaccard = shared / union;
  const exact = a.content.trim().toLowerCase() === b.content.trim().toLowerCase() ? 1 : 0;
  return Math.max(jaccard, exact);
}

function findDuplicateThoughts({ limit = 20, threshold = 0.72, project } = {}) {
  const thoughts = getRecentThoughts({ project, limit: MAX_SCAN_ROWS });
  const used = new Set();
  const groups = [];

  for (let i = 0; i < thoughts.length; i++) {
    const primary = thoughts[i];
    if (used.has(primary.id)) continue;

    const duplicates = [];
    for (let j = i + 1; j < thoughts.length; j++) {
      const candidate = thoughts[j];
      if (used.has(candidate.id)) continue;
      const score = similarity(primary, candidate);
      if (score >= threshold) {
        duplicates.push({ ...candidate, similarity: score });
      }
    }

    if (duplicates.length) {
      used.add(primary.id);
      for (const dup of duplicates) used.add(dup.id);
      groups.push({ primary, duplicates });
      if (groups.length >= limit) break;
    }
  }

  return groups;
}

function mergeThoughts(primaryId, duplicateIds, { merged_content, delete_duplicates = false } = {}) {
  const primary = fetchThought(primaryId);
  if (!primary) throw new Error(`Primary thought not found: ${primaryId}`);

  const duplicates = uniqueStrings(duplicateIds).map(fetchThought).filter(Boolean);
  if (!duplicates.length) throw new Error('No duplicate thoughts found.');

  const contentParts = [cleanString(merged_content) || primary.content];
  if (!merged_content) {
    const extra = duplicates
      .map((thought) => thought.content.trim())
      .filter((content) => content && content.toLowerCase() !== primary.content.trim().toLowerCase());
    if (extra.length) contentParts.push('Merged details:\n- ' + uniqueStrings(extra).join('\n- '));
  }

  let metadata = { ...primary.metadata };
  for (const thought of duplicates) metadata = mergeMetadata(metadata, thought.metadata);
  metadata.merged_from = uniqueStrings([...(metadata.merged_from || []), ...duplicates.map((thought) => thought.id)]);
  metadata = normalizeMetadata(contentParts.join('\n\n'), metadata);

  db.prepare(`
    UPDATE thoughts
    SET content = ?, metadata = ?, type = ?, source = ?, project = ?, confidence = ?,
        verified_at = ?, stale_after = ?, memory_tier = ?, importance = ?,
        expires_at = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    contentParts.join('\n\n'),
    JSON.stringify(metadata),
    metadata.type,
    metadata.source,
    metadata.project,
    metadata.confidence,
    metadata.verified_at,
    metadata.stale_after,
    metadata.memory_tier,
    metadata.importance,
    metadata.expires_at,
    primaryId
  );

  if (delete_duplicates) {
    const placeholders = duplicates.map(() => '?').join(',');
    db.prepare(`DELETE FROM thoughts WHERE id IN (${placeholders})`).run(...duplicates.map((thought) => thought.id));
  }

  return { primary_id: primaryId, merged_count: duplicates.length, deleted_duplicates: Boolean(delete_duplicates) };
}

function summarizeTopic({ topic, project, days, limit = 12, queryEmbedding = null } = {}) {
  const thoughts = searchThoughts(topic || '', {
    limit,
    project,
    project_scope: project ? 'boost' : 'all',
    exclude_stale: false,
  }, queryEmbedding).filter((thought) => {
    if (!days) return true;
    const created = Date.parse(`${thought.created_at}Z`);
    return Number.isFinite(created) && Date.now() - created <= days * 86400000;
  });

  const topics = {}, people = {};
  const actionItems = [];
  const stale = [];

  for (const thought of thoughts) {
    const m = thought.metadata || {};
    for (const t of m.topics || []) topics[t] = (topics[t] || 0) + 1;
    for (const p of m.people || []) people[p] = (people[p] || 0) + 1;
    for (const item of m.action_items || []) actionItems.push(item);
    if (thought.stale_warning) stale.push({ id: thought.id, message: thought.stale_warning.message });
  }

  return {
    topic: topic || 'recent memory',
    project: project || null,
    count: thoughts.length,
    top_topics: Object.entries(topics).sort((a, b) => b[1] - a[1]).slice(0, 8),
    people: Object.entries(people).sort((a, b) => b[1] - a[1]).slice(0, 8),
    action_items: uniqueStrings(actionItems).slice(0, 12),
    stale_warnings: stale,
    key_thoughts: thoughts.slice(0, limit).map((thought) => ({
      id: thought.id,
      content: thought.content,
      created_at: thought.created_at,
      type: thought.type,
      source: thought.source,
      project: thought.project,
      confidence: thought.confidence,
      memory_tier: thought.memory_tier,
      importance: thought.importance,
    })),
  };
}

function exportThoughts({ project, format = 'json' } = {}) {
  const thoughts = getRecentThoughts({ project, limit: MAX_SCAN_ROWS });
  if (format === 'markdown') {
    const lines = [
      '# SuperBrain Export',
      '',
      `Exported: ${nowIso()}`,
      `Count: ${thoughts.length}`,
      '',
    ];
    for (const thought of thoughts) {
      lines.push(`## ${thought.id}`);
      lines.push('');
      lines.push(thought.content);
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify(thought.metadata, null, 2));
      lines.push('```');
      lines.push('');
    }
    return lines.join('\n');
  }

  return JSON.stringify({
    version: EXPORT_VERSION,
    exported_at: nowIso(),
    count: thoughts.length,
    thoughts,
  }, null, 2);
}

function importThoughts(payload, { default_project, dry_run = false } = {}) {
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const items = Array.isArray(parsed) ? parsed : parsed.thoughts;
  if (!Array.isArray(items)) throw new Error('Import payload must be an array or an object with a thoughts array.');

  const summary = { total: items.length, created: 0, updated: 0, skipped: 0 };
  if (dry_run) return summary;

  for (const item of items) {
    const content = cleanString(item.content);
    if (!content) {
      summary.skipped += 1;
      continue;
    }
    const metadata = normalizeMetadata(content, {
      ...(item.metadata || {}),
      type: item.type || item.metadata?.type,
      source: item.source || item.metadata?.source || 'imported',
      project: item.project || item.metadata?.project || default_project,
      confidence: item.confidence ?? item.metadata?.confidence,
      verified_at: item.verified_at || item.metadata?.verified_at,
      stale_after: item.stale_after || item.metadata?.stale_after,
      memory_tier: item.memory_tier || item.metadata?.memory_tier,
      importance: item.importance ?? item.metadata?.importance,
      expires_at: item.expires_at || item.metadata?.expires_at,
    });
    const result = captureThought(content, metadata);
    summary[result.action === 'created' ? 'created' : 'updated'] += 1;
  }

  return summary;
}

function getRelatedThoughts(id, { limit = 10 } = {}) {
  const thought = fetchThought(id);
  if (!thought) return [];

  const metadata = thought.metadata || {};
  const needles = uniqueStrings([
    ...(metadata.topics || []),
    ...(metadata.entities || []),
    ...(metadata.people || []),
    thought.project,
  ]).map((value) => value.toLowerCase());

  if (!needles.length) return [];

  const rows = db.prepare(`
    SELECT id, content, metadata, type, source, project, confidence, verified_at,
           stale_after, memory_tier, importance, expires_at, access_count,
           last_accessed, created_at, updated_at
    FROM thoughts
    WHERE id <> ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(id, MAX_SCAN_ROWS).map(rowToThought);

  return rows
    .map((candidate) => {
      const candidateMetadata = candidate.metadata || {};
      const haystack = uniqueStrings([
        ...(candidateMetadata.topics || []),
        ...(candidateMetadata.entities || []),
        ...(candidateMetadata.people || []),
        candidate.project,
      ]).map((value) => value.toLowerCase());
      const shared = needles.filter((value) => haystack.includes(value));
      const score = shared.length + (candidate.project && candidate.project === thought.project ? 1 : 0);
      return { ...candidate, relation_score: score, shared_signals: shared };
    })
    .filter((candidate) => candidate.relation_score > 0)
    .sort((a, b) => b.relation_score - a.relation_score || Number(b.importance || 0) - Number(a.importance || 0))
    .slice(0, clamp(limit, 1, 50) || 10);
}

function getProjectProfile({ project, limit = 12 } = {}) {
  const thoughts = getRecentThoughts({ project, limit: MAX_SCAN_ROWS });
  const topics = {}, entities = {}, people = {}, tiers = {}, types = {};
  const recent = [];
  const important = [];
  let stale_count = 0;

  for (const thought of thoughts) {
    const metadata = thought.metadata || {};
    if (thought.stale_warning) stale_count += 1;
    if (thought.memory_tier) tiers[thought.memory_tier] = (tiers[thought.memory_tier] || 0) + 1;
    if (thought.type) types[thought.type] = (types[thought.type] || 0) + 1;
    for (const topic of metadata.topics || []) topics[topic] = (topics[topic] || 0) + 1;
    for (const entity of metadata.entities || []) entities[entity] = (entities[entity] || 0) + 1;
    for (const person of metadata.people || []) people[person] = (people[person] || 0) + 1;
    if (recent.length < limit) recent.push(thought);
    important.push(thought);
  }

  const topEntries = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 10);
  important.sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0));

  return {
    project: project || null,
    total: thoughts.length,
    stale_count,
    tiers: topEntries(tiers),
    types: topEntries(types),
    topics: topEntries(topics),
    entities: topEntries(entities),
    people: topEntries(people),
    important: important.slice(0, limit).map((thought) => ({
      id: thought.id,
      content: thought.content,
      type: thought.type,
      memory_tier: thought.memory_tier,
      importance: thought.importance,
      created_at: thought.created_at,
    })),
    recent: recent.map((thought) => ({
      id: thought.id,
      content: thought.content,
      type: thought.type,
      memory_tier: thought.memory_tier,
      created_at: thought.created_at,
    })),
  };
}

async function backfillEmbeddings(generateEmbedding, { limit = 100, project } = {}) {
  if (typeof generateEmbedding !== 'function') throw new Error('generateEmbedding function is required.');

  const params = [];
  let where = "(embedding IS NULL OR embedding = '')";
  if (project) {
    where += ' AND project = ?';
    params.push(project);
  }
  params.push(clamp(limit, 1, 1000) || 100);

  const rows = db.prepare(`
    SELECT id, content
    FROM thoughts
    WHERE ${where}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params);

  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    const embedding = await generateEmbedding(row.content);
    if (!embedding) {
      skipped += 1;
      continue;
    }
    db.prepare("UPDATE thoughts SET embedding = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(embedding), row.id);
    updated += 1;
  }

  return { scanned: rows.length, updated, skipped };
}

function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  initDatabase,
  searchThoughts,
  getRecentThoughts,
  getThoughtStats,
  captureThought,
  fetchThought,
  findDuplicateThoughts,
  mergeThoughts,
  summarizeTopic,
  getRelatedThoughts,
  getProjectProfile,
  backfillEmbeddings,
  exportThoughts,
  importThoughts,
  getStaleWarning,
  closeDatabase,
  DB_PATH,
};
