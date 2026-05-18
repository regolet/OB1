#!/usr/bin/env node
/**
 * SuperBrain Hook Installer
 * Run: npx @regolet/superbrain install-hooks
 * Or:  superbrain-install-hooks
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOOK_SCRIPT = path.join(__dirname, 'capture-session.js');
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

function install() {
  // Ensure .claude dir exists
  const claudeDir = path.dirname(SETTINGS_PATH);
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch { /* fresh file */ }

  settings.hooks = settings.hooks || {};
  settings.hooks.Stop = settings.hooks.Stop || [];
  settings.permissions = settings.permissions || {};
  settings.permissions.allow = settings.permissions.allow || [];

  // Hook entry
  const command = `node "${HOOK_SCRIPT.replace(/\\/g, '/')}"`;
  const alreadyInstalled = settings.hooks.Stop.some(
    entry => entry.hooks?.some(h => h.command?.includes('capture-session'))
  );

  if (!alreadyInstalled) {
    settings.hooks.Stop.push({
      matcher: '',
      hooks: [{ type: 'command', command }],
    });
    console.log(`✅ Installed Stop hook: ${command}`);
  } else {
    console.log('ℹ️  Stop hook already installed.');
  }

  // Permission entry
  const perm = 'Bash(node *capture-session*)';
  if (!settings.permissions.allow.includes(perm)) {
    settings.permissions.allow.push(perm);
    console.log(`✅ Added permission: ${perm}`);
  }

  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  console.log(`\n📍 Settings updated: ${SETTINGS_PATH}`);
  console.log('🧠 SuperBrain will now auto-capture session summaries when Claude Code sessions end.');
}

install();
