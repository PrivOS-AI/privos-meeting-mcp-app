#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

allow_dirty=false
if [[ "${1:-}" == "--allow-dirty" ]]; then
  allow_dirty=true
elif [[ $# -gt 0 ]]; then
  echo "Usage: npm run package -- [--allow-dirty]" >&2
  exit 2
fi

if [[ "$allow_dirty" != true ]] && [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
  echo "Refusing to package a dirty tree. Commit intended source files, or inspect them and use --allow-dirty." >&2
  exit 1
fi

# `privos-standalone-identity.json` is the SDK's standalone pairing identity —
# as sensitive as a credentials file, so it gets the same explicit guard.
unsafe_worktree="$(find . -path './.git' -prune -o -path './node_modules' -prune -o -path './dist-source' -prune -o \
  -type f \( -name '.env.*' -o -name '*.pem' -o -name '*.key' -o -name 'id_rsa*' -o -iname '*credentials*' -o -name 'privos-standalone-identity.json' \) \
  ! -name '.env.example' -print)"
if [[ -n "$unsafe_worktree" ]]; then
  echo "Unsafe credential-like files are present in the working tree. Move or remove them before packaging:" >&2
  printf '%s\n' "$unsafe_worktree" >&2
  exit 1
fi

name="$(node -p "require('./package.json').name")"
version="$(node -p "require('./package.json').version")"
safe_name="${name//\//-}"
output_dir="dist-source"
archive="$output_dir/$safe_name-$version.zip"
mkdir -p "$output_dir"

if [[ "$allow_dirty" == true ]]; then
  temp_index_dir="$(mktemp -d)"
  trap 'rm -rf "$temp_index_dir"' EXIT
  GIT_INDEX_FILE="$temp_index_dir/index" git read-tree HEAD
  GIT_INDEX_FILE="$temp_index_dir/index" git add --all
  source_tree="$(GIT_INDEX_FILE="$temp_index_dir/index" git write-tree)"
  git archive --format=zip --output="$archive" "$source_tree"
else
  git archive --format=zip --output="$archive" HEAD
fi

contents="$(unzip -Z1 "$archive")"

for required in privos-app.json; do
  if ! printf '%s\n' "$contents" | grep -qx "$required"; then
    echo "Archive is missing required root entry: $required" >&2
    rm -f "$archive"
    exit 1
  fi
done

bad_entries="$(printf '%s\n' "$contents" | awk '
  /(^|\/)node_modules(\/|$)|(^|\/)dist(\/|$)|(^|\/)dist-source(\/|$)|(^|\/)\.recyclebin(\/|$)|(^|\/)models(\/|$)|(^|\/)data(\/|$)/ { print; next }
  /(^|\/)\.env/ { print; next }
  /\.\./ { print; next }
  /(^|\/)id_rsa/ || /\.pem$/ || /\.key$/ || tolower($0) ~ /credentials/ { print; next }
  /(^|\/)privos-standalone-identity\.json$/ { print }
')"
if [[ -n "$bad_entries" ]]; then
  echo "Unsafe files found in source archive:" >&2
  printf '%s\n' "$bad_entries" >&2
  rm -f "$archive"
  exit 1
fi

size="$(wc -c < "$archive")"
sha256sum "$archive" > "$archive.sha256"
echo "Created $archive ($size bytes)"
cat "$archive.sha256"
