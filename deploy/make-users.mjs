#!/usr/bin/env node
/**
 * Add, list or remove the people who may log in to the hosted instance.
 *
 *   node deploy/make-users.mjs alice
 *   node deploy/make-users.mjs --list
 *   node deploy/make-users.mjs --remove alice
 *
 * Caddy only accepts bcrypt hashes, and Node has no bcrypt. Rather than add a
 * dependency for one prompt, this asks Caddy itself to hash the password: the
 * `caddy` binary when it is on PATH, otherwise the same image the deployment
 * runs. The password goes in on that process's stdin, never as an argument,
 * so it does not show up in a process list; it is never printed and never
 * written anywhere except as a hash.
 *
 * Caddy reads the resulting file on `docker compose restart caddy` (or
 * `caddy reload`); the app does not need restarting.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USERS = path.join(HERE, 'users.caddyfile');
const CADDY_IMAGE = 'caddy:2.11-alpine';
const USERNAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const HEADER = `# Managed by deploy/make-users.mjs.
# One line per person: username <bcrypt hash>. Reload Caddy after editing.
`;

const die = (message) => {
  console.error(`make-users: ${message}`);
  process.exit(1);
};

function readUsers() {
  if (!existsSync(USERS)) return [];
  return readFileSync(USERS, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function writeUsers(lines) {
  const body = lines.length ? `${lines.join('\n')}\n` : '';
  writeFileSync(USERS, `${HEADER}${body}`, { mode: 0o600 });
}

/**
 * Piped input is read in full, once. Building a fresh readline per prompt
 * loses the second line: the first interface consumes the buffered chunk and
 * closes, so the later prompt waits on a stream that has already ended.
 */
let pipedLines = null;

async function nextPipedLine() {
  if (!pipedLines) {
    pipedLines = [];
    const reader = createInterface({ input: process.stdin });
    for await (const line of reader) pipedLines.push(line);
    reader.close();
  }
  return pipedLines.shift() ?? '';
}

/** Ask for a password without echoing it; piped input is read line by line. */
function readPassword(label) {
  if (!process.stdin.isTTY) return nextPipedLine();
  return new Promise((resolve, reject) => {
    process.stdout.write(label);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const finish = (result, error) => {
      stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
      stdin.off('data', onData);
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(result);
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\u0003') {
          finish(null, new Error('cancelled'));
          return;
        }
        if (char === '\r' || char === '\n') {
          finish(value, null);
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= ' ') value += char;
      }
    };
    stdin.on('data', onData);
  });
}

/** Run Caddy's own hasher. Returns the `$2a$...` line Caddy expects. */
function hashPassword(password) {
  const hasCaddy = spawnSync('caddy', ['version'], { encoding: 'utf8' });
  const command = hasCaddy.status === 0 ? 'caddy' : 'docker';
  const args =
    command === 'caddy'
      ? ['hash-password']
      : ['run', '--rm', '-i', CADDY_IMAGE, 'caddy', 'hash-password'];
  const run = spawnSync(command, args, {
    encoding: 'utf8',
    input: `${password}\n`,
  });
  if (run.error) {
    die(
      command === 'caddy'
        ? `could not run caddy: ${run.error.message}`
        : `could not run docker: ${run.error.message}. Install Docker, or Caddy, and try again.`,
    );
  }
  if (run.status !== 0) {
    die(`${command} hash-password failed: ${(run.stderr || '').trim()}`);
  }
  const hash = run.stdout.trim().split(/\r?\n/).pop();
  if (!/^\$2[aby]\$/.test(hash ?? '')) {
    die(`${command} returned no bcrypt hash`);
  }
  return hash;
}

async function addUser(name) {
  if (!USERNAME.test(name)) {
    die('usernames are 1-32 characters: a-z, 0-9, dot, dash, underscore');
  }
  const lines = readUsers();
  if (lines.some((line) => line.split(/\s+/)[0] === name)) {
    die(`"${name}" is already in users.caddyfile; remove it first`);
  }
  const password = await readPassword(`Password for ${name}: `);
  if (password.length < 12) {
    die('use at least 12 characters; this is the only thing guarding the site');
  }
  const again = await readPassword('Again: ');
  if (password !== again) die('the passwords did not match');
  const hash = hashPassword(password);
  writeUsers([...lines, `${name} ${hash}`]);
  console.log(
    `${name}: added. Reload Caddy to apply: docker compose restart caddy`,
  );
}

function removeUser(name) {
  const lines = readUsers();
  const kept = lines.filter((line) => line.split(/\s+/)[0] !== name);
  if (kept.length === lines.length) die(`"${name}" is not in users.caddyfile`);
  writeUsers(kept);
  console.log(
    `${name}: removed. Reload Caddy to apply: docker compose restart caddy`,
  );
}

function listUsers() {
  const lines = readUsers();
  if (!lines.length) {
    console.log('users.caddyfile lists nobody; nobody can log in.');
    return;
  }
  for (const line of lines) console.log(line.split(/\s+/)[0]);
}

const [first, ...rest] = process.argv.slice(2);
if (first === '--list') listUsers();
else if (first === '--remove') {
  if (!rest[0]) die('usage: node deploy/make-users.mjs --remove <username>');
  removeUser(rest[0]);
} else if (!first) {
  console.log(
    'usage: node deploy/make-users.mjs <username>\n' +
      '       node deploy/make-users.mjs --list\n' +
      '       node deploy/make-users.mjs --remove <username>',
  );
} else {
  await addUser(first);
}
