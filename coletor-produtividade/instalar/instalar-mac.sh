#!/bin/bash
# Instalador por usuário (sem sudo) do ActivityWatch + coletor Avoce para macOS.
# Uso: curl -fsSL <AVOCE_URL>/api/produtividade/coletor/instalar-mac.sh | bash -s -- <AVOCE_URL> <CODIGO>
set -euo pipefail

AW_VERSAO="v0.14.2"
AW_BASE="https://github.com/ActivityWatch/activitywatch/releases/download/${AW_VERSAO}"
EXT_ID="nglaklhklhcoonedhgnpgddginnjdadi"   # ActivityWatch Web Watcher
EXT_URL="https://chromewebstore.google.com/detail/activitywatch-web-watcher/${EXT_ID}"
LABEL="br.com.avoce.coletor"

if [ "$#" -lt 2 ]; then
  echo "Uso: instalar-mac.sh <URL_DO_AVOCE> <CODIGO>" >&2
  exit 1
fi
AVOCE_URL="${1%/}"
CODIGO="$2"
NOME_PC="$(hostname)"

case "$(uname -m)" in
  arm64)  ARCH_AW="arm64";  ARCH_COLETOR="arm64" ;;
  x86_64) ARCH_AW="x86_64"; ARCH_COLETOR="amd64" ;;
  *) echo "Arquitetura não suportada: $(uname -m)" >&2; exit 1 ;;
esac

TMP="$(mktemp -d)"
MNT=""
cleanup() {
  if [ -n "$MNT" ]; then hdiutil detach "$MNT" -quiet 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

APPS="$HOME/Applications"
DIR_COLETOR="$HOME/Library/Application Support/avoce-coletor"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_ATUAL="$(id -u)"

echo "==> Instalando o ActivityWatch ${AW_VERSAO}..."
DMG="$TMP/aw.dmg"
curl -fsSL "$AW_BASE/activitywatch-${AW_VERSAO}-macos-${ARCH_AW}.dmg" -o "$DMG"
MNT="$TMP/mnt"
mkdir -p "$MNT"
hdiutil attach "$DMG" -nobrowse -readonly -quiet -mountpoint "$MNT"
APP_ORIGEM="$(find "$MNT" -maxdepth 2 -name 'ActivityWatch.app' -print -quit)"
if [ -z "$APP_ORIGEM" ]; then
  echo "ActivityWatch.app não encontrado no instalador baixado." >&2
  exit 1
fi
mkdir -p "$APPS"
pkill -x "ActivityWatch" 2>/dev/null || true
pkill -x "aw-qt" 2>/dev/null || true
sleep 1
rm -rf "$APPS/ActivityWatch.app"
cp -R "$APP_ORIGEM" "$APPS/ActivityWatch.app"
hdiutil detach "$MNT" -quiet 2>/dev/null || true
MNT=""
xattr -dr com.apple.quarantine "$APPS/ActivityWatch.app" 2>/dev/null || true

# Item de login (remove o anterior para não duplicar)
osascript >/dev/null 2>&1 <<OSA || echo "Aviso: não consegui criar o item de login do ActivityWatch."
tell application "System Events"
  if exists login item "ActivityWatch" then delete login item "ActivityWatch"
  make login item at end with properties {path:"$APPS/ActivityWatch.app", hidden:false, name:"ActivityWatch"}
end tell
OSA
open "$APPS/ActivityWatch.app"

echo "==> Instalando o coletor Avoce..."
mkdir -p "$DIR_COLETOR"
# Para o coletor antigo (se houver) antes de trocar o binário
launchctl bootout "gui/$UID_ATUAL/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
pkill -f "$DIR_COLETOR/coletor" 2>/dev/null || true
curl -fsSL "$AVOCE_URL/api/produtividade/coletor/coletor-mac-${ARCH_COLETOR}" -o "$DIR_COLETOR/coletor.novo"
chmod +x "$DIR_COLETOR/coletor.novo"
mv -f "$DIR_COLETOR/coletor.novo" "$DIR_COLETOR/coletor"
xattr -dr com.apple.quarantine "$DIR_COLETOR/coletor" 2>/dev/null || true

if ! "$DIR_COLETOR/coletor" parear --url "$AVOCE_URL" --codigo "$CODIGO" --nome "$NOME_PC"; then
  echo "" >&2
  echo "Não foi possível parear este computador. O código pode ter expirado ou já ter sido usado." >&2
  echo "Gere um novo código no painel do Avoce (Produtividade > Dispositivos) e rode o comando de novo." >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$DIR_COLETOR/coletor</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
PL
launchctl bootstrap "gui/$UID_ATUAL" "$PLIST" 2>/dev/null || launchctl load "$PLIST"

# Opcional: só como administrador (root), força a extensão por política do Chrome.
# Sem root, pula em silêncio. Ver LEIA-ME.md (precisa ser validado em máquina real).
if [ "$UID_ATUAL" = "0" ]; then
  defaults write /Library/Preferences/com.google.Chrome ExtensionInstallForcelist -array \
    "${EXT_ID};https://clients2.google.com/service/update2/crx" 2>/dev/null || true
fi

echo ""
echo "==> Instalação concluída. Duas telas vão abrir agora:"
echo "  1) Acessibilidade: clique no cadeado/+ se preciso e LIGUE a chave do ActivityWatch."
echo "  2) Chrome Web Store: clique em 'Usar no Chrome' / 'Adicionar ao Chrome' e confirme."
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" || true
if [ -d "/Applications/Google Chrome.app" ] || [ -d "$HOME/Applications/Google Chrome.app" ]; then
  open -a "Google Chrome" "$EXT_URL" || true
else
  open "$EXT_URL" || true
fi
echo "Pronto. Em até 10 minutos o painel do Avoce mostra este computador coletando."
