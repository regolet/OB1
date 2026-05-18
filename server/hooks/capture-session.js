#!/usr/bin/env node
/**
 * SuperBrain Session Capture Hook
 * ================================
 * Drop this into Claude Code's Stop hook to auto-save session summaries.
 *
 * How it works:
 *   1. Claude Code calls this script when a session ends (Stop hook)
 *   2. It reads the JSONL transcript from ~/.claude/projects/...
 *   3. Extracts user messages and assistant summaries
 *   4. Saves a compact session memory to SuperBrain
 *
 * Install:
 *   Run: node capture-session.js --install
 *   Or manually add to ~/.claude/settings.json (see README)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Config ────────────────────────────────────────────────────────────────
const SUPERBRAIN_DIR = process.env.SUPERBRAIN_DIR || path.join(os.homedir(), '.superbrain');
const DB_PATH = path.join(SUPERBRAIN_DIR, 'brain.db');
const MAX_CONTENT_CHARS = 10000;
const MIN_MESSAGES = 3; // Skip tiny/accidental sessions
const HOOK_SCRIPT_PATH = path.resolve(__filename);

// ─── Install Mode ───────────────────────────────────────────────────────────
if (process.argv.includes('--install')) {
  install();
  process.exit(0);
}

// ─── Main Hook Entry (called by Claude Code) ────────────────────────────────
async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;

  let hookData = {};
  try { hookData = JSON.parse(input); } catch { /* not JSON, continue */ }

  const transcriptPath = hookData.transcript_path;
  const sessionId = hookData.session_id;
  const cwd = hookData.cwd || process.cwd();

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    // Try to find the most recent session transcript as fallback
    process.stderr.write('[SuperBrain] No transcript_path provided, skipping session capture.\n');
    process.exit(0);
  }

  const summary = extractSessionSummary(transcriptPath, sessionId, cwd);
  if (!summary) {
    process.stderr.write('[SuperBrain] Session too short or nothing durable found, skipping.\n');
    process.exit(0);
  }

  await saveToSuperbrain(summary);
}

// ─── Extract meaningful content from transcript ──────────────────────────────
function extractSessionSummary(transcriptPath, sessionId, cwd) {
  const raw = fs.readFileSync(transcriptPath, 'utf8');
  const lines = raw.trim().split('\n').filter(Boolean);
  if (lines.length < MIN_MESSAGES) return null;

  const messages = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = extractText(entry.message.content);
        if (text) messages.push({ role: 'user', text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const text = extractText(entry.message.content);
        if (text) messages.push({ role: 'assistant', text });
      }
    } catch { /* skip malformed lines */ }
  }

  if (messages.length < MIN_MESSAGES) return null;

  // Build a compact summary:
  // - First user message = intent/topic
  // - Last assistant message = likely conclusion
  const userMessages = messages.filter(m => m.role === 'user').map(m => m.text);
  const assistantMessages = messages.filter(m => m.role === 'assistant').map(m => m.text);
  if (!userMessages.length) return null;

  const project = inferProject(cwd);
  const topics = inferTopics(userMessages.concat(assistantMessages));
  const intent = userMessages[0].slice(0, 300);
  const lastConclusion = assistantMessages[assistantMessages.length - 1]?.slice(0, 500) || '';

  const content = [
    `Session summary [${sessionId || 'unknown'}] in ${project || cwd}`,
    `Intent: ${intent}`,
    lastConclusion ? `Outcome: ${lastConclusion}` : null,
    `Turns: ${messages.length} | User messages: ${userMessages.length}`,
  ].filter(Boolean).join('\n').slice(0, MAX_CONTENT_CHARS);

  return { content, project, topics, cwd, sessionId };
}

function extractText(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter(b => b.type === 'text')
      .map(b => b.text || '')
      .join(' ')
      .trim();
  }
  return '';
}

