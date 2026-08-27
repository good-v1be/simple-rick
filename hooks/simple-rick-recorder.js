#!/usr/bin/env node
// Simple Rick Recorder — PostToolUse hook
// Sends tool call info to Simple Rick HTTP API for session recording.
// Runs fire-and-forget: errors are silently ignored to avoid blocking Claude Code.

const http = require('http');

const SR_HOST = '127.0.0.1';
const SR_PORT = 3777;
// Check if Simple Rick is running by trying to connect
// Token is passed via SIMPLE_RICK_TOKEN env var or .simple-rick/.token file
const fs = require('fs');
const path = require('path');

function getToken() {
  if (process.env.SIMPLE_RICK_TOKEN) return process.env.SIMPLE_RICK_TOKEN;
  // Walk up from cwd to find .simple-rick/.token
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const tokenPath = path.join(dir, '.simple-rick', '.token');
    try { return fs.readFileSync(tokenPath, 'utf-8').trim(); } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const SR_TOKEN = getToken();
if (!SR_TOKEN) process.exit(0);

let input = '';
const timeout = setTimeout(() => process.exit(0), 3000);

process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  clearTimeout(timeout);
  try {
    const hook = JSON.parse(input);
    const toolName = hook.tool_name || hook.toolName || 'unknown';
    const toolInput = hook.tool_input || hook.toolInput || '';
    const toolOutput = hook.tool_output || hook.toolOutput || '';

    // Skip recording our own calls and noisy tools
    if (toolName.startsWith('simple_rick') || toolName.startsWith('mcp__simple-rick')) {
      process.exit(0);
    }

    // Build content summary
    const inputStr = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput);
    const outputStr = typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput);
    const content = `[${toolName}] ${inputStr.slice(0, 500)}${outputStr ? '\n---\n' + outputStr.slice(0, 1000) : ''}`;

    const payload = JSON.stringify({
      role: 'tool_call',
      content,
      tool_name: toolName,
      tool_input: inputStr.slice(0, 2000),
    });

    const req = http.request({
      hostname: SR_HOST,
      port: SR_PORT,
      path: `/api/record?token=${SR_TOKEN}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 2000,
    }, () => process.exit(0));

    req.on('error', () => process.exit(0));
    req.on('timeout', () => { req.destroy(); process.exit(0); });
    req.write(payload);
    req.end();
  } catch {
    process.exit(0);
  }
});
