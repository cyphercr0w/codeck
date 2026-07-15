#!/usr/bin/env bash
#
# update-container.sh — Safe update of the running `codeck` container to the
# current git branch, preserving the ./Rep-GL3 workspace bind and all volumes.
#
# WHAT IT DOES (in order):
#   0. Preflight checks (container, .env, branch, sources).
#   1. Backup: named volumes (codeck-claude/ssh/gh) + the on-disk .codeck dir,
#      and tag the current image for rollback.
#   2. Rebuild the app image and recreate the container with the SAME mounts.
#   3. Selective sync of preset files the rebuild does NOT refresh:
#        - 5 new perf skills  -> /root/.claude/skills   (additive, safe)
#        - teams-reminder-hook -> workspace bind         (backed up first)
#        - [--sync-preset] mcp.json, team-builder        (backed up first)
#        - settings.json is NEVER auto-written (user-owned) — diff is printed.
#   4. Verify + print rollback instructions.
#
# SAFETY: dry-run by default. Nothing happens without --apply.
#         Data lives on the ./Rep-GL3 bind + named volumes; a container
#         recreate never deletes them. Backups are taken regardless.
#
# USAGE:
#   scripts/update-container.sh                 # dry-run: print the plan
#   scripts/update-container.sh --apply         # run backup + rebuild + safe sync
#   scripts/update-container.sh --apply --sync-preset   # also sync mcp.json/team-builder
#   scripts/update-container.sh --apply --skip-rebuild  # only run the selective sync
#   scripts/update-container.sh --apply --no-backup     # skip backups (NOT recommended)
#
# NOTE: run this from Git Bash on the Docker host, when you are NOT mid-task
#       inside the container — the rebuild kills active PTY sessions/processes.

set -euo pipefail
export MSYS_NO_PATHCONV=1   # keep Git Bash from mangling container paths (/root/.claude)

# ── Args ──────────────────────────────────────────────────────────────────
APPLY=0; SYNC_PRESET=0; SKIP_REBUILD=0; DO_BACKUP=1
for a in "$@"; do
  case "$a" in
    --apply)        APPLY=1 ;;
    --sync-preset)  SYNC_PRESET=1 ;;
    --skip-rebuild) SKIP_REBUILD=1 ;;
    --no-backup)    DO_BACKUP=0 ;;
    -h|--help)      grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown arg: $a  (use --help)"; exit 2 ;;
  esac
done

# ── Config ────────────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="codeck"
COMPOSE_FILE="$REPO_ROOT/docker/compose.yml"
ENV_FILE="$REPO_ROOT/.env"
EXPECTED_BRANCH="feat/modernization-2026"
PRESET="$REPO_ROOT/apps/runtime/src/templates/presets/default"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${CODECK_BACKUP_DIR:-$HOME/codeck-backups}/$TS"
NEW_SKILLS=(parallel-execution-optimizer benchmark-optimization-loop \
            data-throughput-accelerator latency-critical-systems recursive-decision-ledger)

# Colors
c(){ printf '\033[%sm' "$1"; }; B="$(c '1;36')"; G="$(c '1;32')"; Y="$(c '1;33')"; R="$(c '1;31')"; N="$(c 0)"
say(){ echo -e "${B}==>${N} $*"; }
warn(){ echo -e "${Y}!! ${N} $*"; }
err(){ echo -e "${R}xx ${N} $*" >&2; }

# run: echo the command in dry-run, execute it under --apply
run(){
  if [ "$APPLY" = 1 ]; then
    echo -e "   ${G}\$${N} $*"; eval "$@"
  else
    echo -e "   ${Y}[dry-run]${N} $*"
  fi
}

# ── 0. Preflight ─────────────────────────────────────────────────────────
say "Preflight checks"
command -v docker >/dev/null || { err "docker not found on PATH"; exit 1; }
docker inspect "$CONTAINER" >/dev/null 2>&1 || { err "container '$CONTAINER' not found"; exit 1; }
[ -f "$ENV_FILE" ] || { err ".env not found at $ENV_FILE (needed for the workspace bind)"; exit 1; }

