/**
 * The API host comes from you, never from the repository: the built CLI against
 * two fake APIs on localhost (A = the one you logged in to, B = a host named in
 * a cloned repo's .nestcore/config.json), with an isolated home directory.
 *   - project commands refuse a link whose apiUrl differs from the session's,
 *     and send nothing to either host
 *   - login posts the password to the session's / default API, never the link's
 *   - NESTCORE_API_URL (an explicit choice) wins, with a warning
 *   - whoami / logout / link still work there and only talk to A
 *   - a matching link (or the official hosts' old/new names) works as before
 *   - credits buy --open never opens a non-plain https URL
 *
 *   npm run build && node test/api-origin.mjs
 */
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nestcore-cli-origin-'));
const home = path.join(tmp, 'home');
const work = path.join(tmp, 'work');
fs.mkdirSync(path.join(home, '.nestcore'), { recursive: true });
fs.mkdirSync(path.join(work, '.nestcore'), { recursive: true });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (sub) => `${b64({ alg: 'HS256' })}.${b64({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const TOKEN = jwt('u1');
const PROJECT = { id: '00000000-0000-4000-8000-000000000001', slug: 'shop', name: 'Shop' };

function fakeApi(handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      hits.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      handler(req, body, send);
    });
  });
  return { server, hits };
}

const A = fakeApi((req, body, send) => {
  if (req.method === 'POST' && req.url === '/api/auth/signin') return send(200, { access_token: TOKEN, refresh_token: 'rt-a', user: { email: body.email } });
  if (req.method === 'GET' && (req.url === '/api/projects' || req.url.startsWith('/api/projects?'))) return send(200, [PROJECT]);
  if (req.method === 'GET' && req.url === '/api/auth/profile') return send(200, { user: { email: 'me@example.com' } });
  if (req.method === 'POST' && req.url === '/api/auth/signout') return send(200, {});
  if (req.method === 'POST' && req.url === '/api/billing/credits/checkout') {
    return send(200, { url: 'https://127.0.0.1:1/c/pay|calc', pack: { id: body.pack, priceUsd: 5, creditsUsd: 5 } });
  }
  send(404, { message: 'not found' });
});
// The attacker host answers 401 to everything, which would trigger a refresh-token post.
const B = fakeApi((req, body, send) => send(401, { message: 'unauthorized' }));
await new Promise((r) => A.server.listen(0, '127.0.0.1', r));
await new Promise((r) => B.server.listen(0, '127.0.0.1', r));
const urlA = `http://127.0.0.1:${A.server.address().port}`;
const urlB = `http://127.0.0.1:${B.server.address().port}`;

const credsFile = path.join(home, '.nestcore', 'credentials.json');
const linkFile = path.join(work, '.nestcore', 'config.json');
const setCreds = (c) => fs.writeFileSync(credsFile, JSON.stringify(c));
const setLink = (apiUrl) => fs.writeFileSync(linkFile, JSON.stringify({ projectId: PROJECT.id, projectSlug: PROJECT.slug, name: PROJECT.name, apiUrl }));
const signedInToA = () => setCreds({ apiUrl: urlA, access_token: TOKEN, refresh_token: 'rt-a' });

const baseEnv = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' };
for (const k of ['NESTCORE_API_URL', 'ORBITNEST_API_URL', 'NESTCORE_EMAIL', 'ORBITNEST_EMAIL', 'NESTCORE_PASSWORD', 'ORBITNEST_PASSWORD']) delete baseEnv[k];
const run = (args, extraEnv = {}) => new Promise((resolve) => {
  execFile(process.execPath, [cli, ...args], { env: { ...baseEnv, ...extraEnv }, cwd: work }, (err, stdout, stderr) => {
    resolve({ code: err ? err.code ?? 1 : 0, out: stdout + stderr });
  });
});
const reset = () => { A.hits.length = 0; B.hits.length = 0; };

let passed = 0;
const ok = (name, cond, detail) => { assert.ok(cond, `${name}${detail ? `\n${detail}` : ''}`); passed++; console.log(`  ✓ ${name}`); };

// ── a cloned repo names another API ─────────────────────────────────────────
signedInToA();
setLink(urlB);
reset();
let r = await run(['projects']);
ok('project command refuses a link naming another API', r.code !== 0 && /config\.json names API/.test(r.out) && /nestcore login --url/.test(r.out), r.out);
ok('…and sends nothing to the link host', B.hits.length === 0, JSON.stringify(B.hits));
ok('…nor to the session host', A.hits.length === 0, JSON.stringify(A.hits));

reset();
r = await run(['db', 'status']);
ok('db status refuses too; no access or refresh token reaches the link host', r.code !== 0 && B.hits.length === 0, r.out);

reset();
r = await run(['whoami']);
ok('whoami still works and only talks to the session host', r.code === 0 && A.hits.length === 1 && A.hits[0].auth === `Bearer ${TOKEN}` && B.hits.length === 0, r.out);

reset();
r = await run(['projects'], { NESTCORE_API_URL: urlA });
ok('NESTCORE_API_URL is an explicit choice: runs with a warning', r.code === 0 && /using NESTCORE_API_URL/.test(r.out) && A.hits.length > 0 && B.hits.length === 0, r.out);

reset();
r = await run(['logout']);
ok('logout revokes on the session host only', r.code === 0 && A.hits.some((h) => h.url === '/api/auth/signout') && B.hits.length === 0, r.out);
ok('logout keeps the session API in the credentials', JSON.parse(fs.readFileSync(credsFile, 'utf8')).apiUrl === urlA);

// login: the password goes to the API you logged in to, not the link's.
reset();
r = await run(['login', '--email', 'me@example.com', '--password', 'dummy-password']);
ok('login posts the password to the session API, not the link host', r.code === 0 && A.hits.some((h) => h.url === '/api/auth/signin' && h.body.password === 'dummy-password') && B.hits.length === 0, r.out);
ok('login keeps the session API in the credentials', JSON.parse(fs.readFileSync(credsFile, 'utf8')).apiUrl === urlA);

// No stored API: login falls back to the default, never the link (nothing is sent to B).
setCreds({});
reset();
r = await run(['login', '--email', 'me@example.com', '--password', 'dummy-password'], { NESTCORE_API_URL: urlA });
ok('fresh login with NESTCORE_API_URL ignores the link', r.code === 0 && A.hits.length > 0 && B.hits.length === 0, r.out);

// Re-linking the directory works and records the session's API.
signedInToA();
reset();
r = await run(['link', 'shop']);
ok('link re-links a directory whose link named another API', r.code === 0 && JSON.parse(fs.readFileSync(linkFile, 'utf8')).apiUrl === urlA && B.hits.length === 0, r.out);

// ── matching link: works as before ──────────────────────────────────────────
setLink(`${urlA}/`);
reset();
r = await run(['projects']);
ok('a link naming the session API (trailing slash) works', r.code === 0 && /Shop/.test(r.out) && A.hits[0].auth === `Bearer ${TOKEN}`, r.out);

setLink(undefined);
reset();
r = await run(['projects']);
ok('a link without apiUrl works', r.code === 0 && /Shop/.test(r.out), r.out);

// ── browser opener ──────────────────────────────────────────────────────────
reset();
r = await run(['credits', 'buy', 'credits_5', '--open']);
ok('credits buy --open prints but does not open a URL with shell metacharacters', r.code === 0 && r.out.includes('https://127.0.0.1:1/c/pay|calc') && !/Opened it in your browser/.test(r.out), r.out);

A.server.close();
B.server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nOK — ${passed} api-origin checks passed.`);
