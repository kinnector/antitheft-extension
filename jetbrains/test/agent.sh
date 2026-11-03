#!/bin/sh
# The guard's agent on plain JVMs, no IDE: builds it, then runs test/agent/AgentTest.java with -javaagent on
# each JDK given (a JDK 21-23 exercises the ASM rewriter, a JDK 24+ the java.lang.classfile one).
#
#   JDK21=<home> JDK25=<home> test/agent.sh [<another JDK home>...]
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
sh "$here/build.sh" --agent >/dev/null
home() { if [ -x "$1/Contents/Home/bin/java" ]; then echo "$1/Contents/Home"; else echo "$1"; fi; }
cls=$here/build/agent-test
mkdir -p "$cls"
"$(home "$JDK21")/bin/javac" --release 21 -d "$cls" "$here/test/agent/AgentTest.java"
status=0
for j in "$JDK21" "$JDK25" "$@"; do
  echo "== $j"
  "$(home "$j")/bin/java" -javaagent:"$here/build/dist/antitheft/lib/antitheft-agent.jar" -cp "$cls" AgentTest || status=1
done
exit $status
