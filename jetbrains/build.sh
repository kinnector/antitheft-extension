#!/bin/sh
# Builds the JetBrains plugin with an installed IDE's own JDK and libraries, no Gradle:
#
#   IDE_HOME=/Applications/PyCharm.app/Contents ./build.sh [--dev]
#   JDK21=<home> JDK25=<home> ./build.sh --agent        # the agent alone, no IDE (test/agent.sh)
#
# Output: build/antitheft.zip, a plugin you install from disk (Settings > Plugins > Install Plugin from Disk),
# holding lib/antitheft-plugin.jar, lib/antitheft-agent.jar (the guard the plugin attaches to the IDE) and
# lib/antitheft-guard.jar (the guard's boot classes). Everything runs on Java 21 and later.
#
# The agent rewrites JDK classes with java.lang.classfile on JDK 24+ and with the ASM inside java.base on
# JDK 21-23, so it is built with one JDK of each: the IDE's runtime is one, JDK21 or JDK25 names the other.
# --dev compiles in the development switches (Dev.ENABLED = true); a release build compiles them out.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
mode=release
case "${1:-}" in --dev) mode=dev ;; --agent) mode=agent ;; esac
home() { if [ -x "$1/Contents/Home/bin/javac" ]; then echo "$1/Contents/Home"; else echo "$1"; fi; }
major() { "$1/bin/javac" -version 2>&1 | sed -E 's/^javac ([0-9]+).*/\1/'; }

if [ "$mode" = agent ]; then
  JDK_NEW=$(home "${JDK25:?set JDK25 to a JDK 24 or later}")
  JDK_OLD=$(home "${JDK21:?set JDK21 to a JDK 21, 22 or 23}")
  JDK=$JDK_NEW
else
  IDE_HOME=${IDE_HOME:?set IDE_HOME to the Contents folder of the IDE (macOS) or its install folder}
  JDK=$(home "$IDE_HOME/jbr")
  LIB=$IDE_HOME/lib
  if [ "$(major "$JDK")" -ge 24 ]; then
    JDK_NEW=$JDK
    JDK_OLD=$(home "${JDK21:?the IDE runs JDK 24+, set JDK21 to a JDK 21-23 for the guard on older IDEs, an older IDE jbr will do}")
  else
    JDK_OLD=$JDK
    JDK_NEW=$(home "${JDK25:?the IDE runs JDK 21-23, set JDK25 to a JDK 24 or later for the guard on current IDEs}")
  fi
fi
[ "$(major "$JDK_NEW")" -ge 24 ] || { echo "JDK 24 or later needed, got $JDK_NEW" >&2; exit 1; }
v=$(major "$JDK_OLD")
[ "$v" -ge 21 ] && [ "$v" -le 23 ] || { echo "JDK 21-23 needed, got $JDK_OLD" >&2; exit 1; }

out=$here/build
rm -rf "$out"
mkdir -p "$out/guard" "$out/agent" "$out/plugin" "$out/dist/antitheft/lib"
A=$here/agent/src/pro/antitheft

"$JDK/bin/javac" --release 21 -d "$out/guard" "$A/guard/Guard.java"
"$JDK/bin/javac" --release 21 -cp "$out/guard" -d "$out/agent" "$A/agent/Agent.java"
"$JDK_NEW/bin/javac" -cp "$out/agent" -d "$out/agent" "$A/agent/ClassFileRewriter.java"
"$JDK_OLD/bin/javac" -nowarn --add-exports java.base/jdk.internal.org.objectweb.asm=ALL-UNNAMED -cp "$out/agent" -d "$out/agent" "$A/agent/AsmRewriter.java" 2>&1 | grep -v "^Note:" || true
[ -f "$out/agent/pro/antitheft/agent/AsmRewriter.class" ] || { echo "AsmRewriter did not compile" >&2; exit 1; }
# jars are zips (the JetBrains Runtime ships no `jar` tool); the agent's manifest goes in by hand
(cd "$out/guard" && zip -qr "$out/dist/antitheft/lib/antitheft-guard.jar" .)
mkdir -p "$out/agent/META-INF"
printf 'Manifest-Version: 1.0\nPremain-Class: pro.antitheft.agent.Agent\nAgent-Class: pro.antitheft.agent.Agent\nCan-Retransform-Classes: true\nCan-Redefine-Classes: true\nBoot-Class-Path: antitheft-guard.jar\n' > "$out/agent/META-INF/MANIFEST.MF"
(cd "$out/agent" && zip -qr "$out/dist/antitheft/lib/antitheft-agent.jar" META-INF pro)
if [ "$mode" = agent ]; then
  echo "built $out/dist/antitheft/lib/antitheft-agent.jar"
  exit 0
fi

dev=false
[ "$mode" = dev ] && dev=true
mkdir -p "$out/src"
cp -R "$here/plugin/src/." "$out/src/"
sed -i.bak "s/static final boolean ENABLED = false;/static final boolean ENABLED = $dev;/" "$out/src/pro/antitheft/ide/Dev.java" && rm "$out/src/pro/antitheft/ide/Dev.java.bak"
"$JDK/bin/javac" --release 21 -proc:none -nowarn -cp "$LIB/*" -d "$out/plugin" $(find "$out/src" -name '*.java')
cp -R "$here/plugin/resources/." "$out/plugin/"
# one version for both editors: the plugin takes vscode/package.json's (package.sh writes the same into the
# editors package's manifest), so it never trails behind as a hand-edited <version> did
version=$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$here/../vscode/package.json" | head -n1)
[ -n "$version" ] || { echo "build.sh: no version in vscode/package.json" >&2; exit 1; }
sed -i.bak "s|<version>[^<]*</version>|<version>$version</version>|" "$out/plugin/META-INF/plugin.xml" && rm "$out/plugin/META-INF/plugin.xml.bak"
(cd "$out/plugin" && zip -qr "$out/dist/antitheft/lib/antitheft-plugin.jar" .)
(cd "$out/dist" && rm -f "$out/antitheft.zip" && zip -qr "$out/antitheft.zip" antitheft)
if [ "$dev" = true ]; then
  # the test stealer plugin (test/run.mjs), built here so a test machine needs no build tools
  mkdir -p "$out/stealer"
  "$JDK/bin/javac" --release 21 -proc:none -nowarn -cp "$LIB/*" -d "$out/stealer" "$here/test/stealer/src/poc/Stealer.java"
  cp -R "$here/test/stealer/META-INF" "$out/stealer/"
  (cd "$out/stealer" && zip -qr "$out/test-stealer.jar" .)
fi
echo "built $out/antitheft.zip (dev: $dev)"
