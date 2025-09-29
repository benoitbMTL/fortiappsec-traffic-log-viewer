#!/usr/bin/env bash
set -euo pipefail

# Go to repo root
cd "$(dirname "$0")"

# Python venv (optional but recommended)
if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate

# Deps
pip install --upgrade pip
pip install -r requirements.txt

# Clean outputs
rm -rf out
mkdir -p out

# Clean ALL configs so app boots from .env
rm -f config.json config.default.json
rm -f config.json.bak-* || true
rm -f *.json.bak-* || true

# Start app (will bootstrap from .env)
python3 app.py