function inferProject(cwd) {
  if (!cwd) return null;
  // Map known repo paths to project names
  const knownProjects = {
    'SuperBrain': 'regolet/OB1',
    'ISP-Management-System': 'litefi',
    'fastfi': 'fastfi',
    'pisotab': 'pisotab',
    'ai-reviewer': 'ai-reviewer',
  };
  for (const [key, project] of Object.entries(knownProjects)) {
    if (cwd.toLowerCase().includes(key.toLowerCase())) return project;
  }
  // Fallback to last segment of cwd
  return path.basename(cwd);
}

function inferTopics(texts) {
  const combined = texts.join(' ').toLowerCase();
  const knownTopics = [
    'superbrain', 'database', 'deployment', 'authentication', 'security',
    'android', 'pisotab', 'fastfi', 'litefi', 'ota', 'firmware',
    'vector', 'embedding', 'search', 'mcp', 'sqlite', 'api',
    'bug', 'fix', 'refactor', 'migration', 'schema',
  ];
  return knownTopics.filter(t => combined.includes(t)).slice(0, 5);
}

// ─── Save to SuperBrain (direct SQLite write) ────────────────────────────────
async function saveToSuperbrain({ content, project, topics, sessionId }) {
  // Dynamically require better-sqlite3 from SuperBrain's own node_modules
  const superbrainPkg = findSuperbrainPackage();
  if (!superbrainPkg) {
    process.stderr.write('[SuperBrain] Could not find SuperBrain package, skipping.\n');
    return;
  }

  try {
    const Database = require(path.join(superbrainPkg, 'node_modules', 'better-sqlite3'));
    const crypto = require('crypto');

    if (!fs.existsSync(DB_PATH)) {
      process.stderr.write(`[SuperBrain] DB not found at ${DB_PATH}, skipping.\n`);
      return;
    }

    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');

    const id = crypto.randomBytes(16).toString('hex');
    const metadata = JSON.stringify({
      type: 'session_summary',
      source: 'hook',
      project,
      topics: ['session', ...topics],
      session_id: sessionId,
    });

    db.prepare(`
      INSERT OR IGNORE INTO thoughts
        (id, content, metadata, type, source, project, confidence, created_at, updated_at)
      VALUES (?, ?, ?, 'session_summary', 'hook', ?, 0.75, datetime('now'), datetime('now'))
    `).run(id, content, metadata, project || null);

    db.close();
    process.stderr.write(`[SuperBrain] Session captured → ${id.slice(0, 8)}...\n`);
  } catch (err) {
    process.stderr.write(`[SuperBrain] Capture failed: ${err.message}\n`);
  }
}

function findSuperbrainPackage() {
  // Walk up from this script's location to find node_modules/better-sqlite3
  let dir = path.dirname(HOOK_SCRIPT_PATH);
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'node_modules', 'better-sqlite3'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return null;
}

// ─── Install: write hook config into ~/.claude/settings.json ────────────────
function install() {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { /* fresh */ }

  settings.hooks = settings.hooks || {};
  settings.hooks.Stop = settings.hooks.Stop || [];

  const hookEntry = {
    matcher: '',
    hooks: [{
      type: 'command',
      command: `node "${HOOK_SCRIPT_PATH.replace(/\\/g, '/')}"`,
    }],
  };

  // Avoid duplicate entries
  const alreadyInstalled = settings.hooks.Stop.some(
    h => h.hooks?.some(hk => hk.command?.includes('capture-session'))
  );

  if (!alreadyInstalled) {
    settings.hooks.Stop.push(hookEntry);
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    console.log(`✅ SuperBrain session hook installed in ${settingsPath}`);
    console.log(`   Hook: ${hookEntry.hooks[0].command}`);
  } else {
    console.log('ℹ️  SuperBrain session hook already installed.');
  }

  // Also update permissions to allow node execution
  settings.permissions = settings.permissions || {};
  settings.permissions.allow = settings.permissions.allow || [];
  const nodePermission = 'Bash(node *capture-session*)';
  if (!settings.permissions.allow.includes(nodePermission)) {
    settings.permissions.allow.push(nodePermission);
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    console.log(`✅ Added permission: ${nodePermission}`);
  }
}

main().catch(err => {
  process.stderr.write(`[SuperBrain] Hook error: ${err.message}\n`);
  process.exit(0); // Never block Claude Code from shutting down
});
