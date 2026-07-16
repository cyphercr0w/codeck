#!/usr/bin/env bash
# apply-latest.sh — update the running codeck container to the latest harness
# WITHOUT losing workspace or memory.
#
#   1. backup + rebuild image + recreate container (volumes preserved) + preset
#      auto-update  — via update-container.sh. Memory/preferences/settings are
#      protected by the auto-update; named volumes are external so they are never
#      deleted.
#   2. targeted sync of the few preset files that auto-update does NOT overwrite
#      (modified skills/agents/commands under skipIfExists dirs) + the new
#      settings.json keys — done in-place with docker exec, so the memory is NOT
#      reset (unlike a full preset RESET, which re-scaffolds memory).
#
# Usage:
#   scripts/apply-latest.sh              # do it
#   scripts/apply-latest.sh --dry-run    # preview step 1 only, change nothing
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTAINER="${CODECK_CONTAINER:-codeck}"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

# ── 1. Rebuild + auto-update (backup happens inside update-container.sh) ──────
say "Step 1/2 — backup + rebuild + preset auto-update"
if [ "$DRY" = 1 ]; then
  bash "$REPO_ROOT/scripts/update-container.sh"   # no --apply = dry-run preview
  say "Dry-run complete — nothing changed. Re-run without --dry-run to apply."
  exit 0
fi
bash "$REPO_ROOT/scripts/update-container.sh" --apply

# Wait for the container to be healthy again before touching it.
say "Waiting for ${CONTAINER} to report healthy…"
for i in $(seq 1 60); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo "?")"
  [ "$status" = "healthy" ] && { echo "  healthy"; break; }
  sleep 3
done

# ── 2. Targeted sync of framework files auto-update can't overwrite ───────────
# (modified skills/agents/commands live in skipIfExists dirs; they are NOT user
#  data, so we refresh them from the freshly-built image — no memory is touched.)
say "Step 2/2 — sync modified skills/agents/commands + settings keys (memory untouched)"
docker exec "$CONTAINER" sh -c '
  set -e
  T=/app/apps/runtime/dist/templates/presets/default
  cp "$T/ecc/skills/autonomous-harness/SKILL.md" /root/.claude/skills/autonomous-harness/SKILL.md
  cp "$T/ecc/agents/spec-reviewer.md"           /root/.claude/agents/spec-reviewer.md
  cp "$T/ecc/commands/harness.md"               /root/.claude/commands/harness.md
  echo "  framework files synced"
'

# Merge the new settings.json keys (read-merge-write preserves permissions/hooks/model).
docker exec "$CONTAINER" node -e '
  const f="/root/.claude/settings.json", fs=require("fs");
  const s=JSON.parse(fs.readFileSync(f,"utf8"));
  s.effortLevel="high";
  s.autoCompactEnabled=true;
  s.env=Object.assign(s.env||{},{ENABLE_TOOL_SEARCH:"auto"});
  fs.writeFileSync(f, JSON.stringify(s,null,"\t"));
  console.log("  settings.json updated (effortLevel/autoCompactEnabled/ENABLE_TOOL_SEARCH)");
'

say "Done. Latest harness applied. Open a NEW agent session in the web UI so the"
say "updated hooks/agents/skills/settings load. Workspace + memory are intact."
