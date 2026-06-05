#!/usr/bin/env bash
# miniclaw setup — interactive, idempotent, safe to re-run.
#
# Flags:
#   --yes        accept all defaults; never prompt (CI / scripted installs)
#   --skip-test  skip the post-install test suite
#   --no-deps    skip optional peer deps (playwright / discord.js)
#
# What it does, in order:
#   1. checks node + pnpm versions
#   2. runs `pnpm install`
#   3. seeds .env from .env.example if missing, prompts for provider + key
#   4. optionally installs playwright and/or discord.js peer deps
#   5. runs `pnpm test` to confirm the install is healthy
#   6. prints next-step hints
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ----- flags + helpers ------------------------------------------------------

ASSUME_YES=0
SKIP_TEST=0
SKIP_DEPS=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y)     ASSUME_YES=1 ;;
    --skip-test)  SKIP_TEST=1 ;;
    --no-deps)    SKIP_DEPS=1 ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0 ;;
    *)
      echo "unknown flag: $arg" >&2
      exit 2 ;;
  esac
done

# Color helpers — disabled when stdout isn't a TTY.
if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); RESET=$(printf '\033[0m')
  GREEN=$(printf '\033[32m'); YELLOW=$(printf '\033[33m'); RED=$(printf '\033[31m')
else
  BOLD=""; DIM=""; RESET=""; GREEN=""; YELLOW=""; RED=""
fi

step()    { printf "\n${BOLD}▸ %s${RESET}\n" "$*"; }
note()    { printf "  ${DIM}%s${RESET}\n" "$*"; }
ok()      { printf "  ${GREEN}✓${RESET} %s\n" "$*"; }
warn()    { printf "  ${YELLOW}!${RESET} %s\n" "$*"; }
fail()    { printf "  ${RED}✗${RESET} %s\n" "$*" >&2; exit 1; }

# Read one line, defaulting to $2 when stdin is closed or --yes is set.
# Usage: answer=$(ask "prompt text" "default")
ask() {
  local prompt="$1" default="${2:-}"
  if [ "$ASSUME_YES" = 1 ] || [ ! -t 0 ]; then
    printf '%s\n' "$default"
    return
  fi
  local reply
  if [ -n "$default" ]; then
    read -r -p "  $prompt [$default]: " reply
  else
    read -r -p "  $prompt: " reply
  fi
  printf '%s\n' "${reply:-$default}"
}

# Yes/no version. Returns 0 for yes, 1 for no.
ask_yn() {
  local prompt="$1" default="${2:-n}"
  local answer
  answer=$(ask "$prompt (y/n)" "$default")
  case "${answer,,}" in
    y|yes) return 0 ;;
    *)     return 1 ;;
  esac
}

# ----- 1. prerequisites -----------------------------------------------------

step "checking prerequisites"

if ! command -v node >/dev/null 2>&1; then
  fail "node not found. install Node.js ≥ 20 (https://nodejs.org)"
fi
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "node $NODE_MAJOR is too old. miniclaw needs ≥ 20."
fi
ok "node $(node --version)"

if ! command -v pnpm >/dev/null 2>&1; then
  fail "pnpm not found. install with: brew install pnpm  (or: npm i -g pnpm)"
fi
PNPM_MAJOR=$(pnpm --version | cut -d. -f1)
if [ "$PNPM_MAJOR" -lt 9 ]; then
  fail "pnpm $PNPM_MAJOR is too old. miniclaw needs ≥ 9."
fi
ok "pnpm $(pnpm --version)"

# ----- 2. install workspace deps -------------------------------------------

step "installing workspace dependencies"
pnpm install
ok "workspace installed"

# ----- 3. .env -------------------------------------------------------------

step "configuring .env"

if [ -f .env ]; then
  ok ".env already exists — leaving it untouched"
  note "edit it by hand if you want to switch providers"
