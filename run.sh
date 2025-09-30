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

# ---------- Select Python binary ----------
PYBIN="${PYBIN:-python3}"
have "$PYBIN" || err "python3 not found in PATH. Install Python 3 or set PYBIN=/path/to/python3."

# Robustly get major.minor (e.g. 3.12) without failing the script
PYMM="$("$PYBIN" -V 2>&1 | awk '{print $2}' | cut -d. -f1,2 || true)"
[ -n "$PYMM" ] || err "Unable to detect Python version (major.minor). Example: 3.12"

echo "Using Python: $("$PYBIN" -V 2>&1)"

# ---------- Install required packages ----------
PKGS=(python3-pip python3-venv "python${PYMM}-venv")
SUDO=""; need_sudo && SUDO="sudo"

echo "Ensuring packages: ${PKGS[*]}"
$SUDO apt-get update -y
# Try installing all; ignore non-existent versioned venv package gracefully
$SUDO apt-get install -y "${PKGS[@]}" || true

# ---------- Create or repair virtual environment ----------
# Clean incomplete .venv if present
if [ -d ".venv" ] && [ ! -f ".venv/bin/activate" ]; then
  rm -rf .venv
fi

create_with_venv() {
  # Try the stdlib venv first
  "$PYBIN" -m venv .venv
}

create_with_virtualenv() {
  # Fallback that does not rely on ensurepip in the base Python
  "$PYBIN" -m pip install --user --upgrade virtualenv
  "$PYBIN" -m virtualenv .venv
}

if [ ! -f ".venv/bin/activate" ]; then
  # Some minimal images need BOTH python3-venv and pythonX.Y-venv
  # Try stdlib venv; if it fails (ensurepip missing), fall back to virtualenv
  if ! create_with_venv 2>/tmp/venv.err; then
    echo "WARNING: python -m venv failed. Falling back to virtualenv."
    if ! create_with_virtualenv 2>>/tmp/venv.err; then
      echo "---------- venv error log ----------" >&2
      cat /tmp/venv.err >&2 || true
      err "Both 'venv' and 'virtualenv' creation failed."
    fi
  fi
fi

# shellcheck disable=SC1091
source .venv/bin/activate || err "Failed to activate virtual environment."
python -m pip --version >/dev/null 2>&1 || err "pip is not available inside the virtual environment."

# ---------- Install dependencies ----------
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
