#!/usr/bin/env node
/**
 * SuperBrain - Local AI Memory Server
 *
 * A fully local, SQLite-powered MCP server for persistent AI memory.
 * Fork of Open Brain (OB1) - no cloud, no SaaS, just your brain on your machine.
 *
 * Usage:
 *   npx @regolet/superbrain          # Run as MCP server (stdio transport)
 *   npx @regolet/superbrain --info   # Show database info and path
 *
 * Environment Variables:
 *   SUPERBRAIN_DIR  - Override the default database directory (~/.superbrain)
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { initDatabase, closeDatabase, DB_PATH } = require('./database');
const { registerTools } = require('./tools');

// Handle --info flag
if (process.argv.includes('--info')) {
  console.log('SuperBrain - Local AI Memory Server');
  console.log('===================================');
  console.log('Database path: ' + DB_PATH);
  console.log('Node.js:       ' + process.version);
  console.log('Platform:      ' + process.platform);
  console.log('');
  console.log('MCP Configuration:');
  console.log(JSON.stringify({
    mcpServers: {
      superbrain: {
        command: 'npx',
        args: ['-y', '@regolet/superbrain'],
      },
    },
  }, null, 2));
  process.exit(0);
}

// Initialize
async function main() {
  initDatabase();

  const server = new McpServer({
    name: 'superbrain',
    version: '1.0.0',
  });

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write('SuperBrain MCP server started (db: ' + DB_PATH + ')\n');
}

// Graceful Shutdown
process.on('SIGINT', () => { closeDatabase(); process.exit(0); });
process.on('SIGTERM', () => { closeDatabase(); process.exit(0); });
process.on('uncaughtException', (err) => {
  process.stderr.write('SuperBrain fatal error: ' + err.message + '\n');
  closeDatabase();
  process.exit(1);
});

main().catch((err) => {
  process.stderr.write('SuperBrain startup error: ' + err.message + '\n');
  process.exit(1);
});
