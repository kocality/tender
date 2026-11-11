// Regression tests for the judge-facing docs. Run: node --test docs/scripts/docs-checks.test.mjs
// Optional: DOCS_DIR=<dir with README.md, JUDGES.md, video/*> checks another copy of the docs against the repo's code;
// CLAIMS_LINT=<path> runs another copy of claims-lint.sh; COUNTS=1 re-runs the pnpm test suites and compares them with the README; LIVE=1 reads public testnet RPC and api.meme.cooking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const docs = process.env.DOCS_DIR ? resolve(process.env.DOCS_DIR) : repo;
const lint = process.env.CLAIMS_LINT ? resolve(process.env.CLAIMS_LINT) : join(repo, 'docs/scripts/claims-lint.sh');
const read = (root, p) => readFileSync(join(root, p), 'utf8');
const readme = () => read(docs, 'README.md');
const judges = () => read(docs, 'JUDGES.md');

function runLint(files, env = {}) {
  const r = spawnSync('bash', [lint, ...files], { env: { ...process.env, FREEZE: '', ...env }, encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
}
const scratch = mkdtempSync(join(tmpdir(), 'tender-docs-'));
function fixture(name, text) {
  const p = join(scratch, name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
}
const fails = (out, fragment) => out.split('\n').some((l) => l.startsWith('FAIL') && l.includes(fragment));

// ---- the published docs pass the lint ------------------------------------------------------------------------------
test('claims-lint passes on the published docs', () => {
  const r = runLint(['README.md', 'JUDGES.md', 'video/script.md', 'video/captions.srt', 'video/captions-x.srt', 'app/src/copy.ts'].map((p) =>
    p.startsWith('app/') ? p : join(docs, p)));
  assert.equal(r.status, 0, r.out);
});

// ---- each lint rule fails on the old wording and passes on the corrected wording -------------------------------------
const rules = [
  ['CRYPTO-04 collusion wording names former share holders',
    'Privacy needs fewer than 11 of 16 MPC nodes colluding.',
    'Privacy needs fewer than 11 of the parties that hold or ever held a share colluding.', 'collud'],
  ['CRYPTO-04 spoken form',
    'Reading it anyway would take eleven of sixteen MPC nodes colluding.',
    'Reading it anyway would take eleven of the parties that hold or ever held a key share colluding.', 'collud'],
  ['CLM-02 not every sale is public',
    'Problem: in token sales today every bid is public, so people snipe.',
    'Problem: in most token sales today every bid is public, so people snipe.', 'every bid is public'],
  ['CLM-02 spoken form', 'Token sales today are public.', 'Most token sales today are public.', 'every bid is public'],
  ['CLM-03 key exists as a fixed MPC key', "encrypted to a key that doesn't exist yet.", 'encrypted to a key nobody has requested yet.', 'exist yet'],
  ['CLM-06 two commands', 'One free command re-reads mainnet.', 'Two free commands re-read mainnet.', 'one free command'],
  ['CLM-06 bond only after the key is out', 'A bid that never opens costs a ten percent bond.',
    'A bid that is never revealed after the key is out loses a ten percent bond.', 'one free command'],
  ['CLM-09 yield/resume is inside v1.signer', 'request_app_private_key, called by the contract through yield/resume.',
    'request_app_private_key, a cross-contract call with a callback; v1.signer answers through its own yield/resume.', 'yield'],
  ['SC-03 seller means the seller account', 'The 10% goes to revealed bidders and 0 to the seller.',
    "The 10% goes to revealed bidders and 0 to the seller's account.", 'to the seller'],
  ['SC-03 never to the seller', 'It is paid to revealed bidders, never to the seller.',
    "It is paid to revealed bidders, never to the seller's account.", 'to the seller'],
  ['OPS-06 sale 2 closes inside the judging window', 'Sale 2 stays open during judging.',
    'Sale 2 closes at 2026-11-17T12:00:00Z, inside the judging window.', 'stays open'],
  ['CLM-07 demo timing', 'cleared offline in about 5 s.', 'cleared offline in under a second.', 'in about 5 s'],
  ['CLM-07 vectors string', 'see `4/4` official near/mpc CKD test vectors pass.', 'see `4 passed (4)`: the official vectors pass.', '4/4'],
  ['CLM-07 filtered install list', 'see the install finish with only the CLI and its libraries.',
    'see the install finish with only the CLI and its libraries, plus the TypeScript runner (tsx, vitest).', 'only the CLI'],
  ['CI-03 testnet run is against an earlier build', 'Testnet: 21/22 checks passed (1 warning).',
    'Testnet: 21/22 checks passed (1 warning) against the earlier build.', '21/22'],
];
for (const [name, bad, good, frag] of rules) {
  test(`lint rule: ${name}`, () => {
    assert.ok(fails(runLint([fixture('bad.md', bad + '\n')]).out, frag), `old wording must fail: ${bad}`);
    assert.ok(!fails(runLint([fixture('good.md', good + '\n')]).out, frag), `corrected wording must pass: ${good}`);
  });
}

test('lint: a phrase split across SRT cues is still caught', () => {
  const srt = '1\n00:00:00,000 --> 00:00:03,000\nencrypted to a key that\ndoesn\'t\n\n2\n00:00:03,000 --> 00:00:05,000\nexist yet. I sign.\n';
  assert.ok(fails(runLint([fixture('c.srt', srt)]).out, 'exist yet'));
  const ok = '1\n00:00:00,000 --> 00:00:03,000\nencrypted to a key nobody\n\n2\n00:00:03,000 --> 00:00:05,000\nhas requested yet.\n';
  assert.ok(!fails(runLint([fixture('d.srt', ok)]).out, 'exist yet'));
});

test('CI-01: a build hash that is not contract/res/tender.wasm.sha256 fails, the real one passes, no hash passes', () => {
  const real = readFileSync(join(repo, 'contract/res/tender.wasm.sha256'), 'utf8').split(/\s+/)[0];
  assert.match(real, /^[0-9a-f]{64}$/);
  const stale = '59c0b7bf2b4df66899bcee9beaa84cdca343f553826b197ce89df5be3119c106';
  const bad = fixture('hash/README.md', `| Reproducible build in CI | job repro printed sha256 \`${stale}\` |\n`);
  assert.ok(fails(runLint([bad]).out, `build hash ${stale}`));
  const good = fixture('hash2/README.md', `| Reproducible build | sha256 \`${real}\` |\n`);
  assert.ok(!fails(runLint([good]).out, 'build hash'));
});

test('CLM-01: FREEZE=1 fails on unfinished markers and passes on a finished page', () => {
  const todo = fixture('f1.md', 'Done. <!-- TODO(evidence: tx hash) -->\n');
  const ph = fixture('f2.md', 'Open `<HOSTED_URL>/#/try`.\n');
  const nm = fixture('f3.md', 'see `<N>/<M> checks passed`.\n');
  const hash = fixture('f4.md', 'sha256 `<hash>` and `<docker reproducible build command>` and `<mode>`.\n');
  const draft = fixture('f5.md', 'Status of this page: DRAFT, before the mainnet deployment.\n');
  for (const p of [todo, ph, nm, hash, draft]) {
    assert.equal(runLint([p], { FREEZE: '1' }).status, 1, p);
    assert.equal(runLint([p]).status, 0, `${p} is fine outside freeze mode`);
  }
  const clean = fixture('f6.md', 'Use `--rpc <url> --archival-rpc <url>` if a public RPC rate-limits you.\n');
  assert.equal(runLint([clean], { FREEZE: '1' }).status, 0);
});

test('CLM-01: FREEZE=1 requires a transaction hash on every attack-room row', () => {
  const head = '## Attack room\n| Attack | Result | Transaction |\n|---|---|---|\n';
  const tx = '4e74FNSTRsqeckYYq8PJZmcX85DSkJeMPkjaChW48rwD';
  const noTx = fixture('a1/README.md', `${head}| Late bid | Refunded |  |\n\n## Next\n`);
  assert.ok(fails(runLint([noTx], { FREEZE: '1' }).out, 'attack-room row without a transaction hash'));
  const withTx = fixture('a2/README.md', `${head}| Late bid | Refunded | ${tx} |\n| Seller withholds | no part | by construction |\n\n## Next\n`);
  assert.ok(!fails(runLint([withTx], { FREEZE: '1' }).out, 'attack-room row'));
});

test('CLM-01: README states sale 0 as a plan while its JUDGES row is pending, as done once it has a hash', () => {
  const m02 = judges().split('\n').find((l) => l.startsWith('| M02 |'));
  assert.ok(m02, 'JUDGES row M02');
  const done = /[1-9A-HJ-NP-Za-km-z]{43,44}/.test(m02);
  assert.match(readme(), done ? /Sale 0 was configured by us to fail its thresholds/ : /Sale 0 will be configured by us to fail its thresholds/);
});

// ---- facts in the docs match the code -------------------------------------------------------------------------------
const verifySale = read(repo, 'cli/src/lib/verify-sale.ts');
const checkNames = new Map([...verifySale.matchAll(/\badd\((\d+), '([a-z-]+)'/g)].map((m) => [Number(m[1]), m[2]]));

test('CLM-04: every check number in JUDGES.md carries the name verify-sale.ts gives it', () => {
  const refs = [...judges().matchAll(/#(\d+) `([a-z-]+)`/g)];
  assert.ok(refs.length >= 5, 'JUDGES.md must name the checks it points to');
  for (const [, n, name] of refs) assert.equal(checkNames.get(Number(n)), name, `check #${n}`);
  const bare = [...judges().matchAll(/#(\d+)\b(?! `)/g)].map((m) => m[1]);
  assert.deepEqual(bare, [], `unnamed check numbers: ${bare}`);
});

test('CLM-04: the seller-penalty claim points at the check whose PASS text says "0 to the seller"', () => {
  const row = judges().split('\n').find((l) => l.startsWith('| The penalty never goes to the seller'));
  assert.ok(row, 'penalty row');
  const n = Number(row.match(/#(\d+) `conservation`/)?.[1]);
  const line = verifySale.split('\n').find((l) => l.includes(`add(${n}, 'conservation', 'PASS'`));
  assert.match(line ?? '', /0 to the seller/);
});

test('CLM-04: every code pointer in JUDGES.md exists, and `fn` pointers name a real function', () => {
  const rows = judges().split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Claim') && !l.startsWith('|---'));
  for (const row of rows) {
    for (const m of row.matchAll(/`((?:contract|packages|cli|app)\/[A-Za-z0-9_./-]+)`(?: `([a-z_]+)`)?/g)) {
      const [, path, fn] = m;
      const p = join(repo, path);
      assert.ok(existsSync(p), `${path} exists`);
      if (fn) assert.match(readFileSync(p, 'utf8'), new RegExp(`\\bfn ${fn}\\b`), `fn ${fn} in ${path}`);
    }
  }
});

test('CLM-05: the prototype claim matches git history', () => {
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  if (git('rev-parse', '--git-dir').status !== 0) return;
  const core = ['ibe.mjs', 'pv.mjs', 'gen.mjs', 't.mjs', 'vec.json', 'live.json'];
  for (const f of core) {
    const commits = git('log', '--format=%h', '--', `prototype/${f}`).stdout.trim().split('\n').filter(Boolean);
    assert.equal(commits.length, 1, `prototype/${f} was edited after the first commit: ${commits}`);
    assert.match(readme(), new RegExp('`' + f.replace('.', '\\.') + '`'), `README names ${f} as unchanged`);
  }
  const later = ['s1-check.mjs', 's2-encrypt.mjs', 's2-decrypt.mjs', 's7-check.mjs', 'seal-golden.mjs'];
  for (const f of later) assert.match(readme(), new RegExp('`' + f.replace('.', '\\.') + '`'), `README lists the later file ${f}`);
  assert.doesNotMatch(readme(), /kept unchanged for reference/);
});

test('OPS-06: the README seal:try step gives the output before and after sale 2 opens, both real seal-try lines', () => {
  const sealTry = read(repo, 'cli/src/seal-try.ts');
  for (const text of [readme()]) {
    const step = text.split('\n').find((l) => l.includes('seal:try --sale 2'));
    assert.ok(step, 'seal:try step');
    assert.match(step, /2026-11-17T12:00:00Z/);
    for (const s of ['sealed: no key has been requested for sale 2 (key_requests = 0)', 'key released at block']) {
      assert.ok(step.includes(s), `step 5 shows ${s}`);
    }
    assert.ok(sealTry.includes('sealed: no key has been requested for sale ${saleId} (key_requests = 0)'));
    assert.ok(sealTry.includes('key released at block'));
  }
});

test('CI-06: the README explains the Node 18 failures', () => {
  const text = readme();
  assert.match(text, /Node 18 does not work/);
  assert.match(text, /pnpm\.cjs/);
  assert.match(text, /ERR_PNPM_UNSUPPORTED_ENGINE/);
});

test('CI-03: JUDGES row T1 says why verify prints FAIL #3 on the testnet copy', () => {
  const row = judges().split('\n').find((l) => l.startsWith('| T1 |')) ?? '';
  assert.match(row, /earlier, non-reproducible build/);
  assert.match(row, /`FAIL` on #3 `code-hash`.*22\/24 checks passed/);
});

test('CLM-11: JUDGES row T2 cites the multichain-signed bids on sales 4 and 6', () => {
  const row = judges().split('\n').find((l) => l.startsWith('| T2 |'));
  assert.ok(row);
  const hashes = [...row.matchAll(/txns\/([1-9A-HJ-NP-Za-km-z]{43,44})/g)].map((m) => m[1]);
  assert.equal(new Set(hashes).size, 4);
  assert.match(row, /raw_ed25519/);
  assert.match(row, /erc191/);
});

// ---- documented command output --------------------------------------------------------------------------------------
const hasPnpm = spawnSync('pnpm', ['-v'], { encoding: 'utf8' }).status === 0;
function stepLine(text, cmd) {
  return text.split('\n').find((l) => /^\d+\. \(offline\) /.test(l) && l.includes(`\`pnpm ${cmd}\``)) ?? '';
}
const seeStrings = (line) => [...(line.split(' - see ')[1] ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1]);
for (const cmd of ['demo:local', 'vectors']) {
  test(`CLM-07: offline step pnpm ${cmd} prints every string the README promises`, { skip: !hasPnpm }, () => {
    const r = spawnSync('pnpm', [cmd], { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    // CI forces colour; vitest then splits '4 passed (4)' with escape codes
    const out = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, '');
    for (const text of [readme()]) {
      const strings = seeStrings(stepLine(text, cmd));
      assert.ok(strings.length >= 1, `step pnpm ${cmd} names what to see`);
      for (const s of strings.filter((x) => !x.startsWith('pnpm '))) assert.ok(out.includes(s), `step pnpm ${cmd} output contains ${s}`);
    }
    if (cmd === 'demo:local') {
      const secs = Number(out.match(/done in ([\d.]+) s/)?.[1]);
      assert.ok(secs < 1, `demo:local took ${secs} s, README says under a second`);
      assert.match(readme(), /under a second/);
    }
  });
}

// ---- opt-in checks that need a full test run or the network ----------------------------------------------------------
test('CI-02: README test counts equal a clean run (COUNTS=1)', { skip: process.env.COUNTS !== '1' || !hasPnpm }, () => {
  const row = readme().split('\n').find((l) => l.startsWith('| Tests |')) ?? '';
  const dirs = { clearing: 'packages/clearing', intents: 'packages/intents', seal: 'packages/seal', relayer: 'relayer', app: 'app', cli: 'cli' };
  for (const [name, dir] of Object.entries(dirs)) {
    const claimed = Number(row.match(new RegExp(`${name} (\\d+)`))?.[1]);
    // LIVE=1 would turn on the live intents tests, which the README counts as skipped.
    const r = spawnSync('pnpm', ['test'], { cwd: join(repo, dir), encoding: 'utf8', env: { ...process.env, LIVE: '' } });
    const got = Number((r.stdout + r.stderr).match(/Tests\s+(?:\d+ failed \| )?(\d+) passed/)?.[1]);
    assert.equal(claimed, got, `${name}: README ${claimed}, run ${got}`);
  }
});

test('CLM-12: the meme.cooking numbers in the video script equal the API (LIVE=1)', { skip: process.env.LIVE !== '1' }, async () => {
  const memes = await (await fetch('https://api.meme.cooking/meme')).json();
  const n = (x) => x.toLocaleString('en-US');
  const withDeposit = memes.filter((m) => Number(m.total_deposit) > 0).length;
  const withPool = memes.filter((m) => m.pool_id !== null && m.pool_id !== undefined).length;
  const line = read(docs, 'video/script.md').split('\n').find((l) => l.includes('api.meme.cooking scan')) ?? '';
  assert.ok(line.includes(`${n(memes.length)} memes, ${withDeposit} with a deposit, ${withPool} with a pool`), `script row: ${line.slice(0, 400)}`);
  assert.ok(memes.every((m) => m.deposit_token_id === 'wrap.near'));
});

test('CLM-11: the cited testnet relay transactions exist (LIVE=1)', { skip: process.env.LIVE !== '1' }, async () => {
  const row = judges().split('\n').find((l) => l.startsWith('| T2 |')) ?? '';
  for (const [, hash] of row.matchAll(/txns\/([1-9A-HJ-NP-Za-km-z]{43,44})/g)) {
    const res = await (await fetch('https://test.rpc.fastnear.com', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tx', params: { tx_hash: hash, sender_account_id: 'relayer.tender-09bdfe.testnet', wait_until: 'FINAL' } }),
    })).json();
    assert.equal(res.result?.transaction?.receiver_id, 'intents-09bdfe.testnet', hash);
  }
});