WORKSPACE_BIND="$(grep -E '^CODECK_WORKSPACE=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\r' || true)"
[ -n "$WORKSPACE_BIND" ] || { err "CODECK_WORKSPACE is not set in .env — refusing (would fall back to an empty named volume)"; exit 1; }
[ -d "$WORKSPACE_BIND/.codeck" ] || { err "workspace bind '$WORKSPACE_BIND/.codeck' not found on disk"; exit 1; }
echo "   workspace bind : $WORKSPACE_BIND  -> /workspace"
echo "   .codeck on disk: $WORKSPACE_BIND/.codeck  (memory, auth, index — safe, on the bind)"

CUR_BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
echo "   git branch     : $CUR_BRANCH"
[ "$CUR_BRANCH" = "$EXPECTED_BRANCH" ] || warn "not on '$EXPECTED_BRANCH' — the rebuild will use whatever is checked out"

for s in "${NEW_SKILLS[@]}"; do
  [ -f "$PRESET/ecc/skills/$s/SKILL.md" ] || { err "missing source skill: $s"; exit 1; }
done
echo "   5 new skills   : found in repo"

echo
say "Plan  (APPLY=$APPLY  BACKUP=$DO_BACKUP  REBUILD=$([ $SKIP_REBUILD = 1 ] && echo no || echo yes)  SYNC_PRESET=$SYNC_PRESET)"
[ "$APPLY" = 1 ] || warn "DRY-RUN — nothing will change. Re-run with --apply to execute."
echo

# ── 1. Backup ────────────────────────────────────────────────────────────
if [ "$DO_BACKUP" = 1 ]; then
  say "1) Backup  ->  $BACKUP_DIR"
  run "mkdir -p \"$BACKUP_DIR\""
  # Named volumes: stream tar to host (no host-dir mount → robust on Windows)
  for v in codeck-claude codeck-ssh codeck-gh; do
    run "docker run --rm -v ${v}:/data alpine tar czf - -C /data . > \"$BACKUP_DIR/${v}.tgz\""
  done
  # On-disk .codeck (exclude prior backups + the FTS5 index to keep it small/fast;
  # the index is rebuildable — drop the --exclude if you want a byte-perfect copy)
  run "tar czf \"$BACKUP_DIR/codeck-dot.tgz\" -C \"$WORKSPACE_BIND\" --exclude='.codeck/backups' --exclude='.codeck/index' .codeck"
  # Tag current image for rollback
  CUR_IMG="$(docker inspect "$CONTAINER" --format '{{.Image}}')"
  run "docker tag \"$CUR_IMG\" docker-codeck:pre-update-$TS"
  echo "   rollback image tag: docker-codeck:pre-update-$TS"
else
  warn "1) Backup SKIPPED (--no-backup)"
fi
echo

# ── 2. Rebuild app + recreate container (same mounts via .env) ───────────
if [ "$SKIP_REBUILD" = 0 ]; then
  say "2) Rebuild app image + recreate container (mounts preserved by .env)"
  warn "this stops & recreates '$CONTAINER' — active PTY sessions/processes will be killed"
  run "docker compose --env-file \"$ENV_FILE\" -f \"$COMPOSE_FILE\" up -d --build"
  # Wait for health
  if [ "$APPLY" = 1 ]; then
    echo -n "   waiting for healthcheck"
    for _ in $(seq 1 30); do
      st="$(docker inspect "$CONTAINER" --format '{{.State.Health.Status}}' 2>/dev/null || echo starting)"
      [ "$st" = healthy ] && { echo " -> healthy"; break; }
      echo -n "."; sleep 3
    done
  fi
else
  warn "2) Rebuild SKIPPED (--skip-rebuild)"
fi
echo

# ── 3. Selective sync of preset files the rebuild does not refresh ───────
say "3) Selective sync"

