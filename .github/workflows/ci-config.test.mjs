// Guards for the CI, lockfile and install settings that no other test reads. Run: node --test .github/workflows/ci-config.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
const workflows = { "ci.yml": read(".github/workflows/ci.yml"), "keeper.yml": read(".github/workflows/keeper.yml"), "watch.yml": read(".github/workflows/watch.yml") };
const ci = workflows["ci.yml"];
const job = (name) => {
  const m = ci.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  \\w[\\w-]*:\\n|(?![\\s\\S]))`, "m"));
  assert.ok(m, `ci.yml has no job ${name}`);
  return m[1];
};
const versions = (lock, name) => [...lock.matchAll(new RegExp(`^  '?${name}@(\\d+)\\.(\\d+)\\.(\\d+)`, "gm"))].map((m) => m.slice(1).map(Number));
const atLeast = (v, min) => v[0] !== min[0] ? v[0] > min[0] : v[1] !== min[1] ? v[1] > min[1] : v[2] >= min[2];

test("X12-01: the lockfile has no vite in GHSA-p4f5-76q4-ffq7's range (8.3.0 to 8.3.6) and a rolldown from the fixed vite", () => {
  const lock = read("pnpm-lock.yaml");
  const vite = versions(lock, "vite");
  assert.ok(vite.length > 0, "no vite in the lockfile");
  for (const v of vite) assert.ok(!(v[0] === 8 && v[1] === 3 && v[2] <= 6), `vulnerable vite ${v.join(".")} in pnpm-lock.yaml`);
  const rolldown = versions(lock, "rolldown");
  assert.ok(rolldown.length > 0);
  for (const v of rolldown) assert.ok(atLeast(v, [1, 2, 17]), `rolldown ${v.join(".")} predates the vite 8.3.7 fix`);
});

test("CI-06, X12-04, CI-09: every action in every workflow is pinned to a commit SHA", () => {
  for (const [file, text] of Object.entries(workflows)) {
    const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
    assert.ok(uses.length > 0, file);
    for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${file}: ${u}`);
  }
});

test("X12-05, CI-09: nothing downloaded in a workflow is piped into a shell or tar, and every curl -o file is checked with sha256sum -c", () => {
  for (const [file, text] of Object.entries(workflows)) {
    assert.doesNotMatch(text, /curl[^\n]*\|\s*(sh|bash|tar)\b/, `${file}: curl piped into a shell or tar`);
    for (const m of text.matchAll(/curl[^\n]*?-o\s+(\S+)/g)) {
      const name = m[1];
      assert.match(text, new RegExp(`'[0-9a-f]{64}  ${name.replace(/\./g, "\\.")}' \\| sha256sum -c -`), `${file}: ${name} is not checked against a sha256`);
    }
  }
});

test("X12-07: CI runs the sandbox tests with a sha256-pinned near-sandbox binary", () => {
  const rust = job("rust");
  assert.match(rust, /near-sandbox\.tar\.gz/);
  assert.match(rust, /NEAR_SANDBOX_BIN_PATH=/);
  assert.ok(rust.indexOf("NEAR_SANDBOX_BIN_PATH=") < rust.indexOf("cargo test"), "the binary must be in place before the first cargo test");
});

test("X12-05: cargo test runs with --locked", () => {
  for (const m of ci.matchAll(/run:\s*(cargo test\b[^\n]*)/g)) assert.match(m[1], /--locked/, m[1]);
  assert.ok([...ci.matchAll(/run:\s*cargo test\b/g)].length >= 2);
});

test("CI-04: the ts and rust jobs run the deploy-time checks", () => {
  const ts = job("ts");
  for (const c of ["pnpm -r exec tsc --noEmit", "pnpm --filter @tender/app build", "node --test contract/scripts/check-imports.test.mjs", "pnpm -r test"]) assert.ok(ts.includes(c), `ts job lacks: ${c}`);
  const rust = job("rust");
  for (const c of ["cargo fmt --check", "sha256sum -c tender.wasm.sha256", "node contract/scripts/check-imports.mjs contract/res/tender.wasm", "git diff --exit-code", "contract/rust-toolchain.toml", "TENDER_WASM: res/tender.wasm"]) assert.ok(rust.includes(c), `rust job lacks: ${c}`);
});

test("X12-09: CI scans npm and cargo advisories", () => {
  assert.ok(job("ts").includes("pnpm audit --prod --audit-level high"));
  assert.match(job("rust"), /cargo-deny[^\n]*check advisories/);
});

test("handoff WS3 to WS0: the payload oracle and the docs checks run in CI", () => {
  assert.ok(job("oracle").includes("ORACLE=1 pnpm --filter @tender/app test"));
  const ts = job("ts");
  assert.ok(ts.includes("bash docs/scripts/claims-lint.sh"));
  assert.ok(ts.includes("node --test docs/scripts/docs-checks.test.mjs"));
  assert.ok(ts.includes("node --test .github/workflows/ci-config.test.mjs"));
});

test("CI-05: the packages with pairing-heavy tests raise vitest's 5 s default timeout", () => {
  for (const pkg of ["cli", "packages/seal"]) {
    const script = JSON.parse(read(`${pkg}/package.json`)).scripts.test;
    const ms = Number(script.match(/--testTimeout=(\d+)/)?.[1] ?? 5000);
    assert.ok(ms >= 30000, `${pkg}: test script "${script}"`);
  }
});

test("CI-06: pnpm-workspace.yaml makes engines binding, and pnpm 12 honours that key", (t) => {
  const line = read("pnpm-workspace.yaml").match(/^engineStrict:.*$/m)?.[0];
  assert.equal(line, "engineStrict: true");
  const dir = mkdtempSync(join(tmpdir(), "tender-engine-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "engine-probe", version: "0.0.0", private: true, packageManager: "pnpm@12.18.0", engines: { node: ">=999.0.0" } }));
  writeFileSync(join(dir, "pnpm-workspace.yaml"), `packages: []\n${line}\n`);
  const env = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", CI: "1" };
  const probe = spawnSync("pnpm", ["--version"], { cwd: dir, env, encoding: "utf8" });
  if (probe.status !== 0) return t.skip("pnpm is not available");
  const r = spawnSync("pnpm", ["install", "--offline", "--ignore-scripts"], { cwd: dir, env, encoding: "utf8" });
  assert.notEqual(r.status, 0, "an unsupported Node must fail the install");
  assert.match(r.stdout + r.stderr, /ERR_PNPM_UNSUPPORTED_ENGINE/);
});

test(".env.example documents the variables the relayer and the app read", () => {
  const doc = new Set([...read(".env.example").matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
  const need = [
    "RELAY_ALLOWED_ORIGINS", "RELAY_HOST", "RELAY_PORT", "RELAY_ALLOW_FULL_ACCESS", "RELAYER_PUBLIC_KEY", "KEEPER_PUBLIC_KEY", "NEAR_CREDENTIALS_DIR", "TENDER_NETWORK",
    "TENDER_BIDDER_ACCOUNT_ID", "TENDER_SPIKE_ACCOUNT_ID", "VITE_TEAM_ACCOUNTS", "VITE_DEMO_FAIL_SALES", "VITE_NETWORK", "VITE_NEAR_RPC_FALLBACKS", "VITE_MPC_CONTRACT_ID",
    "VITE_TRY_RECEIVER", "VITE_NEARBLOCKS_API_URL", "VITE_EXPLORER_URL",
  ];
  for (const n of need) assert.ok(doc.has(n), `.env.example lacks ${n}`);
});
