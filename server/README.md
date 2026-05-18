# @regolet/superbrain

SuperBrain is a fully local, SQLite-powered MCP server for persistent AI memory.
It is a fork of Open Brain (OB1) focused on local-first personal memory: no cloud,
no SaaS, and no API key required.

## Features

- Local SQLite database at `~/.superbrain/brain.db`
- FTS5 keyword search plus optional local vector embeddings
- Provenance metadata: `source`, `confidence`, `verified_at`, `stale_after`
- Lifecycle metadata: `memory_tier`, `importance`, `expires_at`
- Project-aware recall with `project` and `project_scope`
- Access reinforcement with `access_count` and `last_accessed`
- Stale warnings for old operational memories
- Related-memory expansion by shared topics, entities, people, and project
- Project profiles with tiers, entities, important memories, and stale count
- Duplicate detection and optional merge
- Topic summaries with key thoughts, action items, people, and stale warnings
- JSON/Markdown export and JSON import

## Quick Start

Add this to your MCP configuration:

```json
{
  "mcpServers": {
    "superbrain": {
      "command": "npx",
      "args": ["-y", "@regolet/superbrain"]
    }
  }
}
```

## Tools

| Tool | Description |
| ---- | ----------- |
| `search` | Search by keywords, natural language, project, source, type, topic, or person |
| `recent_thoughts` | Browse recent memories with metadata filters |
| `thought_stats` | Show totals, projects, sources, stale count, topics, and people |
| `capture_thought` | Save a memory with provenance, project, confidence, and staleness |
| `summarize_topic` | Build an extractive briefing from matching memories |
| `find_duplicate_thoughts` | Find likely duplicate memories |
| `related_thoughts` | Expand from one memory to related memories |
| `project_profile` | Summarize a project memory profile |
| `backfill_embeddings` | Generate missing local embeddings for older memories |
| `merge_thoughts` | Merge duplicate memories into a primary memory |
| `export_thoughts` | Export memories as JSON or Markdown |
| `import_thoughts` | Import memories from a JSON export |

## Configuration

| Environment Variable | Default | Description |
| -------------------- | ------- | ----------- |
| `SUPERBRAIN_DIR` | `~/.superbrain` | Database directory |
| `SUPERBRAIN_PROJECT` | unset | Default project to attach to new captures and boost during search |
| `SUPERBRAIN_EMBEDDINGS` | `1` | Set to `0`, `false`, or `off` to disable local embeddings |
| `SUPERBRAIN_EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | Local embedding model |
| `SUPERBRAIN_EMBEDDINGS_QUIET` | unset | Set to `1` to suppress embedding fallback warnings |

## Examples

Capture a current project memory:

```text
capture_thought(
  content: "SuperBrain uses local SQLite and should not be merged blindly with upstream Deno server changes.",
  type: "decision",
  project: "SuperBrain",
  source: "user",
  confidence: 0.95,
  memory_tier: "semantic",
  importance: 0.9,
  topics: ["superbrain", "architecture"]
)
```

Search with project boost:

```text
search(query: "local memory architecture", project: "SuperBrain", project_scope: "boost")
```

Create a topic briefing:

```text
summarize_topic(topic: "router deployment", project: "LiteFi")
```

Backfill embeddings after upgrading:

```bash
npx -p @regolet/superbrain superbrain-backfill --limit=100
```

Export before a migration:

```text
export_thoughts(format: "json")
```

## CLI

```bash
npx @regolet/superbrain --info
npx -p @regolet/superbrain superbrain-backfill --limit=100
npm test
```

## License

FSL-1.1-MIT. Forked from [OB1](https://github.com/NateBJones-Projects/OB1).
