#!/usr/bin/env bash
set -Eeuo pipefail

# ---------- Helpers ----------
err() { echo "ERROR: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
need_sudo() { [ "$(id -u)" -ne 0 ]; }

# ---------- Go to project root ----------
cd "$(dirname "$0")"

# ---------- Ensure Debian/Ubuntu ----------
have apt-get || err "This script supports Debian/Ubuntu only (apt-get required)."

# ---------- Detect Python version (major.minor) ----------
PYMM="$(python3 -c 'import sys; print(f\"{sys.version_info[0]}.{sys.version_info[1]}\")' 2>/dev/null || echo '')"
[ -n "$PYMM" ] || err "python3 not found. Please install Python 3 first."

# ---------- Install required packages ----------
TO_INSTALL=(python3-pip python3-venv "python${PYMM}-venv")
if ! have pip3; then TO_INSTALL=(python3-pip "${TO_INSTALL[@]}"); fi

echo "Ensuring packages: ${TO_INSTALL[*]}"
SUDO=""; need_sudo && SUDO="sudo"
$SUDO apt-get update -y
$SUDO apt-get install -y "${TO_INSTALL[@]}" || true

# ---------- Create or repair a virtualenv ----------
# If a previous .venv exists but is incomplete, remove it
if [ -d ".venv" ] && [ ! -f ".venv/bin/activate" ]; then
  rm -rf .venv
fi

# First try with built-in venv
if [ ! -f ".venv/bin/activate" ]; then
  if ! python3 -m venv .venv 2>/tmp/venv.err; then
    echo "WARNING: python -m venv failed. Falling back to virtualenv."
    # Fallback: use virtualenv (does not rely on ensurepip)
    python3 -m pip install --user --upgrade virtualenv
    python3 -m virtualenv .venv || {
      cat /tmp/venv.err >&2 || true
      err "Both venv and virtualenv creation failed."
    }
  fi
fi

# shellcheck disable=SC1091
source .venv/bin/activate
python -m pip --version >/dev/null 2>&1 || err "pip is not available inside the virtual environment."

# ---------- Dependencies ----------
python -m pip install --upgrade pip
if [ -f requirements.txt ]; then
  python -m pip install -r requirements.txt
else
  echo "WARNING: requirements.txt not found; skipping dependency installation."
fi

# ---------- Clean outputs ----------
rm -rf out
mkdir -p out

# ---------- Clean configs so the app boots from .env ----------
rm -f config.json config.default.json
rm -f config.json.bak-* || true
rm -f *.json.bak-* || true

# ---------- Start app ----------
exec python app.py
