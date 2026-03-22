#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="/Users/chenxiang/apps"
BACKEND_DIR="${APP_ROOT}/backend"
CONDA_BASE="${HOME}/miniconda3"
CONDA_ENV="arxiv-digest"

if [ ! -f "${CONDA_BASE}/etc/profile.d/conda.sh" ]; then
  echo "conda.sh not found under ${CONDA_BASE}. Update CONDA_BASE in this script."
  exit 1
fi

cd "${BACKEND_DIR}"
source "${CONDA_BASE}/etc/profile.d/conda.sh"
conda activate "${CONDA_ENV}"

exec uvicorn app.main:app --host 0.0.0.0 --port 8000
