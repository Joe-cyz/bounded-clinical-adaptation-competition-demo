#!/usr/bin/env sh
set -eu

cd -- "$(dirname -- "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "请先安装 Node.js 24：https://nodejs.org/en/download"
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  if ! command -v corepack >/dev/null 2>&1; then
    echo "没有找到 pnpm 或 corepack，请重新安装 Node.js 24。"
    exit 1
  fi
  corepack enable
  corepack prepare pnpm@11.19.0 --activate
fi

if [ ! -x "node_modules/.bin/next" ]; then
  echo "第一次启动，正在安装网页依赖..."
  pnpm install --frozen-lockfile
fi

export APP_RUNTIME_MODE="local-research"
export LLM_PROVIDER="mock"
export DEEPSEEK_ENABLED="false"
export DEEPSEEK_API_KEY=""
export PWR08D_REAL_PROVIDER_ENABLED="false"
export PWR08C_FAKE_FETCH="false"
export SPEECH_PROVIDER="disabled"
export DATABASE_PATH="data/runtime/competition-demo.sqlite"

if [ "${DEMO_CHECK_ONLY:-}" = "1" ]; then
  exit 0
fi

if command -v open >/dev/null 2>&1; then
  (sleep 4; open "http://localhost:3000") >/dev/null 2>&1 &
elif command -v xdg-open >/dev/null 2>&1; then
  (sleep 4; xdg-open "http://localhost:3000") >/dev/null 2>&1 &
fi

echo "正在启动演示网页..."
exec pnpm dev
