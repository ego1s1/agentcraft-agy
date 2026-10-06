#!/bin/sh
# Simple backend launcher: starts the Foreman (and optionally the game) for a
# git repo, defaulting to the opencode backend.
#
# Usage:
#   ./tools/run.sh --repo <path> [--repo <path>...] [--backend opencode|agy|claude|sim]
#                  [--preset heavy|medium|light] [--goal "<text>"] [--port N]
#                  [--profile NAME] [--home PATH]
#                  [--dev] [--no-game] [--no-foreman] [--reset] [--foreman-arg VALUE]...
#                  [--prism [--prism-instance ID] [--prism-world NAME]]
#
# Examples:
#   ./tools/run.sh --repo ~/git/mori --goal "Add a --version flag"
#   ./tools/run.sh --repo ~/git/mori --preset heavy --no-game --port 7888
#   ./tools/run.sh --repo ~/git/mori -- --transient-retries 5
#   ./tools/run.sh --repo ~/git/mori --prism
#                  # one click: Foreman + Prism instance straight into AgentCraft HQ
#
# Options:
#   --repo <path>        git repo for the team (repeatable, required)
#   --backend <name>     opencode (default) | agy | claude | sim; oc also works
#   --preset <name>      heavy | medium (default) | light; explicit model flags win
#   --goal "<text>"      submit a goal at startup
#   --port N             Foreman port (default 7878, env AGENTCRAFT_PORT)
#   --profile NAME       state profile (default: backend name)
#   --home PATH          state root (default ~/.agentcraft, env AGENTCRAFT_HOME)
#   --no-game            Foreman only, no Minecraft (implied by --prism)
#   --no-foreman         game only; expects a Foreman already listening
#   --dev / --reset      muted background client / wipe the profile first
#   --foreman-arg VALUE  extra Foreman flag, repeatable (e.g. --model <m>)
#   --prism [--prism-instance ID] [--prism-world NAME]
#                        launch the Prism instance instead of the dev client
#   --help               this text
#
# Everything after `--` is forwarded to the Foreman as repeated --foreman-arg
# values (one argv element each, so `-- --transient-retries 5` works).
# With --prism the dev Minecraft client is skipped: run.sh starts only the
# Foreman, then launches the Prism instance (default: the only instance, else
# --prism-instance) and joins --prism-world (default: AgentCraft HQ when that
# world exists in the instance). The game inherits AGENTCRAFT_PORT/HOME/PROFILE
# so the mod links to this Foreman. Stop the Foreman afterwards with
# `node tools/unix.mjs stop --profile <name>`.
# See `node tools/unix.mjs launch --help` and foreman --help for full options.
set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
}

goal=""
preset=""
backend_given=0
backend_val=""
port="${AGENTCRAFT_PORT:-7878}"
profile=""
home_dir=""
prism=0
prism_instance=""
prism_world=""
repos=0

# Single pass over the original "$@" (n items): --goal is consumed, everything
# else is rotated to the back untouched, and post-`--` items become
# --foreman-arg pairs. No eval, no re-quoting: values keep exact bytes.
n=$#
i=0
while [ "$i" -lt "$n" ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --goal) goal="${2:?--goal needs a value}"; shift 2; i=$((i + 2)); continue ;;
    --goal=*) goal="${1#--goal=}"; shift; i=$((i + 1)); continue ;;
    --preset) preset="${2:?--preset needs a value}"; shift 2; i=$((i + 2)); continue ;;
    --preset=*) preset="${1#--preset=}"; shift; i=$((i + 1)); continue ;;
    --prism) prism=1; shift; i=$((i + 1)); continue ;;
    --prism-instance) prism_instance="${2:?--prism-instance needs a value}"; prism=1; shift 2; i=$((i + 2)); continue ;;
    --prism-instance=*) prism_instance="${1#--prism-instance=}"; prism=1; shift; i=$((i + 1)); continue ;;
    --prism-world) prism_world="${2:?--prism-world needs a value}"; prism=1; shift 2; i=$((i + 2)); continue ;;
    --prism-world=*) prism_world="${1#--prism-world=}"; prism=1; shift; i=$((i + 1)); continue ;;
    --backend) [ $# -ge 2 ] || { echo "run.sh: --backend needs a value" >&2; exit 2; }; backend_given=1; backend_val="$2" ;;
    --backend=*) backend_given=1; backend_val="${1#--backend=}" ;;
    --port) port="${2:?run.sh: --port needs a value}" ;;
    --port=*) port="${1#--port=}" ;;
    --profile) profile="${2:?run.sh: --profile needs a value}" ;;
    --profile=*) profile="${1#--profile=}" ;;
    --home) home_dir="${2:?run.sh: --home needs a value}" ;;
    --home=*) home_dir="${1#--home=}" ;;
    --repo|--repo=*) repos=$((repos + 1)) ;;
    --)
      shift; i=$((i + 1))
      while [ "$i" -lt "$n" ]; do set -- "$@" --foreman-arg "$1"; shift; i=$((i + 1)); done
      continue
      ;;
  esac
  arg="$1"; shift; set -- "$@" "$arg"; i=$((i + 1))
