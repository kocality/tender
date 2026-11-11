// Regression tests for the judge-facing docs. Run: node --test docs/scripts/docs-checks.test.mjs
// Optional: DOCS_DIR=<dir with README.md, JUDGES.md, video/*> checks another copy of the docs against the repo's code;
// CLAIMS_LINT=<path> runs another copy of claims-lint.sh; COUNTS=1 re-runs the pnpm test suites and compares them with the README; LIVE=1 reads public testnet RPC and api.meme.cooking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
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
  // DOUBLE-PLAN "Never say": a confirmed second bid is allowed, the relayer only saves gas, another device can fund
  // twice, and a pending payout is never resent.
  ['DOUBLE double bids are allowed after a confirmation', 'With Tender, double bids are impossible.',
    'A second copy of one sealed bid is refunded in full.', 'impossible'],
  ['DOUBLE the relayer does not decide', 'The relayer prevents duplicates.',
    'The relayer skips a bid the chain already shows stored; the contract and intents.near decide.', 'relayer prevents'],
  ['DOUBLE another device can fund again', 'You can never pay 1Click twice.',
    'Another browser or device can pay 1Click again during an unclear outcome; the money stays yours.', '1Click twice'],
  ['DOUBLE a pending payout is never resent', 'A stuck payout is retried by the keeper.',
    'A pending payout is never resent; verify lists it.', 'retried'],
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

test('CLM-01: README states the demo sales as a plan while JUDGES row M02 is pending, and drops the plan once it has a hash', () => {
  const m02 = judges().split('\n').find((l) => l.startsWith('| M02 |'));
  assert.ok(m02, 'JUDGES row M02');
  const done = /[1-9A-HJ-NP-Za-km-z]{43,44}/.test(m02);
  assert.match(readme(), /configured by us to fail its thresholds/i);
  (done ? assert.doesNotMatch : assert.match)(readme(), /Planned on mainnet/);
});

// ---- the penalty pool wording -----------------------------------------------------------------------------------------
// CRYPTO-01: the 10% of an unrevealed bid stays in the contract's NEAR Intents balance and no Tender method pays it out,
// but intents.near's admin roles can move any Intents balance. So near "penalty" or "pool" (same or adjacent line) the
// docs and the UI may not say burned, forever, or that no one / no method can move it.
const PENALTY_BANNED = /\bburn(ed|s|t)?\b|\bforever\b|\bno (one|method) can move\b/i;
function penaltyWordingHits(text) {
  const lines = text.split('\n');
  const near = (i) => lines.slice(Math.max(0, i - 1), i + 2).some((l) => /penalt|pool/i.test(l));
  return lines.flatMap((l, i) => (PENALTY_BANNED.test(l) && near(i) ? [`${i + 1}: ${l.trim()}`] : []));
}
const walk = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => join(d.parentPath, d.name));

