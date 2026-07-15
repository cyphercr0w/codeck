#!/usr/bin/env bash
#
# update-container.sh — Safe update of the running `codeck` container to the
# current git branch, preserving the ./Rep-GL3 workspace bind and all volumes.
#
# HOW THE DEPLOY WORKS (post-audit, preset v9.1.0):
#   The heavy lifting is now AUTOMATIC. On rebuild, the new server runs
#   checkPresetUpdate() at startup; it sees the deployed preset (v9.0.0) is older
#   than the image (v9.1.0) and auto-deploys the new files (harness scripts,
#   grader/visual-verifier agents, autonomous-harness skill, /harness command,
#   playbooks) via file-level skip (never overwriting your customized files), and
#   merges the new hooks into settings.json. This script just backs up, rebuilds,
#   and VERIFIES the auto-update landed.
#
# WHAT THIS SCRIPT DOES:
#   0. Preflight (container, .env, branch, on-disk .codeck).
#   1. Backup: named volumes (codeck-claude/ssh/gh) + on-disk .codeck; tag the
#      current image for rollback.
#   2. Rebuild the app image + recreate the container with the SAME mounts.
#   3. Wait for health + for the preset auto-update to reach v9.1.0.
#   4. Verify the new agents/skills/scripts/hooks actually deployed.
#   5. Report the two settings.json values that DON'T auto-merge (see below).
#
# SAFETY: dry-run by default. Nothing happens without --apply. Data lives on the
#   ./Rep-GL3 bind + named volumes; a container recreate never deletes them.
#
# USAGE:
#   scripts/update-container.sh                 # dry-run: print the plan
#   scripts/update-container.sh --apply         # backup + rebuild + verify
#   scripts/update-container.sh --apply --no-backup   # skip backup (NOT recommended)
#
# NOTE: run from Git Bash on the Docker host, when you are NOT mid-task inside the
#       container — the rebuild kills active PTY sessions/processes.

set -euo pipefail
export MSYS_NO_PATHCONV=1

# ── Args ──────────────────────────────────────────────────────────────────
APPLY=0; DO_BACKUP=1
for a in "$@"; do
  case "$a" in
    --apply)     APPLY=1 ;;
    --no-backup) DO_BACKUP=0 ;;
    -h|--help)   grep '^#' "$0" | sed 's/^#\{1,2\} \{0,1\}//'; exit 0 ;;
    *) echo "Unknown arg: $a  (use --help)"; exit 2 ;;
  esac
done

# ── Config ────────────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="codeck"
COMPOSE_FILE="$REPO_ROOT/docker/compose.yml"
ENV_FILE="$REPO_ROOT/.env"
EXPECTED_BRANCH="feat/modernization-2026"
TARGET_VERSION="9.1.0"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${CODECK_BACKUP_DIR:-$HOME/codeck-backups}/$TS"

c(){ printf '\033[%sm' "$1"; }; B="$(c '1;36')"; G="$(c '1;32')"; Y="$(c '1;33')"; R="$(c '1;31')"; N="$(c 0)"
say(){ echo -e "${B}==>${N} $*"; }
warn(){ echo -e "${Y}!! ${N} $*"; }
err(){ echo -e "${R}xx ${N} $*" >&2; }
run(){ if [ "$APPLY" = 1 ]; then echo -e "   ${G}\$${N} $*"; eval "$@"; else echo -e "   ${Y}[dry-run]${N} $*"; fi; }