done

# --goal/--preset were consumed above; forward each as one foreman argv element.
if [ -n "$goal" ]; then
  set -- "$@" --foreman-arg "--goal=$goal"
fi
if [ -n "$preset" ]; then
  set -- "$@" --foreman-arg "--preset=$preset"
fi

if [ "$repos" -eq 0 ]; then
  echo "run.sh: --repo <path> is required (repeatable)" >&2
  exit 2
fi

if [ "$backend_given" -eq 0 ]; then
  backend_val="${AGENTCRAFT_BACKEND:-opencode}"
  [ -z "${AGENTCRAFT_BACKEND:-}" ] && set -- --backend opencode "$@"
fi
[ "$backend_val" = "agy" ] && backend_val="antigravity"
[ "$backend_val" = "oc" ] && backend_val="opencode"

if [ "$prism" -eq 0 ]; then
  exec node "$ROOT/tools/unix.mjs" launch "$@"
fi

# --prism: Foreman via unix.mjs (no dev client), then the Prism instance.
# unix.mjs profile default is the backend name; home default is ~/.agentcraft.
[ -z "$profile" ] && profile="$backend_val"
[ -z "$home_dir" ] && home_dir="${AGENTCRAFT_HOME:-$HOME/.agentcraft}"

# Someone (you, a previous run) may already have a Foreman on this port that
# this launcher did not start: reuse it instead of failing on the port clash.
if command -v curl >/dev/null 2>&1 && curl -s --max-time 2 "http://127.0.0.1:$port/health" 2>/dev/null | grep -q '"status":"ok"'; then
  echo "Reusing Foreman on :$port ..."
else
  node "$ROOT/tools/unix.mjs" launch --no-game "$@" || exit "$?"
fi

PRISM_BIN="$(command -v prismlauncher 2>/dev/null || true)"
if [ -z "$PRISM_BIN" ] && [ -x "/Applications/PrismLauncher.app/Contents/MacOS/prismlauncher" ]; then
  PRISM_BIN="/Applications/PrismLauncher.app/Contents/MacOS/prismlauncher"
fi
if [ -z "$PRISM_BIN" ]; then
  echo "run.sh: prismlauncher not found (Foreman is running; launch Prism yourself)" >&2
  exit 2
fi

prism_root=""
for d in "$HOME/Library/Application Support/PrismLauncher" "$HOME/.local/share/PrismLauncher"; do
  if [ -d "$d/instances" ]; then prism_root="$d"; break; fi
done
if [ -z "$prism_root" ]; then
  echo "run.sh: no Prism data dir found (Foreman is running; launch Prism yourself)" >&2
  exit 2
fi

if [ -z "$prism_instance" ]; then
  found=""
  count=0
  for inst in "$prism_root"/instances/*/; do
    if [ -f "$inst/instance.cfg" ]; then
      found="${inst%/}"
      found="${found##*/}"
      count=$((count + 1))
    fi
  done
  if [ "$count" -eq 1 ]; then
    prism_instance="$found"
  else
    echo "run.sh: --prism-instance is required (found $count instances):" >&2
    for inst in "$prism_root"/instances/*/; do
      [ -f "$inst/instance.cfg" ] || continue
      name="${inst%/}"
      echo "  ${name##*/}" >&2
    done
    exit 2
  fi
fi
if [ ! -d "$prism_root/instances/$prism_instance" ]; then
  echo "run.sh: no Prism instance '$prism_instance'" >&2
  exit 2
fi
if [ -z "$prism_world" ] && [ -d "$prism_root/instances/$prism_instance/minecraft/saves/AgentCraft HQ" ]; then
  prism_world="AgentCraft HQ"
fi

export AGENTCRAFT_PORT="$port"
export AGENTCRAFT_HOME="$home_dir"
export AGENTCRAFT_PROFILE="$profile"
log_dir="$ROOT/artifacts/logs"
mkdir -p "$log_dir"
log="$log_dir/prism-$profile.log"
if [ -n "$prism_world" ]; then
  echo "Launching Prism '$prism_instance' into world '$prism_world' (Foreman :$port)..."
  "$PRISM_BIN" --launch "$prism_instance" --world "$prism_world" >>"$log" 2>&1 &
else
  echo "Launching Prism '$prism_instance' (Foreman :$port)..."
  "$PRISM_BIN" --launch "$prism_instance" >>"$log" 2>&1 &
fi
echo "Prism starting (log: $log)."
echo "Stop the Foreman with: node tools/unix.mjs stop --profile $profile"
