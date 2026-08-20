#!/bin/sh
# Regenerates src/types-code.ts from src/types.d.ts (the agent-facing copy of the session types).
set -eu
cd "$(dirname "$0")"
{
  printf '// Generated from types.d.ts by `pnpm run types:code` -- edit types.d.ts, then regenerate.\nconst TYPES_CODE = `'
  sed -e 's/\\/\\\\/g' -e 's/`/\\`/g' -e 's/\${/\\${/g' src/types.d.ts
  printf '`;\n\nexport default TYPES_CODE;\n'
} > src/types-code.ts