# 3a. 5 new skills -> /root/.claude/skills  (additive; back up any pre-existing)
echo "   3a. 5 perf skills -> codeck:/root/.claude/skills/"
for s in "${NEW_SKILLS[@]}"; do
  if docker exec "$CONTAINER" test -d "/root/.claude/skills/$s" 2>/dev/null; then
    warn "   '$s' already exists in container — backing up then overwriting"
    run "docker cp \"$CONTAINER:/root/.claude/skills/$s\" \"$BACKUP_DIR/skill-$s.bak\""
  fi
  run "docker cp \"$PRESET/ecc/skills/$s\" \"$CONTAINER:/root/.claude/skills/$s\""
done

# 3b. teams-reminder-hook.mjs -> workspace bind (on disk); back up first
HOOK_SRC="$PRESET/scripts/teams-reminder-hook.mjs"
HOOK_DST="$WORKSPACE_BIND/.codeck/scripts/teams-reminder-hook.mjs"
echo "   3b. teams-reminder-hook.mjs -> $HOOK_DST"
if [ -f "$HOOK_DST" ]; then
  run "cp \"$HOOK_DST\" \"$BACKUP_DIR/teams-reminder-hook.mjs.bak\""
  run "cp \"$HOOK_SRC\" \"$HOOK_DST\""
else
  warn "   not present on disk — skipping (this hook isn't deployed here)"
fi

# 3c. guarded: mcp.json + team-builder (may hold UI customizations)
echo "   3c. mcp.json + team-builder (guarded by --sync-preset)"
if [ "$SYNC_PRESET" = 1 ]; then
  run "docker cp \"$CONTAINER:/root/.claude/mcp.json\" \"$BACKUP_DIR/mcp.json.bak\""
  warn "   overwriting /root/.claude/mcp.json — if you enabled MCP servers via the UI, re-enable them after (they live in this file)"
  run "docker cp \"$PRESET/mcp.json\" \"$CONTAINER:/root/.claude/mcp.json\""
  run "docker cp \"$CONTAINER:/root/.claude/skills/team-builder/SKILL.md\" \"$BACKUP_DIR/team-builder-SKILL.md.bak\" || true"
  run "docker cp \"$PRESET/ecc/skills/team-builder/SKILL.md\" \"$CONTAINER:/root/.claude/skills/team-builder/SKILL.md\""
else
  warn "   skipped (pass --sync-preset to apply). mcp.json change = disable sequential-thinking."
fi

# 3d. settings.json — NEVER auto-written (user-owned, skipIfExists in preset).
echo "   3d. settings.json is user-owned — NOT modified. Apply these 2 edits by hand if you want them:"
echo -e "        ${Y}+ \"fallbackModel\": \"sonnet\",${N}   (after \"enableAllProjectMcpServers\")"
echo -e "        ${Y}- \"Write(/workspace/.codeck/**)\", and - \"Write(/root/.claude/**)\"${N}   (Edit() equivalents already present)"
echo

# ── 4. Verify ────────────────────────────────────────────────────────────
say "4) Verify"
if [ "$APPLY" = 1 ] && [ "$SKIP_REBUILD" = 0 ]; then
  run "curl -fsS http://localhost:80/api/auth/status >/dev/null && echo '   health OK' || echo '   health check FAILED'"
fi
if [ "$APPLY" = 1 ]; then
  echo "   installed skills check:"
  for s in "${NEW_SKILLS[@]}"; do
    docker exec "$CONTAINER" test -f "/root/.claude/skills/$s/SKILL.md" 2>/dev/null \
      && echo "     ok  $s" || echo "     MISSING  $s"
  done
fi
echo

# ── Rollback notes ───────────────────────────────────────────────────────
say "Rollback (if needed)"
cat <<EOF
   Container/image:
     docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" down
     docker tag docker-codeck:pre-update-$TS docker-codeck   # restore previous image
     docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d
   Volume restore (example, claude):
     docker run --rm -v codeck-claude:/data alpine sh -c 'rm -rf /data/*'
     docker run --rm -i -v codeck-claude:/data alpine tar xzf - -C /data < "$BACKUP_DIR/codeck-claude.tgz"
   On-disk .codeck restore:
     tar xzf "$BACKUP_DIR/codeck-dot.tgz" -C "$WORKSPACE_BIND"

$( [ "$APPLY" = 1 ] && echo "Done." || echo "DRY-RUN complete — re-run with --apply to execute." )
EOF
