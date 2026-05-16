const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'superbrain-test-'));
process.env.SUPERBRAIN_DIR = tempDir;
process.env.SUPERBRAIN_PROJECT = 'SuperBrain';

const brain = require('../src/database');

test.before(() => {
  brain.initDatabase();
});

test.after(() => {
  brain.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('captures provenance, project, confidence, and stale metadata', () => {
  const result = brain.captureThought('Router upload flow should use local edits before ssh-mcp deployment.', {
    type: 'current_state',
    topics: ['router', 'deploy'],
    entities: ['ssh-mcp'],
    source: 'user',
    project: 'LiteFi',
    confidence: 0.95,
    stale_after: '2000-01-01T00:00:00.000Z',
  });

  const thought = brain.fetchThought(result.id);
  assert.equal(thought.project, 'LiteFi');
  assert.equal(thought.source, 'user');
  assert.equal(thought.confidence, 0.95);
  assert.equal(thought.stale_warning.severity, 'stale');
});

test('search uses project-aware hybrid relevance', () => {
  brain.captureThought('SuperBrain now supports project-aware semantic recall and topic summaries.', {
    type: 'decision',
    topics: ['memory', 'search'],
    project: 'SuperBrain',
    source: 'tool',
  });
  brain.captureThought('AiKaraoke fixed transcript timing display for medley playback.', {
    type: 'incident',
    topics: ['lyrics'],
    project: 'AiKaraoke',
    source: 'tool',
  });

  const results = brain.searchThoughts('memory recall summaries', {
    project: 'SuperBrain',
    project_scope: 'boost',
    limit: 3,
  });

  assert.ok(results.length >= 1);
  assert.equal(results[0].project, 'SuperBrain');
  assert.match(results[0].content, /project-aware/);
});

test('summarizes a topic with actions and key thoughts', () => {
  brain.captureThought('Use export before risky memory migrations.', {
    type: 'task',
    topics: ['backup', 'memory'],
    action_items: ['Export thoughts before migration'],
    project: 'SuperBrain',
    source: 'user',
  });

  const summary = brain.summarizeTopic({ topic: 'memory migration backup', project: 'SuperBrain', limit: 5 });
  assert.ok(summary.count >= 1);
  assert.ok(summary.action_items.includes('Export thoughts before migration'));
  assert.ok(summary.key_thoughts.some((thought) => /export/i.test(thought.content)));
});

test('finds and merges near-duplicate thoughts', () => {
  const a = brain.captureThought('Router deploy uses ssh-mcp and chown root root after upload.', {
    project: 'LiteFi',
    topics: ['router', 'deploy'],
  });
  const b = brain.captureThought('Router deployment should use ssh mcp and chown root root after file upload.', {
    project: 'LiteFi',
    topics: ['router', 'deploy'],
  });

  const groups = brain.findDuplicateThoughts({ project: 'LiteFi', threshold: 0.45, limit: 5 });
  assert.ok(groups.some((group) => {
    const ids = [group.primary.id, ...group.duplicates.map((dup) => dup.id)];
    return ids.includes(a.id) && ids.includes(b.id);
  }));

  const result = brain.mergeThoughts(a.id, [b.id], { delete_duplicates: true });
  assert.equal(result.merged_count, 1);
  assert.equal(brain.fetchThought(b.id), null);
});

test('exports and imports thoughts safely', () => {
  const exported = brain.exportThoughts({ project: 'SuperBrain', format: 'json' });
  const dryRun = brain.importThoughts(exported, { default_project: 'SuperBrain', dry_run: true });
  assert.ok(dryRun.total >= 1);

  const payload = JSON.stringify({
    thoughts: [{
      content: 'Imported memory keeps provenance metadata.',
      metadata: { source: 'imported', project: 'SuperBrain', topics: ['import'] },
    }],
  });
  const imported = brain.importThoughts(payload, { dry_run: false });
  assert.equal(imported.created, 1);

  const results = brain.searchThoughts('imported provenance', { project: 'SuperBrain', limit: 5 });
  assert.ok(results.some((thought) => thought.source === 'imported'));
});
