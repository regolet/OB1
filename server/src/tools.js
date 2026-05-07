const { z } = require('zod');
const db = require('./database');

function registerTools(server) {

  // Tool 1: Search
  server.tool(
    'search',
    'Search your SuperBrain by keywords or phrases. Returns the most relevant thoughts matching your query.',
    {
      query: z.string().describe('The search query - keywords or a natural language question'),
      limit: z.number().optional().default(10).describe('Max results to return (default: 10)'),
    },
    async ({ query, limit }) => {
      try {
        const results = db.searchThoughts(query, limit || 10);
        if (!results.length) return { content: [{ type: 'text', text: 'No matching thoughts found.' }] };

        const formatted = results.map((t, i) => {
          const m = t.metadata || {};
          const tags = Array.isArray(m.topics) ? m.topics.join(', ') : '';
          const date = t.created_at ? new Date(t.created_at + 'Z').toLocaleDateString() : '??';
          return (i + 1) + '. [' + date + '] (' + (m.type || 'thought') + (tags ? ' - ' + tags : '') + ')\n   ' + t.content;
        });

        return { content: [{ type: 'text', text: results.length + ' result(s):\n\n' + formatted.join('\n\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Search error: ' + err.message }], isError: true };
      }
    }
  );

  // Tool 2: Recent Thoughts
  server.tool(
    'recent_thoughts',
    'Browse recent thoughts from your SuperBrain. Optionally filter by type, topic, person, or days.',
    {
      type: z.string().optional().describe('Filter by type: observation, task, idea, reference, person_note'),
      topic: z.string().optional().describe('Filter by topic tag'),
      person: z.string().optional().describe('Filter by person mentioned'),
      days: z.number().optional().describe('Only show thoughts from the last N days'),
      limit: z.number().optional().default(20).describe('Max results (default: 20)'),
    },
    async ({ type, topic, person, days, limit }) => {
      try {
        const results = db.getRecentThoughts({ type, topic, person, days, limit: limit || 20 });
        if (!results.length) return { content: [{ type: 'text', text: 'No thoughts found.' }] };

        const formatted = results.map((t, i) => {
          const m = t.metadata || {};
          const tags = Array.isArray(m.topics) ? m.topics.join(', ') : '';
          const date = t.created_at ? new Date(t.created_at + 'Z').toLocaleDateString() : '??';
          return (i + 1) + '. [' + date + '] (' + (m.type || '??') + (tags ? ' - ' + tags : '') + ')\n   ' + t.content;
        });

        return { content: [{ type: 'text', text: results.length + ' recent thought(s):\n\n' + formatted.join('\n\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Error: ' + err.message }], isError: true };
      }
    }
  );

  // Tool 3: Thought Stats
  server.tool(
    'thought_stats',
    'Get a summary of everything in your SuperBrain: total count, types, top topics, and people mentioned.',
    {},
    async () => {
      try {
        const stats = db.getThoughtStats();
        const sortEntries = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 10);

        const lines = [
          'Total thoughts: ' + stats.total,
          'Date range: ' + (stats.oldest ? new Date(stats.oldest + 'Z').toLocaleDateString() : 'N/A') + ' to ' + (stats.newest ? new Date(stats.newest + 'Z').toLocaleDateString() : 'N/A'),
          '', 'Types:',
          ...sortEntries(stats.types).map(([k, v]) => '  ' + k + ': ' + v),
        ];

        if (Object.keys(stats.topics).length) {
          lines.push('', 'Top topics:');
          for (const [k, v] of sortEntries(stats.topics)) lines.push('  ' + k + ': ' + v);
        }

        if (Object.keys(stats.people).length) {
          lines.push('', 'People mentioned:');
          for (const [k, v] of sortEntries(stats.people)) lines.push('  ' + k + ': ' + v);
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Error: ' + err.message }], isError: true };
      }
    }
  );

  // Tool 4: Capture Thought
  server.tool(
    'capture_thought',
    'Save a new thought to your SuperBrain. Use this ONLY when the user explicitly asks to save, remember, or capture something.',
    {
      content: z.string().describe('The thought to capture - a clear, standalone statement'),
      type: z.string().optional().default('observation').describe('Type: observation, task, idea, reference, or person_note'),
      topics: z.array(z.string()).optional().default([]).describe('1-3 short topic tags'),
      people: z.array(z.string()).optional().default([]).describe('Names of people mentioned'),
      action_items: z.array(z.string()).optional().default([]).describe('Action items or to-dos'),
      source: z.string().optional().default('mcp').describe('Source (e.g., mcp, slack, manual)'),
    },
    async ({ content, type, topics, people, action_items, source }) => {
      try {
        const metadata = {
          type: type || 'observation',
          topics: topics || [],
          people: people || [],
          action_items: action_items || [],
          source: source || 'mcp',
        };

        const result = db.captureThought(content, metadata);

        let confirmation = (result.action === 'updated' ? 'Updated' : 'Captured') + ' as ' + metadata.type;
        if (metadata.topics.length) confirmation += ' - ' + metadata.topics.join(', ');
        if (metadata.people.length) confirmation += ' | People: ' + metadata.people.join(', ');
        if (metadata.action_items.length) confirmation += ' | Actions: ' + metadata.action_items.join('; ');

        return { content: [{ type: 'text', text: confirmation }] };
      } catch (err) {
        return { content: [{ type: 'text', text: 'Error: ' + err.message }], isError: true };
      }
    }
  );
}

module.exports = { registerTools };
