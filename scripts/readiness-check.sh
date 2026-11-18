#!/usr/bin/env bash
# Runs every marketplace gate locally, in the order the Portal and build node run them.
# Usage: bash readiness-check.sh <path-to-app-repo> [--docker]
#   --docker  also builds the image and runs the build node's served-manifest probe
#             (read-only root FS, no env, 30 s). Takes minutes: run it under nohup, e.g.
#             nohup bash readiness-check.sh <repo> --docker > readiness.log 2>&1 &
# Exit 0 = every blocking gate passed. WARN lines do not fail the run.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "${1:?usage: readiness-check.sh <app-repo> [--docker]}" && pwd)"
DOCKER="${2:-}"
cd "$APP"
export NODE_ENV=development
fails=0; pass() { echo "PASS  $*"; }; fail() { echo "FAIL  $*"; fails=$((fails+1)); }; warn() { echo "WARN  $*"; }
json() { node -e "const m=require('./$1');const v=($2);process.stdout.write(v===undefined||v===null?'':String(v))"; }

echo "== $(basename "$APP") @ $(git branch --show-current) $(git log -1 --format='%h %cs')"

# 1. Source state — a stale or dirty tree invalidates every result below.
git fetch -q origin 2>/dev/null
[ -z "$(git status --porcelain --untracked-files=all)" ] && pass "clean tree" || fail "dirty tree (package + publish refuse it)"
if behind=$(git rev-list --count HEAD..@{u} 2>/dev/null); then
  [ "$behind" = "0" ] && pass "up to date with upstream" || fail "behind upstream by $behind commit(s) — pull first"
else
  warn "no upstream tracking branch — cannot tell if this is the newest code (git branch -u origin/<branch>)"
fi

# 2. Manifest — schema v3 + permission catalog (what the Portal rejects at upload).
if [ -f privos-app.json ]; then
  out=$(node "$HERE/manifest-precheck.mjs" privos-app.json) && pass "manifest precheck" || { fail "manifest precheck:"; echo "$out" | sed 's/^/        /'; }
else
  fail "no privos-app.json at repo root"
fi

# 3. Identity sync — MANIFEST_IDENTITY_MISMATCH at publish otherwise.
if [ -f privos-app.json ] && [ -f package.json ]; then
  [ "$(json privos-app.json m.version)" = "$(json package.json m.version)" ] && pass "version synced ($(json package.json m.version))" \
    || fail "version: privos-app.json $(json privos-app.json m.version) ≠ package.json $(json package.json m.version)"
  [ "$(json privos-app.json m.name)" = "$(json package.json m.name)" ] && pass "name synced" \
    || warn "name: privos-app.json $(json privos-app.json m.name) ≠ package.json $(json package.json m.name)"
  [ -n "$(json package.json 'm.scopes&&1')" ] && warn "package.json still carries a legacy \"scopes\" array — delete it; privos-app.json permissions are the truth"
fi

# 4. Lockfile — the build node runs npm ci.
if [ -f package-lock.json ]; then
  pass "package-lock.json committed"
  grep -qE '"resolved": "file:|"link": true' package-lock.json && fail "package-lock.json has file:/link entries (vendored SDK?) — the build node cannot resolve them"
else
  fail "no package-lock.json (build node runs npm ci → PREFLIGHT_FAILED build_failed)"
fi

# 5. Archive — exactly what git archive (package-source.sh / privos-app publish) uploads.
tmp="$(mktemp -d)"; zip="$tmp/archive.zip"; git archive --format=zip -o "$zip" HEAD
entries=$(unzip -Z1 "$zip"); size=$(wc -c < "$zip" | tr -d ' ')
denied=$(echo "$entries" | grep -E '(^|/)\.git(/|$)|(^|/)\.env(\.|$)|(^|/)\.privos/skills(/|$)|(^|/)node_modules(/|$)|(^|/)\.\.(/|$)' || true)
[ -z "$denied" ] && pass "no denied paths in archive" || { fail "denied paths in archive (Portal 400 denied_path) — add export-ignore to .gitattributes:"; echo "$denied" | sed 's/^/        /'; }
echo "$entries" | grep -qx privos-app.json && pass "privos-app.json at archive root" || fail "privos-app.json missing from archive root"
if [ "$(json privos-app.json m.executionMode 2>/dev/null)" != "INSTANT" ]; then
  echo "$entries" | grep -qx Dockerfile && pass "Dockerfile at archive root" || fail "Dockerfile missing from archive root (dockerfile_missing)"
fi
[ "$size" -le $((200*1024*1024)) ] && pass "archive $((size/1024)) KB (≤ 200 MB)" || fail "archive > 200 MB"
junk=$(echo "$entries" | grep -E '^(dist|dist-source|public/ui|data|runtime)/|(^|/)uploads/' | head -5 || true)
[ -n "$junk" ] && warn "built output / runtime data tracked in git (ships in the archive):" && echo "$junk" | sed 's/^/        /'
rm -rf "$tmp"

