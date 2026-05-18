// scripts/start-all.js — Starts all three processes
const { spawn } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');

function start(name, dir, cmd, args, color) {
  const proc = spawn(cmd, args, {
    cwd: path.join(root, dir),
    env: { ...process.env },
    stdio: 'pipe',
  });

  proc.stdout.on('data', (d) => process.stdout.write(`${color}[${name}]\x1b[0m ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`${color}[${name}]\x1b[0m ${d}`));

  proc.on('exit', (code) => {
    console.log(`\x1b[31m[${name}]\x1b[0m exited with code ${code}. Restarting in 5s...`);
    setTimeout(() => start(name, dir, cmd, args, color), 5000);
  });

  return proc;
}

console.log('\x1b[32m[MIRROR]\x1b[0m Starting all services...\n');

start('SLAVE',     'slave',     'node', ['index.js'], '\x1b[33m');
start('MASTER',    'master',    'node', ['index.js'], '\x1b[36m');
start('DASHBOARD', 'dashboard', 'node', ['index.js'], '\x1b[35m');

process.on('SIGINT', () => {
  console.log('\n\x1b[32m[MIRROR]\x1b[0m Shutting down...');
  process.exit(0);
});
