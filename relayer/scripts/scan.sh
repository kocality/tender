#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
if command -v gitleaks >/dev/null && gitleaks version | grep -q '8.30.1'; then G=(gitleaks)
else G=(docker run --rm -v "$PWD:/repo" -w /repo ghcr.io/gitleaks/gitleaks:v8.30.1); fi
"${G[@]}" git --redact -v --config .gitleaks.toml --log-opts="--all" .
bad=$(git log --all --name-only --format= | sort -u \
  | grep -E '(^|/)(\.env(\..+)?$|DECISIONS\.md$|PLAN[^/]*\.md$|KICKOFF[^/]*\.md$|submission/|docs/internal/|tasks/|id\.json$|[^/]*credentials[^/]*|[^/]*keypair[^/]*\.json$)' \
  | grep -v -E '(^|/)\.env\.example$' || true)
[ -z "$bad" ] || { echo "FORBIDDEN PATHS IN HISTORY:"; echo "$bad"; exit 1; }
echo "scan: no leaks found · no forbidden paths in history"