# ── 0. Preflight ─────────────────────────────────────────────────────────
say "Preflight"
command -v docker >/dev/null || { err "docker not found"; exit 1; }
docker inspect "$CONTAINER" >/dev/null 2>&1 || { err "container '$CONTAINER' not found"; exit 1; }
[ -f "$ENV_FILE" ] || { err ".env not found at $ENV_FILE (needed for the workspace bind)"; exit 1; }
WORKSPACE_BIND="$(grep -E '^CODECK_WORKSPACE=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\r' || true)"
[ -n "$WORKSPACE_BIND" ] || { err "CODECK_WORKSPACE unset in .env — refusing (would fall back to an empty named volume)"; exit 1; }
[ -d "$WORKSPACE_BIND/.codeck" ] || { err "workspace bind '$WORKSPACE_BIND/.codeck' not on disk"; exit 1; }
CUR_BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
echo "   workspace : $WORKSPACE_BIND -> /workspace   (memory/auth/config on the bind — safe)"
echo "   branch    : $CUR_BRANCH"
[ "$CUR_BRANCH" = "$EXPECTED_BRANCH" ] || warn "not on '$EXPECTED_BRANCH' — the image will build from whatever is checked out"
DEPLOYED_VER="$(node -e "try{process.stdout.write(String(require('$WORKSPACE_BIND/.codeck/config.json').version||'?'))}catch(e){process.stdout.write('?')}" 2>/dev/null || echo '?')"
echo "   preset    : deployed v${DEPLOYED_VER}  ->  target v${TARGET_VERSION}"
echo
say "Plan (APPLY=$APPLY  BACKUP=$DO_BACKUP)"
[ "$APPLY" = 1 ] || warn "DRY-RUN — nothing changes. Re-run with --apply."
echo

# ── 1. Backup ────────────────────────────────────────────────────────────
if [ "$DO_BACKUP" = 1 ]; then
  say "1) Backup -> $BACKUP_DIR"
  run "mkdir -p \"$BACKUP_DIR\""
  for v in codeck-claude codeck-ssh codeck-gh; do
    run "docker run --rm -v ${v}:/data alpine tar czf - -C /data . > \"$BACKUP_DIR/${v}.tgz\""
  done
  run "tar czf \"$BACKUP_DIR/codeck-dot.tgz\" -C \"$WORKSPACE_BIND\" --exclude='.codeck/backups' --exclude='.codeck/index' .codeck"
  CUR_IMG="$(docker inspect "$CONTAINER" --format '{{.Image}}')"
  run "docker tag \"$CUR_IMG\" docker-codeck:pre-update-$TS"
  echo "   rollback image tag: docker-codeck:pre-update-$TS"
else
  warn "1) Backup SKIPPED (--no-backup)"
fi
echo

# ── 2. Rebuild + recreate (same mounts via .env) ─────────────────────────
say "2) Rebuild app image + recreate container"
warn "this stops & recreates '$CONTAINER' — active PTY sessions/processes are killed"
run "docker compose --env-file \"$ENV_FILE\" -f \"$COMPOSE_FILE\" up -d --build"
if [ "$APPLY" = 1 ]; then
  echo -n "   waiting for healthcheck"
  for _ in $(seq 1 40); do
    st="$(docker inspect "$CONTAINER" --format '{{.State.Health.Status}}' 2>/dev/null || echo starting)"
    [ "$st" = healthy ] && { echo " -> healthy"; break; }
    echo -n "."; sleep 3
  done
fi
echo

# ── 3. Wait for the preset auto-update (checkPresetUpdate on startup) ─────
say "3) Preset auto-update (v${DEPLOYED_VER} -> v${TARGET_VERSION}, automatic on startup)"
if [ "$APPLY" = 1 ]; then
  echo -n "   waiting for config.json to report v${TARGET_VERSION}"
  ok=0
  for _ in $(seq 1 20); do
    v="$(node -e "try{process.stdout.write(String(require('$WORKSPACE_BIND/.codeck/config.json').version||'?'))}catch(e){process.stdout.write('?')}" 2>/dev/null || echo '?')"
    [ "$v" = "$TARGET_VERSION" ] && { echo " -> v$v"; ok=1; break; }
    echo -n "."; sleep 2
  done
  [ "$ok" = 1 ] || warn "config still not v${TARGET_VERSION} — check container logs: docker logs $CONTAINER | grep Preset"
