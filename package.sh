#!/usr/bin/env bash
# Assembles the editors package antitheft ships beside antitheft-cli (`<install>/integrations/editors/`), the
# folder `antitheft-cli editors` installs from:
#
#   antitheft.vsix                 the VS Code-family extension (VS Code, Cursor, Antigravity IDE)
#   jetbrains/antitheft/lib/*.jar  the JetBrains plugin, unpacked (copied into an IDE's plugins folder)
#   manifest.json                  {"extension_id": "kinnector.antitheft", "version": "<vscode/package.json version>"}
#
#   ./package.sh [OUT]             OUT defaults to ./out/editors
#
# Needs the two builds first: the VSIX (`cd vscode && node build.mjs`, then vsce: see README.md) at
# vscode/antitheft.vsix, and the JetBrains plugin (`jetbrains/build.sh`, with both JDKs for a release) at
# jetbrains/build/antitheft.zip. Refuses when either is missing or older than its sources.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-$here/out/editors}
vsix=$here/vscode/antitheft.vsix
jbzip=$here/jetbrains/build/antitheft.zip

fail() { echo "package.sh: $*" >&2; exit 1; }
[ -f "$vsix" ] || fail "no $vsix: build the VS Code extension and package it with vsce first"
[ -f "$jbzip" ] || fail "no $jbzip: run jetbrains/build.sh first"
newer=$(find "$here/vscode/src" "$here/vscode/package.json" -newer "$vsix" -type f | head -n1)
[ -z "$newer" ] || fail "$vsix is older than $newer: package it again"
newer=$(find "$here/jetbrains/plugin" "$here/jetbrains/agent" -newer "$jbzip" -type f | head -n1)
[ -z "$newer" ] || fail "$jbzip is older than $newer: build it again"

version=$(node -p 'require(process.argv[1]).version' "$here/vscode/package.json")
id=$(node -p 'const p = require(process.argv[1]); p.publisher + "." + p.name' "$here/vscode/package.json")

rm -rf "$out.tmp"
mkdir -p "$out.tmp/jetbrains"
cp "$vsix" "$out.tmp/antitheft.vsix"
unzip -q "$jbzip" -d "$out.tmp/jetbrains"
[ -n "$(ls "$out.tmp/jetbrains/antitheft/lib/"*.jar 2>/dev/null)" ] || fail "$jbzip holds no antitheft/lib/*.jar"
printf '{"extension_id": "%s", "version": "%s"}\n' "$id" "$version" > "$out.tmp/manifest.json"
rm -rf "$out"
mv "$out.tmp" "$out"
echo "editors package $version ($id) in $out"
