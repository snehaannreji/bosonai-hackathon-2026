#!/usr/bin/env bash
set -euo pipefail
# AVATAR_SETUP_PYTHON can select a Python 3.10+ interpreter explicitly.
if [[ -n "${AVATAR_SETUP_PYTHON:-}" ]]; then
  avatar_python="$AVATAR_SETUP_PYTHON"
elif command -v python3.12 >/dev/null 2>&1; then
  avatar_python=python3.12
elif command -v python3.11 >/dev/null 2>&1; then
  avatar_python=python3.11
elif command -v python3.10 >/dev/null 2>&1; then
  avatar_python=python3.10
elif [[ -x /opt/homebrew/bin/python3.10 ]]; then
  avatar_python=/opt/homebrew/bin/python3.10
else
  avatar_python=python3
fi
"$avatar_python" -c 'import sys; assert sys.version_info >= (3,10), "Install Python 3.10+ and rerun with AVATAR_SETUP_PYTHON=/path/to/python"'
"$avatar_python" -m venv .venv-avatar
.venv-avatar/bin/python -m pip install -r avatar/requirements.txt
.venv-avatar/bin/python avatar/agent.py --check
