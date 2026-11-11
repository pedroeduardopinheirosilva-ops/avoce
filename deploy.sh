#!/bin/bash
# Deploy Avoce — server + web + prisma
# Servidor: Debian escritório — pinheiro@168.90.164.33:2254
# Usage:
#   ./deploy.sh           — tudo (server + prisma + web + restart)
#   ./deploy.sh server    — server + prisma + restart
#   ./deploy.sh web       — só web (sem restart)
#   ./deploy.sh prisma    — só prisma generate + restart
#   ./deploy.sh restart   — só restart PM2

set -e

DEBIAN="pinheiro@168.90.164.33"
PASS="Pinheiro@2026"
PORT="2254"
DB_URL="postgresql://avoce:avoce_senha@localhost:5432/avoce"

SSH="sshpass -p '$PASS' ssh -o StrictHostKeyChecking=no -o PubkeyAuthentication=no -o PreferredAuthentications=password -p $PORT $DEBIAN"
SCP="sshpass -p '$PASS' scp -o StrictHostKeyChecking=no -o PubkeyAuthentication=no -o IdentitiesOnly=yes -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1 -P $PORT"

REMOTE_ROOT="/opt/avoce"
# Servidor usa npm (não pnpm) — Prisma client em node_modules/.prisma/client
PRISMA_ROOT_STORE="$REMOTE_ROOT/node_modules/.prisma/client"

LOCAL_ROOT="$(cd "$(dirname "$0")" && pwd)"

MODE="${1:-all}"

step_build_server() {
  echo "→ Build server..."
  cd "$LOCAL_ROOT/server" && npm run build
}

step_deploy_server() {
  echo "→ Deploy server dist..."
  eval "$SCP -r '$LOCAL_ROOT/server/dist/.' $DEBIAN:$REMOTE_ROOT/server/dist/"
}

step_prisma() {
  echo "→ Copiando schema local para o servidor..."
  eval "$SCP '$LOCAL_ROOT/server/prisma/schema.prisma' $DEBIAN:$REMOTE_ROOT/prisma/schema.prisma"
  eval "$SCP '$LOCAL_ROOT/server/prisma/schema.prisma' $DEBIAN:$REMOTE_ROOT/server/prisma/schema.prisma"
  echo "→ Prisma db push + generate no servidor..."
  eval "$SSH 'cd $REMOTE_ROOT && DATABASE_URL=\"$DB_URL\" npx prisma db push --accept-data-loss 2>&1 | tail -5'"
  eval "$SSH 'cd $REMOTE_ROOT && DATABASE_URL=\"$DB_URL\" npx prisma generate 2>&1 | tail -3 && echo \"Prisma client OK\"'"
}

step_build_web() {
  echo "→ Build web..."
  cd "$LOCAL_ROOT/web" && npm run build
}

step_deploy_web() {
  echo "→ Apagando assets antigos..."
  eval "$SSH 'rm -f $REMOTE_ROOT/web/dist/index.html $REMOTE_ROOT/web/dist/assets/*.js $REMOTE_ROOT/web/dist/assets/*.css $REMOTE_ROOT/web/dist/assets/*.svg $REMOTE_ROOT/web/dist/assets/*.png 2>/dev/null; mkdir -p $REMOTE_ROOT/web/dist/assets/banks'"
  echo "→ Deploy web dist..."
  eval "$SCP \
    '$LOCAL_ROOT/web/dist/index.html' \
    '$LOCAL_ROOT'/web/dist/assets/index-*.js \
    '$LOCAL_ROOT'/web/dist/assets/index-*.css \
    '$DEBIAN:$REMOTE_ROOT/web/dist/assets/'"
  eval "$SSH 'mv $REMOTE_ROOT/web/dist/assets/index.html $REMOTE_ROOT/web/dist/'"
  echo "→ Deploy banks SVGs..."
  if ls "$LOCAL_ROOT/web/dist/assets/banks/"*.svg 1>/dev/null 2>&1; then
    eval "$SCP '$LOCAL_ROOT'/web/dist/assets/banks/*.svg '$DEBIAN:$REMOTE_ROOT/web/dist/assets/banks/'"
  fi
}

step_restart() {
  echo "→ Restart PM2..."
  eval "$SSH 'pm2 restart avoce 2>&1 | grep -E \"avoce|✓\"'"
}

case "$MODE" in
  server)
    step_build_server
    step_deploy_server
    step_prisma
    step_restart
    ;;
  web)
    step_build_web
    step_deploy_web
    ;;
  prisma)
    step_prisma
    step_restart
    ;;
  restart)
    step_restart
    ;;
  all)
    step_build_server
    step_deploy_server
    step_prisma
    step_build_web
    step_deploy_web
    step_restart
    ;;
  *)
    echo "Uso: $0 [server|web|prisma|restart|all]"
    exit 1
    ;;
esac

echo ""
echo "=== Deploy concluído! ==="