else
  echo -e "   ${Y}[dry-run]${N} (on --apply, polls $WORKSPACE_BIND/.codeck/config.json until v${TARGET_VERSION})"
fi
echo

# ── 4. Verify the new content deployed ───────────────────────────────────
say "4) Verify deployment"
if [ "$APPLY" = 1 ]; then
  chk(){ if eval "$2" >/dev/null 2>&1; then echo "     ok   $1"; else echo "     MISS $1"; fi; }
  echo "   agents/skills/command (in codeck-claude volume):"
  chk "grader agent"          "docker exec $CONTAINER test -f /root/.claude/agents/grader.md"
  chk "visual-verifier agent" "docker exec $CONTAINER test -f /root/.claude/agents/visual-verifier.md"
  chk "autonomous-harness skill" "docker exec $CONTAINER test -f /root/.claude/skills/autonomous-harness/SKILL.md"
  chk "/harness command"      "docker exec $CONTAINER test -f /root/.claude/commands/harness.md"
  echo "   hook scripts (on the ./Rep-GL3 bind):"
  for f in autonomous-protocol-hook task-classifier-hook budget-guard no-progress-guard harness-resume-hook; do
    chk "$f.mjs" "test -f \"$WORKSPACE_BIND/.codeck/scripts/$f.mjs\""
  done
  echo "   rules:"
  chk "playbooks.md" "test -f \"$WORKSPACE_BIND/.codeck/rules/base/playbooks.md\""
  echo "   hooks merged into settings.json:"
  chk "autonomous-protocol hook registered" "docker exec $CONTAINER grep -q autonomous-protocol-hook /root/.claude/settings.json"
  chk "budget-guard hook registered"        "docker exec $CONTAINER grep -q budget-guard /root/.claude/settings.json"
else
  echo -e "   ${Y}[dry-run]${N} (on --apply, verifies grader/visual-verifier/autonomous-harness/harness + 5 hook scripts + playbooks + merged hooks)"
fi
echo

# ── 5. Non-auto-merging settings.json values (manual, minor) ─────────────
say "5) Manual reconcile — 2 minor settings.json values that do NOT auto-merge"
cat <<EOF
   settings.json is user-owned (skipIfExists) and only its HOOKS are merged on
   update — so these two additions from the branch won't auto-apply:
     • env.ENABLE_TOOL_SEARCH = "1"        (MCP tool-search, ~85% less schema overhead)
     • permissions.deny += "Read(**/.credentials*)", "Read(**/*.pem)"
   To apply them (optional), edit /root/.claude/settings.json in the container UI
   or run (after backing it up):
     docker exec $CONTAINER node -e 'const f="/root/.claude/settings.json",fs=require("fs");const s=JSON.parse(fs.readFileSync(f));s.env=Object.assign({ENABLE_TOOL_SEARCH:"1"},s.env||{});s.permissions=s.permissions||{};s.permissions.deny=[...new Set([...(s.permissions.deny||[]),"Read(**/.credentials*)","Read(**/*.pem)"])];fs.writeFileSync(f,JSON.stringify(s,null,"\t"))'
EOF
echo

# ── Rollback ─────────────────────────────────────────────────────────────
say "Rollback (if needed)"
cat <<EOF
   docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" down
   docker tag docker-codeck:pre-update-$TS docker-codeck
   docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d
   Volume restore (claude): docker run --rm -i -v codeck-claude:/data alpine sh -c 'rm -rf /data/* && tar xzf - -C /data' < "$BACKUP_DIR/codeck-claude.tgz"
   On-disk .codeck restore: tar xzf "$BACKUP_DIR/codeck-dot.tgz" -C "$WORKSPACE_BIND"
   (Note: rolling the image back does NOT downgrade the deployed preset in config.json — restore .codeck from backup if you need v${DEPLOYED_VER} behavior.)

$( [ "$APPLY" = 1 ] && echo "Done." || echo "DRY-RUN complete — re-run with --apply to execute." )
EOF
