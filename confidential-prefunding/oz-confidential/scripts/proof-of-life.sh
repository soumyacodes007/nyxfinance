#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$ROOT/scripts/bin:$HOME/.nargo/bin:$HOME/.bb:$PATH"

"$ROOT/scripts/install-zk-toolchain.sh"
cargo run -p oz-confidential-runner --manifest-path "$ROOT/Cargo.toml" -- prove-of-life
