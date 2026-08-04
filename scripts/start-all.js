#!/usr/bin/env node
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const tasks = ['start:bootstrap', 'webhook', 'ngrok:webhook'];
const children = tasks.map((task) => {
  const child = spawn(npm, ['run', task], { stdio: 'inherit' });
  child.task = task;
  return child;
});

let shuttingDown = false;

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGINT');
    }
  }

  setTimeout(() => process.exit(exitCode), 500);
}

for (const child of children) {
  child.on('error', (error) => {
    console.error(`Failed to start npm run ${child.task}:`, error.message);
    shutdown(1);
  });

  child.on('exit', (code, signal) => {
    const codeMessage = code !== null ? `code ${code}` : `signal ${signal}`;
    if (!shuttingDown && code !== 0) {
      console.error(`npm run ${child.task} exited with ${codeMessage}`);
      shutdown(code || 1);
    }
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
