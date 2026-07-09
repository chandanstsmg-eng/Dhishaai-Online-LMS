#!/usr/bin/env node
/**
 * DhishaAI Enterprise LMS v5.0 - Startup Script
 * Run: node start.js   (same as: npm start / node server/index.js)
 *
 * The frontend is pre-built into client/dist and served by the Express
 * server itself, so this just launches the single backend process.
 * The port comes from server/.env (PORT=80).
 */
const { spawn } = require('child_process');
const path = require('path');

const SERVER_DIR = path.join(__dirname, 'server');

console.log('\x1b[1m\x1b[33m');
console.log('  DhishaAI Enterprise LMS v5.0');
console.log('\x1b[0m  Starting server...\n');

const server = spawn(process.platform === 'win32' ? 'node.exe' : 'node', ['index.js'], {
  cwd: SERVER_DIR,
  stdio: 'inherit',
  shell: false,
});

server.on('error', (e) => {
  console.error('\x1b[31m[SERVER ERROR]\x1b[0m', e.message);
  console.error('Make sure Node.js is installed. On Linux, port 80 needs: sudo node start.js');
  process.exit(1);
});

server.on('close', (code) => {
  if (code !== 0) process.exit(code);
});

process.on('SIGINT', () => {
  server.kill('SIGTERM');
  process.exit(0);
});
