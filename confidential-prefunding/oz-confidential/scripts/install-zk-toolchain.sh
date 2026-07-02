#!/usr/bin/env bash
set -euo pipefail

NARGO_VERSION="1.0.0-beta.11"
BB_VERSION="0.87.0"

NOIRUP_INSTALL_URL="https://raw.githubusercontent.com/noir-lang/noirup/c3bc9922bf7eeafdaba08fb6518776c4ba263a8c/install"
NOIRUP_INSTALL_SHA256="89dde59d8ef9e7794d694abca097fa139fa7395b947cb7b0b7a8d1839c737d8b"
BBUP_INSTALL_URL="https://raw.githubusercontent.com/AztecProtocol/aztec-packages/073ea66ad92c53ebbf7be70d28973a68a8628942/barretenberg/bbup/install"
BBUP_INSTALL_SHA256="3e4b7ce2d18e7680b897d23de0328ba6365616b2c7d592a5ebb74a368f364efd"

curl -fsSL "$NOIRUP_INSTALL_URL" -o /tmp/noirup-install.sh
echo "$NOIRUP_INSTALL_SHA256  /tmp/noirup-install.sh" | sha256sum -c -
bash /tmp/noirup-install.sh
"$HOME/.nargo/bin/noirup" -v "$NARGO_VERSION"

curl -fsSL "$BBUP_INSTALL_URL" -o /tmp/bbup-install.sh
echo "$BBUP_INSTALL_SHA256  /tmp/bbup-install.sh" | sha256sum -c -
bash /tmp/bbup-install.sh
"$HOME/.bb/bbup" -v "$BB_VERSION"