test('CRYPTO-01: near "penalty" or "pool", nothing says burned, forever, or that no one / no method can move it', () => {
  const old = "export const PENALTY_RULE =\n  \"The other 10% goes to nobody: it stays in the contract's NEAR Intents account, which no method can move.\";";
  assert.equal(penaltyWordingHits(old).length, 1, 'the old wording must fail (the trigger word is on the line above)');
  const good = "export const PENALTY_RULE =\n  \"The other 10% stays in the contract's NEAR Intents balance. No Tender method pays it to anyone. Like any Intents balance, intents.near's own admin roles could move it.\";";
  assert.deepEqual(penaltyWordingHits(good), [], 'the corrected wording must pass');
  const files = [join(docs, 'README.md'), join(repo, 'docs/protocol.md'), ...walk(join(repo, 'app/src')), ...walk(join(repo, 'cli/src'))];
  for (const f of files) assert.deepEqual(penaltyWordingHits(readFileSync(f, 'utf8')), [], f);
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

// ---- the RC3 contract and the docs that describe it ----------------------------------------------------------------
const readmeStep = (n) => readme().split('\n').find((l) => l.startsWith(`${n}. `)) ?? '';
const judgesRow = (id) => judges().split('\n').find((l) => l.startsWith(`| ${id} |`)) ?? '';

test('RC3-01: README testnet steps, JUDGES T3 and evidence/testnet.json name one copy that runs the step 9 wasm', () => {
  const wasm = JSON.parse(read(repo, 'evidence/wasm.json'));
  const rows = JSON.parse(read(repo, 'evidence/testnet.json'));
  const birth = rows.find((r) => r.step === 'birth');
  assert.ok(birth, 'evidence/testnet.json has a birth row');
  for (const n of [5, 6, 10]) assert.ok(readmeStep(n).includes(birth.contract), `README step ${n} names ${birth.contract}`);
  assert.ok(readmeStep(5).includes(`"code_hash":"${wasm.code_hash_b58}"`), 'README step 5 shows the step 9 wasm code hash');
  assert.ok(judgesRow('T3').includes(birth.tx_hash), 'JUDGES T3 cites the birth');
  for (const r of rows) assert.ok(judges().includes(r.tx_hash), `JUDGES cites ${r.step} ${r.tx_hash}`);
});

test('RPC-01: no doc names the deprecated near.org RPC, and docs/verify.md names the CLI defaults', () => {
  for (const p of ['README.md', 'JUDGES.md', 'docs/verify.md', 'docs/protocol.md']) {
    assert.doesNotMatch(read(p.startsWith('docs/') ? repo : docs, p), /https:\/\/rpc\.(mainnet|testnet)\.near\.org/, p);
  }
  const config = read(repo, 'cli/src/lib/config.ts');
  const hosts = [...config.matchAll(/^\s*rpc: \[([^\]]+)\]/gm)].flatMap((m) => [...m[1].matchAll(/https:\/\/([^'/]+)/g)].map((h) => h[1]));
  assert.ok(hosts.length >= 6, `CLI RPC lists: ${hosts}`);
  for (const h of hosts) assert.ok(read(repo, 'docs/verify.md').includes(h), `docs/verify.md names ${h}`);
});

test('CRYPTO-07: README and docs/protocol.md name the app key mode sales/v1-init.json sets', () => {
  const mode = JSON.parse(read(repo, 'sales/v1-init.json')).app_pk_mode;
  const mpcRow = readme().split('\n').find((l) => l.startsWith('| MPC Confidential Key Derivation |')) ?? '';
  assert.ok(mpcRow.includes(`\`${mode}\` mode`), `README MPC row: ${mpcRow}`);
  assert.ok(read(repo, 'docs/protocol.md').includes(`\`sales/v1-init.json\` sets \`${mode}\``), 'protocol.md App key mode');
});

test('DOUBLE-01: README says what a repeated bid does and what stays possible, with reasons the contract has', () => {
  const text = readme();
  const intents = read(repo, 'contract/src/intents.rs');
  for (const r of ['dup_bid', 'bid_seq']) {
    assert.ok(text.includes(`\`${r}\``), `README names ${r}`);
    assert.ok(intents.includes(`refund_bid("${r}"`), `contract refunds ${r}`);
  }
  const confirm = read(repo, 'app/src/pages/Bid.tsx').match(/This will be an additional bid\./)?.[0];
  assert.ok(confirm && read(repo, 'docs/protocol.md').includes(confirm), 'protocol.md quotes the named confirmation for a deliberate second bid');
  assert.match(text, /another browser or device/i, 'what stays possible');
});

test('KEY-01: README states the on_key key check, and protocol.md gives on_key the contract ON_KEY_GAS', () => {
  assert.match(readme(), /MPC key pinned/, 'README names the key check against the MPC key pinned at birth');
  const tgas = read(repo, 'contract/src/seal.rs').match(/ON_KEY_GAS: Gas = Gas::from_tgas\((\d+)\)/)?.[1];
  assert.ok(tgas);
  assert.match(read(repo, 'docs/protocol.md'), new RegExp(`\`on_key\` gets ${tgas} Tgas`));
});

test('X12A-04: docs/protocol.md quotes the withdraw page\'s own "not a wallet" message', () => {
  const msg = read(repo, 'app/src/lib/withdrawRoutes.ts').match(/const NOT_A_WALLET = '([^.]+\.)/)?.[1];
  assert.ok(msg, 'NOT_A_WALLET in withdrawRoutes.ts');
  assert.ok(read(repo, 'docs/protocol.md').includes(msg), `protocol.md quotes: ${msg}`);
});

// ---- one home per fact; the double-bid and key-check claims say exactly what the rows show ------------------------------
const protocol = () => read(repo, 'docs/protocol.md');
const prose = (text) => text.replace(/```mermaid[\s\S]*?```/g, ''); // a diagram may show what a sentence says
const docText = { 'README.md': () => prose(readme()), 'JUDGES.md': judges, 'docs/protocol.md': protocol, 'docs/verify.md': () => read(repo, 'docs/verify.md') };
const homes = [
  ['the RC3 testnet copy runs generator (home: JUDGES T3)', /(rc3\.tender|testnet copy|RC3 copy).*generator/i,
    { 'README.md': 0, 'JUDGES.md': 1, 'docs/protocol.md': 0 }],
  ['the app key mode v1 uses (home: protocol App key mode)', /`sales\/v1-init\.json` sets|mode v1 uses|v1 does not use/,
    { 'README.md': 0, 'JUDGES.md': 0, 'docs/protocol.md': 1 }],
  ['the 24 h cancel rule (home: protocol Sale states and Key request)', /24 h/, { 'README.md': 0 }],
  ['what dup_bid and bid_seq compare (home: protocol Repeated bids)', /already has stored|prepared before/,
    { 'README.md': 0, 'JUDGES.md': 0, 'docs/protocol.md': 1 }],
  ['the app\'s additional-bid confirmation (home: protocol)', /This will be an additional bid/,
    { 'README.md': 0, 'JUDGES.md': 0, 'docs/protocol.md': 1 }],
  ['the on_key key check in README (home: row 5)', /pairing check|answer checked/, { 'README.md': 1 }],
  ['one Intents nonce for every copy of a sealed bid (home: protocol Repeated bids)', /(same|one) (NEAR )?Intents nonce/,
    { 'README.md': 0, 'docs/protocol.md': 1 }],
  ['what an MPC key change does (home: protocol Changed MPC key)', /no v1 sale|fails the check in/, { 'README.md': 0 }],
  ['open can be retried after a failed answer (home: protocol Failed answer)', /`open` can be retried|call `open` again/,
    { 'docs/protocol.md': 1 }],
  ['what /relay answers (home: relayer/README.md)', /\b(409|202)\b/, { 'docs/protocol.md': 0 }],
  ['which file holds the testnet rows (home: evidence/README.md)', /evidence\/testnet\.json/, { 'docs/verify.md': 0 }],
];
for (const [fact, re, limits] of homes) {
  test(`ONE-HOME: ${fact}`, () => {
    for (const [file, max] of Object.entries(limits)) {
      const lines = docText[file]().split('\n').filter((l) => re.test(l));
      assert.ok(lines.length <= max, `${file} states it ${lines.length} times (at most ${max}):\n${lines.join('\n')}`);
    }
  });
}

test('DOUBLE-02: a run-once claim names our signers, and a stored-once claim names the sale', () => {
  // The contract never checks the nonce: a copy re-signed elsewhere with a new nonce runs and is refunded dup_bid.
  for (const [file, text] of [['README.md', readme()], ['JUDGES.md', judges()]]) {
    for (const l of text.split('\n').filter((x) => /at most once|at most one of them|cannot run|runs at most/.test(x))) {
      assert.match(l, /our app/i, `${file}: ${l}`);
    }
  }
  const row = judges().split('\n').find((l) => l.startsWith('| One sealed bid is stored at most once')) ?? '';
  assert.match(row, /per account in a sale/, row);
  // The app pins a new Intents salt, and so a new nonce, when the salt was invalidated before the first send.
  if (read(repo, 'app/src/pages/Bid.tsx').includes("sim.kind === 'invalid_salt'")) {
    assert.match(protocol(), /new nonce only when the Intents salt was invalidated before the bid was first sent/, 'protocol.md names the salt exception');
  }
});

test('DOUBLE-03: the README Double bids limit lists only what rows 3-4 do not stop, in words the README defines', () => {
  const bullet = readme().split('\n').find((l) => l.startsWith('- **Double bids.**')) ?? '';
  assert.ok(bullet, 'README Limits has a Double bids bullet');
  assert.doesNotMatch(bullet, /never runs/, 'restates rows 3-4 (and reads as "neither runs nor is refunded")');
  assert.ok(bullet.includes('(docs/protocol.md#bids-the-contract-refunds)'), 'links the app behaviour in protocol.md');
  assert.doesNotMatch(readme(), /`seq`/, 'README never introduces the `seq` field');
});

test('KEY-02: the key-check claim row names the sandbox test in which on_key refuses a wrong key', () => {
  const row = judges().split('\n').find((l) => l.includes('pairing check against the pinned MPC key')) ?? '';
  const sandbox = read(repo, 'contract/tests/sandbox.rs');
  const named = [...row.matchAll(/`(\w+)`/g)].map((m) => m[1]).filter((n) => sandbox.includes(`async fn ${n}(`));
  assert.equal(named.length, 1, `claim row: ${row}`);
  const body = sandbox.slice(sandbox.indexOf(`async fn ${named[0]}(`)).split('\n#[tokio::test]')[0];
  assert.match(body, /key does not match mpc_public_key/, `${named[0]} asserts the refusal`);
});

test('KEY-03: every JUDGES row marked identity mode names a generator-mode proof of what that row shows', () => {
  const marked = judges().split('\n').filter((l) => /\(identity mode/.test(l));
  assert.ok(marked.length > 0);
  for (const l of marked) {
    const id = l.match(/generator mode: (T\d+)/)?.[1];
    assert.ok(id ? judgesRow(id) : /generator mode: step 10, check #12/.test(l), l);
  }
  // T8 is the reveal, which checks commitments, not decryption; the decrypt proof is step 10's check #12.
  assert.match(judgesRow('S2'), /generator mode: step 10, check #12 `ciphertexts-decrypt`/, judgesRow('S2'));
  const out = readdirSync(join(repo, 'evidence/verify')).filter((f) => f.startsWith('testnet-rc3.')).map((f) => read(repo, `evidence/verify/${f}`))
    .find((t) => t.includes(readmeStep(10).match(/see `([^`]+)`/)[1]));
  assert.match(out ?? '', /PASS #12 ciphertexts-decrypt — 2\/2 decrypt/, 'a saved step 10 output shows check #12 decrypting');
  // T7 records only a key accepted; no generator-mode wrong-app_id rejection is on chain.
  assert.match(judgesRow('S6-ckd'), /contract-initiated CKD in generator mode: T7/, judgesRow('S6-ckd'));
  assert.doesNotMatch(judgesRow('T7'), /reject|wrong/, judgesRow('T7'));
});

test('DOCS-NIT: no internal ticket IDs in the judge docs; step 10 says what T3-T11 cover; JUDGES lists every tx-row file', () => {
  for (const [file, f] of Object.entries(docText)) assert.doesNotMatch(f(), /\b(CRYPTO|X12[A-Z]|OPS|CLM)-\d+/, file);
  assert.match(readmeStep(10), /That copy and its sale: \[rows T3-T11\]/, readmeStep(10));
  const line = judges().split('\n').find((l) => l.startsWith('Raw RPC responses')) ?? '';
  const files = readdirSync(join(repo, 'evidence')).filter((f) => f.endsWith('.json') && /"tx_hash(es)?"/.test(read(repo, `evidence/${f}`)));
  assert.ok(files.length >= 3, `${files}`);
  for (const f of files) assert.ok(line.includes(`\`evidence/${f}\``), `JUDGES names evidence/${f}`);
});

test('WITHDRAW-01: no doc says withdrawals go to wallets only; the page refuses a fixed list', () => {
  for (const [file, f] of Object.entries(docText)) {
    assert.doesNotMatch(f(), /wallet address only|only to a wallet|refuses an address that is not a wallet/i, file);
  }
  const row9 = readme().split('\n').find((l) => l.startsWith('| 9 |')) ?? '';
  assert.match(row9, /refuses known non-wallet addresses/, row9);
  assert.match(protocol(), /Any other address passes/, 'protocol.md says what still passes');
});

test('DOUBLE-04: the run-once claim covers only paths that sign one nonce, and T10 says the contract decided', () => {
  const claim = judges().split('\n').find((l) => l.startsWith('| One sealed bid is stored at most once')) ?? '';
  assert.doesNotMatch(claim, /\bscripts\b|\bCLI\b/, `claim names the signing paths: ${claim}`);
  assert.match(claim, /before close/, claim);
  for (const [file, text] of [['README.md', readme()], ['JUDGES.md', judges()], ['docs/protocol.md', protocol()]]) {
    assert.doesNotMatch(text, /(app|CLI),? (CLI )?and (the )?scripts/, file);
  }
  // The bid script signs a random nonce with --late, and the rehearsal bids by direct mt_transfer_call.
  if (/closeNs === undefined\s*\?\s*buildVersionedNonce/.test(read(repo, 'relayer/scripts/bid-nep413.ts'))) {
    assert.match(protocol(), /`bid-nep413\.ts --late`, a random nonce/, 'protocol.md names the --late exception');
  }
  if (/mt_transfer_call/.test(read(repo, 'contract/scripts/testnet-rehearsal.sh'))) {
    assert.match(protocol(), /direct `mt_transfer_call` \(`contract\/scripts\/testnet-rehearsal\.sh`/, 'protocol.md names the direct-transfer exception');
  }
  assert.match(protocol(), /once one has run, a second signature of it fails as `nonce_used`/);
  const t10 = JSON.parse(read(repo, 'evidence/testnet.json')).find((r) => r.reason === 'dup_bid');
  assert.ok(t10 && judgesRow('T10').includes(t10.tx_hash));
  assert.match(judgesRow('T10'), /direct `mt_transfer_call`, which carries no Intents nonce, so the contract decides/, judgesRow('T10'));
});

test('README-READ: step 10 says its sale 0 is not the twin; README defines what it names', () => {
  const t9 = judgesRow('T9').match(/P\* (\d+\.\d+)/)?.[1];
  assert.ok(t9 && readmeStep(10).includes(`clears at ${t9}, not the story's twin`), readmeStep(10));
  assert.doesNotMatch(readme(), /at birth/, '"birth" is never defined for a judge');
  const bullet = readme().split('\n').find((l) => l.startsWith('- **Double bids.**')) ?? '';
  assert.doesNotMatch(bullet, /bid count/, 'the README never defines a bid count');
  assert.match(bullet, /one of the two bids is refunded \(`bid_seq`\)/, 'the first copy can be the one refunded');
});

test('ONE-HOME: the contract skips pending payouts, stated once across protocol.md and relayer/README.md', () => {
  const lines = [protocol(), read(repo, 'relayer/README.md')].flatMap((t) => t.split('\n')).filter((l) => /`pending`/.test(l) && /twice/.test(l));
  assert.equal(lines.length, 1, lines.join('\n'));
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
    const got = Number((r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, '').match(/Tests\s+(?:\d+ failed \| )?(\d+) passed/)?.[1]);
    assert.equal(claimed, got, `${name}: README ${claimed}, run ${got}`);
  }
});

test('CI-02: docs/verify.md node --test counts equal a run (COUNTS=1)', { skip: process.env.COUNTS !== '1' }, () => {
  const line = read(repo, 'docs/verify.md').split('\n').find((l) => l.includes('`node --test` suites')) ?? '';
  const files = {
    'docs-checks': 'docs/scripts/docs-checks.test.mjs', 'ci-config': '.github/workflows/ci-config.test.mjs',
    'check-imports': 'contract/scripts/check-imports.test.mjs', 'm3-reveal-items': 'contract/scripts/m3-reveal-items.test.mjs',
    'testnet-rehearsal': 'contract/scripts/testnet-rehearsal.test.mjs',
  };
  for (const [name, file] of Object.entries(files)) {
    const claimed = Number(line.match(new RegExp(`${name} (\\d+)`))?.[1]);
    // COUNTS and LIVE off: the opt-in checks are counted apart ("+3 opt-in"), and this one must not run itself again.
    const { NODE_TEST_CONTEXT, ...env } = process.env; // set by the outer runner; the inner one would then report in its binary format
    const r = spawnSync('node', ['--test', file], { cwd: repo, encoding: 'utf8', env: { ...env, COUNTS: '', LIVE: '' } });
    const got = Number(r.stdout.replace(/\x1b\[[0-9;]*m/g, '').match(/^ℹ pass (\d+)/m)?.[1]);
    assert.equal(claimed, got, `${name}: docs/verify.md ${claimed}, run ${got}`);
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
