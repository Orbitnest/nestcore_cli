/**
 * `nestcore credits` end to end: the built CLI against a fake API on localhost,
 * with an isolated home directory (never the real credentials or api.nestcore.io).
 *   - credits shows balance, cap, spend, packs and the ledger
 *   - credits buy <pack> prints the checkout URL and says nothing is charged yet
 *   - credits cap <usd|off> sends the cap or null
 *   - a 402 CREDITS_EXHAUSTED prints the reason's next step and the buy link
 *
 *   npm run build && node test/credits.mjs
 */
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nestcore-cli-credits-'));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = `${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
fs.mkdirSync(path.join(tmp, '.nestcore'), { recursive: true });
fs.writeFileSync(path.join(tmp, '.nestcore', 'credentials.json'), JSON.stringify({ access_token: token }));

const summary = {
  account: 'org:o1', balanceUsd: 4.5, monthlyCapUsd: null, spentThisMonthUsd: 0.5, available: true, active: true, marginPct: 20,
  packs: [{ id: 'credits_5', priceUsd: 5, creditsUsd: 5 }, { id: 'credits_10', priceUsd: 10, creditsUsd: 10 }],
};
const BUY = 'https://nestcore.io/settings/billing?ref=credits';
let nextError = null;
const hits = [];
const api = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : undefined;
    hits.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (nextError) { const e = nextError; nextError = null; return send(e.statusCode, e); }
    if (req.method === 'GET' && req.url === '/api/billing/credits') {
      return send(200, { ...summary, ledger: [
        { id: 2, kind: 'usage', amount_usd: -0.0012, description: 'openai/gpt-4o-mini', created_at: '2026-11-06T10:00:00.000Z' },
        { id: 1, kind: 'purchase', amount_usd: 5, description: 'Credit pack credits_5', created_at: '2026-11-05T09:00:00.000Z' },
      ] });
    }
    if (req.method === 'PUT' && req.url === '/api/billing/credits/cap') return send(200, { ...summary, monthlyCapUsd: body.monthlyCapUsd });
    if (req.method === 'POST' && req.url === '/api/billing/credits/checkout') {
      return send(200, { url: 'https://checkout.stripe.com/c/pay/cs_test_1', pack: summary.packs.find((p) => p.id === body.pack), ref: body.ref });
    }
    send(404, { message: 'not found' });
  });
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));

const env = {
  ...process.env, HOME: tmp, USERPROFILE: tmp, NO_COLOR: '1',
  NESTCORE_API_URL: `http://127.0.0.1:${api.address().port}`, ORBITNEST_API_URL: '',
};
const run = (...args) => new Promise((resolve) => {
  execFile(process.execPath, [cli, ...args], { env, cwd: tmp }, (err, stdout, stderr) => {
    resolve({ code: err ? err.code ?? 1 : 0, out: stdout + stderr });
  });
});
const last = () => hits[hits.length - 1];

let passed = 0;
const ok = (name, cond, detail) => { assert.ok(cond, `${name}${detail ? `\n${detail}` : ''}`); passed++; console.log(`  ✓ ${name}`); };

let r = await run('credits');
ok('credits exits 0', r.code === 0, r.out);
ok('credits calls GET /api/billing/credits with the token', last().method === 'GET' && last().url === '/api/billing/credits' && last().auth === `Bearer ${token}`);
ok('credits shows balance, no cap, spend and margin', /balance\s+\$4\.50/.test(r.out) && /monthly cap\s+none/.test(r.out) && /spent this month\s+\$0\.50/.test(r.out) && /margin\s+20%/.test(r.out), r.out);
ok('credits lists the packs', /credits_5\s+\$5\.00\s+\$5\.00/.test(r.out) && /credits_10/.test(r.out), r.out);
ok('credits lists the ledger, sub-cent usage readable', /usage\s+-\$0\.0012\s+openai\/gpt-4o-mini/.test(r.out) && /purchase\s+\$5\.00/.test(r.out), r.out);

r = await run('credits', 'buy', 'credits_10');
ok('credits buy posts the pack with ref "cli"', last().method === 'POST' && last().url === '/api/billing/credits/checkout' && last().body.pack === 'credits_10' && last().body.ref === 'cli');
ok('credits buy prints the checkout URL and that nothing is charged yet', r.code === 0 && r.out.includes('https://checkout.stripe.com/c/pay/cs_test_1') && /Nothing is charged until you pay/.test(r.out), r.out);

const before = hits.length;
r = await run('credits', 'buy', 'Bad Pack!');
ok('credits buy rejects a malformed pack id without calling checkout', r.code !== 0 && !hits.slice(before).some((h) => h.url.includes('checkout')), r.out);
r = await run('credits', 'buy');
ok('credits buy without a pack prints usage and the packs', r.code !== 0 && /credits_5 \(\$5\.00/.test(r.out), r.out);

r = await run('credits', 'cap', '20');
ok('credits cap 20 sends monthlyCapUsd 20', r.code === 0 && last().method === 'PUT' && last().body.monthlyCapUsd === 20 && /cap set to \$20\.00/.test(r.out), r.out);
r = await run('credits', 'cap', 'off');
ok('credits cap off sends null', r.code === 0 && last().body.monthlyCapUsd === null && /cap removed/.test(r.out), r.out);
const beforeCap = hits.length;
r = await run('credits', 'cap', 'lots');
ok('credits cap rejects a non-number without calling the API', r.code !== 0 && hits.length === beforeCap, r.out);

nextError = { statusCode: 402, error: 'Payment Required', code: 'CREDITS_EXHAUSTED', reason: 'balance', message: 'This workspace has no AI credit left.', balanceUsd: 0, monthlyCapUsd: null, spentThisMonthUsd: 5, buyUrl: BUY };
r = await run('credits');
ok('CREDITS_EXHAUSTED (balance) prints the buy command and link', r.code !== 0 && /no AI credit left/.test(r.out) && /nestcore credits buy <pack>/.test(r.out) && r.out.includes(`Buy credit: ${BUY}`), r.out);
nextError = { statusCode: 402, error: 'Payment Required', code: 'CREDITS_EXHAUSTED', reason: 'spend_cap', message: 'Cap reached.', balanceUsd: 3, monthlyCapUsd: 10, spentThisMonthUsd: 10, buyUrl: BUY };
r = await run('credits');
ok('CREDITS_EXHAUSTED (spend_cap) points at credits cap', r.code !== 0 && /nestcore credits cap <usd\|off>/.test(r.out), r.out);

r = await run('--help');
ok('help lists the credits commands', /credits buy <pack>/.test(r.out) && /credits cap <usd\|off>/.test(r.out), r.out);

api.closeAllConnections();
await new Promise((res) => api.close(res));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
console.log(`\nOK — ${passed} credits checks passed.`);
