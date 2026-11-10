#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel) # outside a git repository this fails and set -e stops the script
cd "$root"
if command -v gitleaks >/dev/null && gitleaks version | grep -q '8.30.1'; then G=(gitleaks)
else G=(docker run --rm -v "$PWD:/repo" -w /repo ghcr.io/gitleaks/gitleaks:v8.30.1); fi
"${G[@]}" git --redact -v --config .gitleaks.toml --log-opts="--all" .
log=$(git log --all --name-only --format=)
bad=$(printf '%s\n' "$log" | sort -u \
  | grep -E '(^|/)(\.env(\..+)?$|DECISIONS\.md$|PLAN[^/]*\.md$|[K]ICKOFF[^/]*\.md$|submission/|docs/[i]nternal/|tasks/|id\.json$|[^/]*credentials[^/]*|[^/]*keypair[^/]*\.json$)' \
  | grep -v -E '(^|/)\.env\.example$' || true)
[ -z "$bad" ] || { echo "FORBIDDEN PATHS IN HISTORY:"; echo "$bad"; exit 1; }
echo "scan: no leaks found · no forbidden paths in history"
