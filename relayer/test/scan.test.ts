import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCAN = new URL("../scripts/scan.sh", import.meta.url).pathname;

describe("scan.sh (CI-08)", () => {
  it("outside a git repository it fails and never reports a clean scan", () => {
    const dir = mkdtempSync(join(tmpdir(), "scan-"));
    mkdirSync(join(dir, "relayer", "scripts"), { recursive: true });
    copyFileSync(SCAN, join(dir, "relayer", "scripts", "scan.sh"));
    // a gitleaks that finds nothing, as the real one does when it is pointed at a folder that is not a repository
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "gitleaks"), '#!/bin/sh\n[ "$1" = version ] && echo 8.30.1\nexit 0\n');
    chmodSync(join(dir, "bin", "gitleaks"), 0o755);
    const r = spawnSync("bash", [join(dir, "relayer", "scripts", "scan.sh")], {
      cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, GIT_CEILING_DIRECTORIES: tmpdir() },
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("no leaks found");
    expect(r.stderr).toMatch(/not a git repository/);
  });
});
