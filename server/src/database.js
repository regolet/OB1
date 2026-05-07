const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DB_DIR = process.env.SUPERBRAIN_DIR || path.join(os.homedir(), '.superbrain');
const DB_PATH = path.join(DB_DIR, 'brain.db');

let db = null;

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
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_thoughts_created_at ON thoughts(created_at DESC);
  `);

  // Create FTS5 virtual table for full-text search
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS thoughts_fts USING fts5(
        content,
        content='thoughts',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );
    `);
  } catch (e) {
    // FTS table may already exist
  }

  // Create triggers to keep FTS in sync
  const triggerExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name=?"
  );

  if (!triggerExists.get('thoughts_ai')) {
    db.exec(`
      CREATE TRIGGER thoughts_ai AFTER INSERT ON thoughts BEGIN
        INSERT INTO thoughts_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `);
  }

  if (!triggerExists.get('thoughts_ad')) {
    db.exec(`
      CREATE TRIGGER thoughts_ad AFTER DELETE ON thoughts BEGIN
        INSERT INTO thoughts_fts(thoughts_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      END;
    `);
  }

  if (!triggerExists.get('thoughts_au')) {
    db.exec(`
      CREATE TRIGGER thoughts_au AFTER UPDATE ON thoughts BEGIN
        INSERT INTO thoughts_fts(thoughts_fts, rowid, content) VALUES('delete', old.rowid, old.content);
        INSERT INTO thoughts_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `);
  }

  return db;
}

function searchThoughts(query, limit = 10) {
  const sanitized = query.replace(/['"]/g, ' ').trim();
  if (!sanitized) return [];

  try {
    const stmt = db.prepare(`
      SELECT t.id, t.content, t.metadata, t.created_at, rank AS relevance
      FROM thoughts_fts fts
      JOIN thoughts t ON t.rowid = fts.rowid
      WHERE thoughts_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    const results = stmt.all(sanitized, limit);
    return results.map(r => ({ ...r, metadata: JSON.parse(r.metadata || '{}') }));
  } catch (err) {
    // Fallback to LIKE search if FTS query fails
    const fallback = db.prepare(`
      SELECT id, content, metadata, created_at
      FROM thoughts WHERE content LIKE ? ORDER BY created_at DESC LIMIT ?
    `);
    const results = fallback.all('%' + sanitized + '%', limit);
    return results.map(r => ({ ...r, metadata: JSON.parse(r.metadata || '{}') }));
  }
}

function getRecentThoughts({ type, topic, person, days, limit = 20 } = {}) {
  let sql = 'SELECT id, content, metadata, created_at FROM thoughts WHERE 1=1';
  const params = [];

  if (days) {
    sql += " AND created_at >= datetime('now', ?)";
    params.push('-' + days + ' days');
  }
  if (type) {
    sql += " AND json_extract(metadata, '$.type') = ?";
    params.push(type);
  }
  if (topic) {
    sql += " AND metadata LIKE ?";
    params.push('%' + topic + '%');
  }
  if (person) {
    sql += " AND metadata LIKE ?";
    params.push('%' + person + '%');
  }

  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const results = db.prepare(sql).all(...params);
  return results.map(r => ({ ...r, metadata: JSON.parse(r.metadata || '{}') }));
}

function getThoughtStats() {
  const total = db.prepare('SELECT COUNT(*) as total FROM thoughts').get().total;
  const allThoughts = db.prepare('SELECT metadata, created_at FROM thoughts ORDER BY created_at DESC').all();

  const types = {}, topics = {}, people = {};
  let oldest = null, newest = null;

  for (const row of allThoughts) {
    const m = JSON.parse(row.metadata || '{}');
    if (!newest) newest = row.created_at;
    oldest = row.created_at;
    if (m.type) types[m.type] = (types[m.type] || 0) + 1;
    if (Array.isArray(m.topics)) for (const t of m.topics) topics[t] = (topics[t] || 0) + 1;
    if (Array.isArray(m.people)) for (const p of m.people) people[p] = (people[p] || 0) + 1;
  }

  return { total, oldest, newest, types, topics, people };
}

function captureThought(content, metadata = {}) {
  const existing = db.prepare('SELECT id FROM thoughts WHERE content = ?').get(content);

  if (existing) {
    const current = JSON.parse(
      db.prepare('SELECT metadata FROM thoughts WHERE id = ?').get(existing.id).metadata || '{}'
    );
    const merged = { ...current, ...metadata };
    db.prepare("UPDATE thoughts SET metadata = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(merged), existing.id);
    return { id: existing.id, action: 'updated' };
  }

  const id = crypto.randomBytes(16).toString('hex');
  db.prepare("INSERT INTO thoughts (id, content, metadata, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))")
    .run(id, content, JSON.stringify(metadata));
  return { id, action: 'created' };
}

function fetchThought(id) {
  const row = db.prepare('SELECT id, content, metadata, created_at, updated_at FROM thoughts WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, metadata: JSON.parse(row.metadata || '{}') };
}

function closeDatabase() {
  if (db) { db.close(); db = null; }
}

module.exports = { initDatabase, searchThoughts, getRecentThoughts, getThoughtStats, captureThought, fetchThought, closeDatabase, DB_PATH };
