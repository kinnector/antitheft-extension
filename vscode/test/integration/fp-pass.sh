#!/usr/bin/env bash
# False-positive pass: popular extensions doing ordinary work with the guard armed must never be refused.
# Runs VS Code with the extensions below, a mixed workspace, and the guard protecting the usual vault
# locations of this computer (browser profiles, wallets, keyrings, messengers) by their real paths, inside
# the workspace sandbox (../../sandbox): the extensions are third-party code, and the guard refuses by path
# before a read, so a file need not be visible for an attempt to show.
#
#   bash test/integration/fp-pass.sh <VSCode-linux-x64 folder> <work folder> [seconds]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
ext=$(cd "$here/../.." && pwd)
code_src=$1
work=$2
secs=${3:-120}
sandbox=$(cd "$ext/../.." && pwd)/sandbox
H=$HOME
EXTENSIONS="ms-python.python ms-python.vscode-pylance ms-python.debugpy eamodio.gitlens dbaeumer.vscode-eslint esbenp.prettier-vscode ms-azuretools.vscode-docker ms-vscode-remote.remote-ssh rust-lang.rust-analyzer golang.go redhat.vscode-yaml ritwickdey.LiveServer vscodevim.vim ms-toolsai.jupyter christian-kohler.path-intellisense streetsidesoftware.code-spell-checker usernamehw.errorlens pkief.material-icon-theme github.vscode-pull-request-github mikestead.dotenv ms-vscode.makefile-tools"
VAULTS="$H/.config/google-chrome:$H/.config/BraveSoftware:$H/.mozilla/firefox:$H/snap/firefox/common/.mozilla/firefox:$H/.config/Exodus:$H/.electrum:$H/.config/Bitwarden:$H/.local/share/keyrings:$H/.password-store:$H/.config/Signal:$H/.local/share/TelegramDesktop:$H/.gnupg:$H/.config/solana:$H/.ethereum/keystore"

mkdir -p "$work"
cd "$work"
[ -x vscode/code ] || cp -r "$code_src" vscode
rm -rf antitheft && mkdir antitheft && cp -r "$ext/package.json" "$ext/dist" "$ext/media" antitheft/
rm -rf probe && cp -r "$ext/test/fixtures/probe" probe
cp "$here/fake-daemon.mjs" .
mkdir -p ws/src ws/.github/workflows
cat > ws/main.py <<'EOF'
import os, json
def main():
    print(json.dumps({"home": os.path.expanduser("~")}))
EOF
printf 'export function add(a: number, b: number) { return a + b; }\n' > ws/src/app.ts
printf '{"name":"ws","version":"1.0.0","scripts":{"test":"echo ok"},"devDependencies":{"eslint":"^9.0.0"}}\n' > ws/package.json
printf '[package]\nname = "ws"\nversion = "0.1.0"\nedition = "2021"\n' > ws/Cargo.toml
printf 'fn main() { println!("hi"); }\n' > ws/src/main.rs
printf 'module ws\n\ngo 1.22\n' > ws/go.mod
printf 'package main\n\nfunc main() {}\n' > ws/main.go
printf 'FROM python:3.12-slim\nCOPY . /app\n' > ws/Dockerfile
printf 'services:\n  app:\n    build: .\n' > ws/docker-compose.yml
printf 'name: ci\non: [push]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n' > ws/.github/workflows/ci.yml
printf 'all:\n\techo hi\n' > ws/Makefile
printf 'API_KEY=example\n' > ws/.env
printf '# ws\n\nSome text with a typpo.\n' > ws/README.md
(cd ws && git init -q 2>/dev/null && git add -A 2>/dev/null && git -c user.email=t@t -c user.name=t commit -qm init 2>/dev/null || true)
: > record.jsonl
: > log.txt

cat > run-inside.sh <<EOF
#!/usr/bin/env bash
set -u
cd "$work"
for e in $EXTENSIONS; do ./vscode/bin/code --user-data-dir ./ud --extensions-dir ./exts --install-extension "\$e" --force >/dev/null 2>&1 || echo "could not install \$e"; done
echo "installed: \$(ls exts | grep -v extensions.json | wc -l)"
node fake-daemon.mjs "$work/s.sock" "$VAULTS" "$work/record.jsonl" &
d=\$!
sleep 1
ANTITHEFT_SOCKET="$work/s.sock" ANTITHEFT_DEV_ASSUME_SERVICE=1 ANTITHEFT_TEST_LOG="$work/log.txt" ANTITHEFT_TEST_DELAY_MS=20000 \
  timeout -k 5 $secs xvfb-run -a ./vscode/code --no-sandbox --user-data-dir ./ud --extensions-dir ./exts --disable-workspace-trust --skip-welcome --disable-telemetry \
  --extensionDevelopmentPath="$work/antitheft" --extensionDevelopmentPath="$work/probe" ws/main.py ws/src/app.ts ws/src/main.rs ws/main.go ws/Dockerfile ws/README.md ws/.env ws >/dev/null 2>&1
kill \$d 2>/dev/null
true
EOF
"$sandbox" bash run-inside.sh || true
echo "== self-check: $(grep '"health"' record.jsonl | tail -1 | sed 's/.*"hooks"://' | cut -c1-200)"
echo "== launches reported (third-party extensions, attribution only): $(grep -o '"kind":"spawn","extension_id":"[^"]*"' record.jsonl | sort | uniq -c | tr '\n' ';')"
blocked=$(grep -o '"kind":"blocked","extension_id":"[^"]*"[^}]*' record.jsonl || true)
if [ -n "$blocked" ]; then echo "== FALSE POSITIVES:"; echo "$blocked" | cut -c1-300; exit 1; fi
echo "== no extension was refused anything"
