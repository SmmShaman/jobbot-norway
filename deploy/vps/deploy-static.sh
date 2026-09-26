#!/usr/bin/env bash
# Pull the newest successful build artifact of a static site from GitHub Actions
# and switch /opt/static-sites/<host>/current to it (served by the static-sites
# nginx container). A release that fails the health check is marked .bad.
# Usage: deploy-static.sh <owner/repo> <workflow file> <artifact name> <host>
set -euo pipefail

REPO=$1 WORKFLOW=$2 ARTIFACT=$3 HOST=$4
BASE=/opt/static-sites/$HOST
PAT=$(grep -oE 'ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+' /home/stuar/.git-credentials | head -1)

api() {
  curl -fsSL -H "Authorization: Bearer $PAT" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$REPO/$1"
}

runs=$(api "actions/workflows/$WORKFLOW/runs?branch=main&status=success&per_page=1")
sha=$(jq -r '.workflow_runs[0].head_sha // empty' <<<"$runs")
run_id=$(jq -r '.workflow_runs[0].id // empty' <<<"$runs")
[ -n "$sha" ] || exit 0

current=$(basename "$(readlink "$BASE/current" 2>/dev/null || echo none)")
[ "$current" = "$sha" ] && exit 0
[ -e "$BASE/releases/$sha.bad" ] && exit 0

url=$(api "actions/runs/$run_id/artifacts" \
  | jq -r --arg n "$ARTIFACT" '.artifacts[] | select(.name == $n and .expired == false) | .archive_download_url' | head -1)
[ -n "$url" ] || { echo "no artifact for $sha"; exit 0; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -H "Authorization: Bearer $PAT" -o "$tmp/artifact.zip" "$url"
unzip -q "$tmp/artifact.zip" -d "$tmp"

rm -rf "$BASE/releases/$sha"
mkdir -p "$BASE/releases/$sha"
tar -xzf "$tmp/site.tar.gz" -C "$BASE/releases/$sha"
chmod -R a+rX "$BASE/releases/$sha"

previous=$(readlink "$BASE/current" 2>/dev/null || true)
# Relative link: the nginx container mounts /opt/static-sites at another path
switch_to() { ln -sfn "$1" "$BASE/current.new" && mv -T "$BASE/current.new" "$BASE/current"; }
switch_to "releases/$sha"

if ! curl -fs -o /dev/null -H "Host: $HOST" http://127.0.0.1:3200/; then
  echo "health check failed for $sha, rolling back to ${previous:-nothing}"
  touch "$BASE/releases/$sha.bad"
  [ -n "$previous" ] && switch_to "$previous"
  exit 1
fi

echo "deployed $HOST $sha (run $run_id)"

# Keep the three newest releases (current is always the newest)
ls -1dt "$BASE"/releases/*/ | tail -n +4 | xargs -r rm -rf
