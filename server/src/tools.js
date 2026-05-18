const { z } = require('zod');
const db = require('./database');
const { generateEmbedding } = require('./embeddings');

function formatDate(value) {
  if (!value) return '??';
  const parsed = new Date(value.endsWith('Z') || value.includes('T') ? value : `${value}Z`);
  return Number.isNaN(parsed.getTime()) ? '??' : parsed.toLocaleDateString();
}

function formatThought(thought, index) {
  const m = thought.metadata || {};
  const tags = Array.isArray(m.topics) && m.topics.length ? ` - ${m.topics.join(', ')}` : '';
  const project = thought.project ? ` project=${thought.project}` : '';
  const source = thought.source ? ` source=${thought.source}` : '';
  const confidence = Number.isFinite(Number(thought.confidence))
    ? ` confidence=${Number(thought.confidence).toFixed(2)}`
    : '';
  const tier = thought.memory_tier ? ` tier=${thought.memory_tier}` : '';
  const importance = Number.isFinite(Number(thought.importance))
    ? ` importance=${Number(thought.importance).toFixed(2)}`
    : '';
  const similarity = Number.isFinite(Number(thought.similarity)) && thought.similarity > 0
    ? ` similarity=${Number(thought.similarity).toFixed(2)}`
    : '';
  const stale = thought.stale_warning ? `\n   WARNING: ${thought.stale_warning.message}` : '';
  return `${index + 1}. [${formatDate(thought.created_at)}] (${thought.type || m.type || 'thought'}${tags})${project}${source}${tier}${importance}${confidence}${similarity}\n   ${thought.content}${stale}`;
}

function formatSummary(summary) {
  if (!summary.count) return `No memories found for "${summary.topic}".`;

  const lines = [
    `Topic: ${summary.topic}`,
    summary.project ? `Project: ${summary.project}` : null,
    `Matched thoughts: ${summary.count}`,
  ].filter(Boolean);

  if (summary.top_topics.length) {
    lines.push('', 'Top topics:');
    for (const [topic, count] of summary.top_topics) lines.push(`  - ${topic}: ${count}`);
  }

  if (summary.people.length) {
    lines.push('', 'People:');
    for (const [person, count] of summary.people) lines.push(`  - ${person}: ${count}`);
  }

  if (summary.action_items.length) {
    lines.push('', 'Action items:');
    for (const item of summary.action_items) lines.push(`  - ${item}`);
  }

  if (summary.stale_warnings.length) {
    lines.push('', 'Stale warnings:');
    for (const warning of summary.stale_warnings) lines.push(`  - ${warning.id}: ${warning.message}`);
  }

  lines.push('', 'Key thoughts:');
  for (const thought of summary.key_thoughts) {
    lines.push(`  - ${thought.content} (${thought.type || 'thought'}, ${formatDate(thought.created_at)})`);
  }

  return lines.join('\n');
}

function formatProjectProfile(profile) {
  const lines = [
    profile.project ? `Project: ${profile.project}` : 'Project: all memories',
    `Total memories: ${profile.total}`,
    `Stale memories: ${profile.stale_count}`,
  ];

  const addEntries = (title, entries) => {
    if (!entries.length) return;
    lines.push('', `${title}:`);
    for (const [name, count] of entries) lines.push(`  - ${name}: ${count}`);
  };

  addEntries('Memory tiers', profile.tiers);
  addEntries('Types', profile.types);
  addEntries('Top topics', profile.topics);
  addEntries('Entities', profile.entities);
  addEntries('People', profile.people);

  if (profile.important.length) {
    lines.push('', 'Important memories:');
    for (const thought of profile.important) {
      lines.push(`  - ${thought.content} (${thought.memory_tier || thought.type || 'memory'}, importance ${Number(thought.importance || 0).toFixed(2)})`);
    }
  }

  return lines.join('\n');
}