# 6. Dependencies — the source scan fails on HIGH/CRITICAL.
npm ci --no-audit --no-fund >/dev/null 2>&1 && pass "npm ci" || fail "npm ci failed"
# Portal passed HRM 1.2.6 (SCAN_PASSED, HIGH 0) with HIGH advisories present only in devDependencies,
# so production deps are the gate and dev-only findings are a warning.
# Always the public registry: a mirror without the advisory endpoint (e.g. npmmirror) fails every audit.
audit="npm audit --registry=https://registry.npmjs.org"
if $audit --omit=dev --audit-level=high >/dev/null 2>&1; then
  pass "npm audit (production deps): no HIGH/CRITICAL"
  $audit --audit-level=high >/dev/null 2>&1 || warn "npm audit: HIGH/CRITICAL in devDependencies only (not gating today; run: npm audit)"
else
  fail "npm audit --omit=dev: HIGH/CRITICAL in production deps → SCAN_FAILED (fix: npm audit fix / overrides, commit lockfile):"
  $audit --omit=dev --json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{for(const [n,v] of Object.entries(JSON.parse(d).vulnerabilities||{}))if(["high","critical"].includes(v.severity))console.log("        "+v.severity+" "+n)})'
fi

# 7. Build — the build node's ui-build stage runs npm run build, then bundle-ui on ui.distDir.
npm run build >/dev/null 2>&1 && pass "npm run build" || fail "npm run build failed"
has_ui=$(json privos-app.json "(m.tools||[]).some(t=>t.ui&&t.ui.resourceUri)||!!m.ui" 2>/dev/null)
if [ "$has_ui" = "true" ]; then
  dist=$(json privos-app.json "(m.ui&&m.ui.distDir)||'dist'")
  [ -n "$(json privos-app.json 'm.ui&&m.ui.distDir')" ] || warn "ui.distDir not set — bundle-ui will read ./dist"
  grep -lqsE 'inlineDynamicImports:\s*true|codeSplitting:\s*false' vite.config.* ui/vite.config.* 2>/dev/null && warn "vite forces a single chunk (inlineDynamicImports/codeSplitting:false) — breaks the 2 MB/asset limit once the UI grows"
  out=$(npx --yes -p @privos_ai/app-server@0.12.0 privos-app bundle-ui --check --dist "$dist" 2>&1)
  echo "$out" | grep -q '"ok": true' && pass "bundle-ui --check (build node's pinned 0.12.0) on $dist — largest $(echo "$out" | grep -oE '"size": [0-9]+' | awk '{print $2}' | sort -rn | head -1) B" \
    || { fail "bundle-ui --check on $dist (does npm run build write the UI there?):"; { echo "$out" | grep -iE 'error|exceeds|missing|invalid|no such' || echo "$out" | tail -3; } | head -5 | sed 's/^/        /'; }
fi

# 8. Dockerfile hygiene (warnings: not gates, but the image scan / runtime policy bite later).
if [ -f Dockerfile ]; then
  grep -qE '^USER\s+node' Dockerfile || warn "Dockerfile runtime stage does not switch to USER node"
  grep -qE 'apk .*upgrade|apt-get .*upgrade' Dockerfile || warn "Dockerfile does not patch base-image OS packages (IMAGE_SCAN_FAILED risk)"
fi

# 9. Served-manifest probe — build node: no env, read-only root FS, 30 s.
if [ "$DOCKER" = "--docker" ]; then
  tag="readiness-probe-$(basename "$APP" | tr 'A-Z' 'a-z'):local"
  if docker build -q -t "$tag" . >/dev/null 2>&1; then
    cid=$(docker run -d --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
      --memory 1g --cpus 1 --pids-limit 256 --tmpfs /tmp:rw,noexec,nosuid,size=64m \
      -p 127.0.0.1::$(json privos-app.json 'm.port||3000') "$tag")
    hostport=$(docker port "$cid" | head -1 | awk -F: '{print $NF}')
    ok=""; for i in $(seq 1 30); do curl -fsS "http://127.0.0.1:$hostport/.well-known/mcp/manifest.json" >/dev/null 2>&1 && { ok=$i; break; }; sleep 1; done
    [ -n "$ok" ] && pass "served-manifest probe: manifest after ${ok}s" || { fail "served-manifest probe: no manifest in 30 s (runtime_manifest_unavailable). Container log:"; docker logs "$cid" 2>&1 | tail -8 | sed 's/^/        /'; }
    docker rm -f "$cid" >/dev/null 2>&1; docker rmi "$tag" >/dev/null 2>&1
  else
    fail "docker build failed"
  fi
fi

echo "== $( [ $fails -eq 0 ] && echo READY || echo "NOT READY: $fails blocking failure(s)" )"
exit $(( fails > 0 ))