else
  cp .env.example .env
  ok "copied .env.example → .env"

  PROVIDER=$(ask "provider (anthropic / openai / gemini)" "anthropic")
  case "$PROVIDER" in
    anthropic) KEY_VAR="ANTHROPIC_API_KEY" ;;
    openai)    KEY_VAR="OPENAI_API_KEY" ;;
    gemini)    KEY_VAR="GEMINI_API_KEY" ;;
    *)
      warn "unknown provider '$PROVIDER' — defaulting to anthropic"
      PROVIDER="anthropic"; KEY_VAR="ANTHROPIC_API_KEY" ;;
  esac

  API_KEY=$(ask "$KEY_VAR (paste or leave blank to fill in later)" "")

  # Rewrite .env: set MINICLAW_PROVIDER (uncomment + assign), comment out
  # other provider keys, and inject the requested one.
  tmp=$(mktemp)
  python3 - "$PROVIDER" "$KEY_VAR" "$API_KEY" .env > "$tmp" <<'PY'
import re, sys
provider, key_var, api_key, path = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
out = []
seen_provider = False
seen_key = False
all_keys = ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY")
with open(path) as fh:
    for line in fh:
        stripped = line.lstrip("# ").rstrip()
        if stripped.startswith("MINICLAW_PROVIDER="):
            out.append(f"MINICLAW_PROVIDER={provider}\n"); seen_provider = True; continue
        m = re.match(r"^(\w+)=", stripped)
        if m and m.group(1) in all_keys:
            name = m.group(1)
            if name == key_var:
                if api_key:
                    out.append(f"{key_var}={api_key}\n")
                else:
                    out.append(f"{key_var}=\n")
                seen_key = True
            else:
                out.append(f"# {name}=\n")
            continue
        out.append(line)
if not seen_provider:
    out.insert(0, f"MINICLAW_PROVIDER={provider}\n")
if not seen_key:
    out.append(f"{key_var}={api_key}\n")
sys.stdout.write("".join(out))
PY
  mv "$tmp" .env
  chmod 600 .env

  if [ -n "$API_KEY" ]; then
    ok "wrote $KEY_VAR to .env"
  else
    warn "$KEY_VAR is blank — edit .env before running the agent"
  fi
fi

# ----- 4. optional peer deps -----------------------------------------------

if [ "$SKIP_DEPS" = 0 ]; then
  step "optional peer deps"
  note "skill-browser needs playwright; transport-discord needs discord.js"
  note "(say no if you don't want them — both can be added later)"

  if ask_yn "install discord.js (~5 MB, enables the Discord transport)" "n"; then
    pnpm add -w discord.js
    ok "discord.js installed"
  else
    note "skipped discord.js — install later with: pnpm add -w discord.js"
  fi

  if ask_yn "install playwright + chromium (~200 MB, enables browser_* skills)" "n"; then
    pnpm add -w playwright
    # Best-effort — chromium download can fail behind proxies; we surface
    # the error but don't abort setup.
    if pnpm exec playwright install chromium; then
      ok "playwright + chromium installed"
    else
      warn "chromium download failed. retry later with: pnpm exec playwright install chromium"
    fi
  else
    note "skipped playwright — install later with: pnpm add -w playwright && pnpm exec playwright install chromium"
  fi
else
  note "--no-deps: skipping optional peer deps"
fi

# ----- 5. test sweep --------------------------------------------------------

if [ "$SKIP_TEST" = 0 ]; then
  step "running test suite"
  if pnpm test >/tmp/miniclaw-setup-test.log 2>&1; then
    # Pluck the totals line for a clean summary.
    grep -E "Tests +[0-9]+ passed" /tmp/miniclaw-setup-test.log | tail -n 1 | sed 's/^/  /' || true
    ok "all tests passed"
  else
    warn "some tests failed — full log at /tmp/miniclaw-setup-test.log"
    warn "this often means a peer dep is partially installed; rerun setup or check the log"
  fi
else
  note "--skip-test: skipping pnpm test"
fi

# ----- 6. summary -----------------------------------------------------------

step "done"
cat <<EOF

  start the REPL:
    pnpm dev

  one-shot mode:
    pnpm dev -- "what's 2+2?"

  start the daemon (Phase 1):
    pnpm dev -- daemon start
    pnpm dev -- chat

  Discord transport (Phase 3):
    add MINICLAW_DISCORD_TOKEN to .env, then:
    pnpm dev -- daemon run

  full env reference + setup details live in README.md
EOF