function registerTools(server) {
  server.tool(
    'search',
    'Search your SuperBrain by keywords, natural language, project, provenance, or metadata. Uses local FTS plus hybrid relevance scoring.',
    {
      query: z.string().describe('The search query - keywords or a natural language question'),
      limit: z.number().optional().default(10).describe('Max results to return (default: 10)'),
      project: z.string().optional().describe('Prefer or restrict to a project/workspace'),
      project_scope: z.enum(['boost', 'only', 'all']).optional().default('boost').describe('boost = prioritize project matches, only = filter to project, all = ignore project'),
      type: z.string().optional().describe('Filter by type: observation, task, idea, reference, person_note, current_state, incident'),
      source: z.string().optional().describe('Filter by provenance/source: user, tool, inferred, manual, imported, mcp'),
      memory_tier: z.string().optional().describe('Filter by lifecycle tier: working, episodic, semantic, procedural'),
      topic: z.string().optional().describe('Filter by topic tag'),
      person: z.string().optional().describe('Filter by person mentioned'),
      exclude_stale: z.boolean().optional().default(false).describe('Exclude memories whose stale_after date has passed'),
    },
    async ({ query, limit, project, project_scope, type, source, memory_tier, topic, person, exclude_stale }) => {
      try {
        const queryEmbedding = await generateEmbedding(query);
        const results = db.searchThoughts(query, {
          limit: limit || 10,
          project,
          project_scope,
          type,
          source,
          memory_tier,
          topic,
          person,
          exclude_stale,
        }, queryEmbedding);
        if (!results.length) return { content: [{ type: 'text', text: 'No matching thoughts found.' }] };

        return {
          content: [{
            type: 'text',
            text: `${results.length} result(s):\n\n${results.map(formatThought).join('\n\n')}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Search error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'recent_thoughts',
    'Browse recent thoughts from your SuperBrain. Optionally filter by type, topic, person, project, source, or days.',
    {
      type: z.string().optional().describe('Filter by type: observation, task, idea, reference, person_note'),
      topic: z.string().optional().describe('Filter by topic tag'),
      person: z.string().optional().describe('Filter by person mentioned'),
      project: z.string().optional().describe('Filter by project/workspace'),
      source: z.string().optional().describe('Filter by provenance/source'),
      memory_tier: z.string().optional().describe('Filter by lifecycle tier'),
      days: z.number().optional().describe('Only show thoughts from the last N days'),
      exclude_stale: z.boolean().optional().default(false).describe('Hide stale memories'),
      limit: z.number().optional().default(20).describe('Max results (default: 20)'),
    },
    async ({ type, topic, person, project, source, memory_tier, days, exclude_stale, limit }) => {
      try {
        const results = db.getRecentThoughts({
          type,
          topic,
          person,
          project,
          source,
          memory_tier,
          days,
          exclude_stale,
          limit: limit || 20,
        });
        if (!results.length) return { content: [{ type: 'text', text: 'No thoughts found.' }] };

        return {
          content: [{
            type: 'text',
            text: `${results.length} recent thought(s):\n\n${results.map(formatThought).join('\n\n')}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'thought_stats',
    'Get a summary of everything in your SuperBrain: totals, projects, sources, stale count, types, top topics, and people mentioned.',
    {},
    async () => {
      try {
        const stats = db.getThoughtStats();
        const sortEntries = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 10);

        const lines = [
          `Total thoughts: ${stats.total}`,
          `Date range: ${stats.oldest ? formatDate(stats.oldest) : 'N/A'} to ${stats.newest ? formatDate(stats.newest) : 'N/A'}`,
          `Stale memories: ${stats.stale_count}`,
          '',
          'Types:',
          ...sortEntries(stats.types).map(([k, v]) => `  ${k}: ${v}`),
        ];

        if (Object.keys(stats.projects).length) {
          lines.push('', 'Projects:');
          for (const [k, v] of sortEntries(stats.projects)) lines.push(`  ${k}: ${v}`);
        }

        if (Object.keys(stats.sources).length) {
          lines.push('', 'Sources:');
          for (const [k, v] of sortEntries(stats.sources)) lines.push(`  ${k}: ${v}`);
        }

        if (Object.keys(stats.tiers).length) {
          lines.push('', 'Memory tiers:');
          for (const [k, v] of sortEntries(stats.tiers)) lines.push(`  ${k}: ${v}`);
        }

        if (Object.keys(stats.topics).length) {
          lines.push('', 'Top topics:');
          for (const [k, v] of sortEntries(stats.topics)) lines.push(`  ${k}: ${v}`);
        }

        if (Object.keys(stats.people).length) {
          lines.push('', 'People mentioned:');
          for (const [k, v] of sortEntries(stats.people)) lines.push(`  ${k}: ${v}`);
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'capture_thought',
    'Save a new thought to your SuperBrain. Use this ONLY when the user explicitly asks to save, remember, or capture something.',
    {
      content: z.string().describe('The thought to capture - a clear, standalone statement'),
      type: z.string().optional().default('observation').describe('Type: observation, task, idea, reference, person_note, current_state, or incident'),
      topics: z.array(z.string()).optional().default([]).describe('1-5 short topic tags'),
      people: z.array(z.string()).optional().default([]).describe('Names of people mentioned'),
      action_items: z.array(z.string()).optional().default([]).describe('Action items or to-dos'),
      entities: z.array(z.string()).optional().default([]).describe('Important systems, repos, servers, tools, or objects mentioned'),
      source: z.string().optional().default('user').describe('Provenance/source: user, tool, inferred, manual, imported, or mcp'),
      project: z.string().optional().describe('Project/workspace this memory belongs to'),
      confidence: z.number().min(0).max(1).optional().describe('Confidence from 0 to 1'),
      verified_at: z.string().optional().describe('When this memory was verified, ISO date/time preferred'),
      stale_after: z.string().optional().describe('Exact ISO date/time after which this memory should warn as stale'),
      stale_days: z.number().optional().describe('Relative number of days until this memory should warn as stale'),
      memory_tier: z.string().optional().describe('Lifecycle tier: working, episodic, semantic, or procedural'),
      importance: z.number().min(0).max(1).optional().describe('Importance from 0 to 1'),
      expires_at: z.string().optional().describe('Optional ISO date/time when this memory should be considered expired'),
    },
    async ({ content, type, topics, people, action_items, entities, source, project, confidence, verified_at, stale_after, stale_days, memory_tier, importance, expires_at }) => {
      try {
        const metadata = {
          type: type || 'observation',
          topics: topics || [],
          people: people || [],
          action_items: action_items || [],
          entities: entities || [],
          source: source || 'user',
          project,
          confidence,
          verified_at,
          stale_after,
          stale_days,
          memory_tier,
          importance,
          expires_at,
        };

        const embedding = await generateEmbedding(content);

        const result = db.captureThought(content, metadata, embedding);
        const saved = result.metadata || metadata;

        let confirmation = `${result.action === 'updated' ? 'Updated' : 'Captured'} as ${saved.type}`;
        if (saved.project) confirmation += ` | Project: ${saved.project}`;
        if (saved.memory_tier) confirmation += ` | Tier: ${saved.memory_tier}`;
        if (Number.isFinite(Number(saved.importance))) confirmation += ` | Importance: ${Number(saved.importance).toFixed(2)}`;
        if (saved.source) confirmation += ` | Source: ${saved.source}`;
        if (Number.isFinite(Number(saved.confidence))) confirmation += ` | Confidence: ${Number(saved.confidence).toFixed(2)}`;
        if (saved.stale_after) confirmation += ` | Stale after: ${saved.stale_after}`;
        if (saved.topics?.length) confirmation += ` | Topics: ${saved.topics.join(', ')}`;
        if (saved.people?.length) confirmation += ` | People: ${saved.people.join(', ')}`;
        if (saved.action_items?.length) confirmation += ` | Actions: ${saved.action_items.join('; ')}`;

        return { content: [{ type: 'text', text: confirmation }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'summarize_topic',
    'Create an extractive briefing from related SuperBrain memories, including top topics, people, action items, stale warnings, and key thoughts.',
    {
      topic: z.string().describe('Topic or question to summarize'),
      project: z.string().optional().describe('Prefer a project/workspace'),
      days: z.number().optional().describe('Only include thoughts from the last N days'),
      limit: z.number().optional().default(12).describe('Max key thoughts to use'),
    },
    async ({ topic, project, days, limit }) => {
      try {
        const queryEmbedding = await generateEmbedding(topic);
        const summary = db.summarizeTopic({ topic, project, days, limit: limit || 12, queryEmbedding });
        return { content: [{ type: 'text', text: formatSummary(summary) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Summary error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'find_duplicate_thoughts',
    'Find likely duplicate or near-duplicate SuperBrain memories using local token similarity.',
    {
      project: z.string().optional().describe('Limit duplicate scan to a project/workspace'),
      threshold: z.number().min(0.1).max(1).optional().default(0.72).describe('Similarity threshold from 0.1 to 1.0'),
      limit: z.number().optional().default(20).describe('Max duplicate groups to return'),
    },
    async ({ project, threshold, limit }) => {
      try {
        const groups = db.findDuplicateThoughts({ project, threshold: threshold || 0.72, limit: limit || 20 });
        if (!groups.length) return { content: [{ type: 'text', text: 'No duplicate candidates found.' }] };

        const lines = [];
        groups.forEach((group, i) => {
          lines.push(`${i + 1}. Primary ${group.primary.id}: ${group.primary.content}`);
          for (const dup of group.duplicates) {
            lines.push(`   - Duplicate ${dup.id} (${dup.similarity.toFixed(2)}): ${dup.content}`);
          }
        });
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Duplicate scan error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'related_thoughts',
    'Find memories related to a specific thought by shared project, topics, entities, and people.',
    {
      id: z.string().describe('Thought ID to expand from'),
      limit: z.number().optional().default(10).describe('Max related memories to return'),
    },
    async ({ id, limit }) => {
      try {
        const results = db.getRelatedThoughts(id, { limit: limit || 10 });
        if (!results.length) return { content: [{ type: 'text', text: 'No related thoughts found.' }] };
        return {
          content: [{
            type: 'text',
            text: `${results.length} related thought(s):\n\n${results.map((thought, i) => {
              const shared = thought.shared_signals?.length ? ` shared=${thought.shared_signals.join(', ')}` : '';
              return `${formatThought(thought, i)}${shared}`;
            }).join('\n\n')}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Related search error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'project_profile',
    'Summarize a project memory profile: tiers, types, topics, entities, people, important memories, and stale count.',
    {
      project: z.string().optional().describe('Project/workspace to summarize. Omit for all memories.'),
      limit: z.number().optional().default(12).describe('Max important memories to include'),
    },
    async ({ project, limit }) => {
      try {
        const profile = db.getProjectProfile({ project, limit: limit || 12 });
        return { content: [{ type: 'text', text: formatProjectProfile(profile) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Project profile error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'backfill_embeddings',
    'Generate missing local embeddings for existing memories. Use after upgrading from older SuperBrain versions.',
    {
      project: z.string().optional().describe('Only backfill one project/workspace'),
      limit: z.number().optional().default(100).describe('Max memories to backfill in this run'),
    },
    async ({ project, limit }) => {
      try {
        const result = await db.backfillEmbeddings(generateEmbedding, { project, limit: limit || 100 });
        return { content: [{ type: 'text', text: `Embedding backfill: ${JSON.stringify(result)}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Embedding backfill error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'merge_thoughts',
    'Merge duplicate memories into a primary thought. Deletes duplicates only when delete_duplicates is true.',
    {
      primary_id: z.string().describe('Thought ID to keep'),
      duplicate_ids: z.array(z.string()).describe('Thought IDs to merge into the primary thought'),
      merged_content: z.string().optional().describe('Optional replacement content for the primary thought'),
      delete_duplicates: z.boolean().optional().default(false).describe('Delete duplicate records after merging'),
    },
    async ({ primary_id, duplicate_ids, merged_content, delete_duplicates }) => {
      try {
        const result = db.mergeThoughts(primary_id, duplicate_ids, {
          merged_content,
          delete_duplicates: Boolean(delete_duplicates),
        });
        return {
          content: [{
            type: 'text',
            text: `Merged ${result.merged_count} thought(s) into ${result.primary_id}. Deleted duplicates: ${result.deleted_duplicates}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Merge error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'export_thoughts',
    'Export SuperBrain memories as JSON or Markdown for backup or migration.',
    {
      project: z.string().optional().describe('Export only one project/workspace'),
      format: z.enum(['json', 'markdown']).optional().default('json').describe('Export format'),
    },
    async ({ project, format }) => {
      try {
        return { content: [{ type: 'text', text: db.exportThoughts({ project, format: format || 'json' }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Export error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'import_thoughts',
    'Import SuperBrain memories from a JSON export. Use dry_run first when checking an unfamiliar payload.',
    {
      payload_json: z.string().describe('JSON array or SuperBrain export object containing thoughts'),
      default_project: z.string().optional().describe('Project to use when imported thoughts do not specify one'),
      dry_run: z.boolean().optional().default(true).describe('Validate and count without writing when true'),
    },
    async ({ payload_json, default_project, dry_run }) => {
      try {
        const result = db.importThoughts(payload_json, {
          default_project,
          dry_run: dry_run !== false,
        });
        return {
          content: [{
            type: 'text',
            text: `Import ${dry_run !== false ? 'dry run' : 'complete'}: ${JSON.stringify(result)}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Import error: ${err.message}` }], isError: true };
      }
    }
  );
}

module.exports = { registerTools };
