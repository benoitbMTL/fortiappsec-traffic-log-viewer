#!/usr/bin/env bash
set -euo pipefail

# Change into the script's directory
cd "$(dirname "$0")"

# Python venv (optional but recommended)
if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate

# Install deps
pip install --upgrade pip
pip install -r requirements.txt

# Ensure output dir exists
mkdir -p out

# Start the app (reads .env)
python3 app.py
