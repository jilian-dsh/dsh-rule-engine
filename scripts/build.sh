#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node --check lib/index.js
node --check lib/core/parser.js
node --check lib/core/understander.js
node --check lib/core/patterns.js
node --check lib/core/state.js
node --check lib/core/audit.js
node --check lib/core/guard-core.js
node --check lib/core/text-detect.js
node --check lib/core/matcher.js
echo "build check ok"
