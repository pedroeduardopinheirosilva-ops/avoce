#!/bin/bash
# Deploy Avoce — server + web + prisma
# Usage:
#   ./deploy.sh           — tudo (server + prisma + web + restart)
#   ./deploy.sh server    — server + prisma + restart
#   ./deploy.sh web       — só web (sem restart)
#   ./deploy.sh prisma    — só prisma generate + restart
#   ./deploy.sh restart   — só restart PM2
#
# IMPORTANTE — Prisma em pnpm monorepo:
#   O servidor carrega de server/node_modules/.pnpm/.../
#   Mas `prisma generate` escreve em node_modules/.pnpm/... (root).
#   Por isso é OBRIGATÓRIO copiar após o generate. Este script faz isso.

set -e

HETZNER="root@188.40.110.170"
PASS="Dm2_8SGAAR7pvQ"
DB_URL="postgresql://avoce:avoce_senha@localhost:5432/avoce"

SSH="sshpass -p '$PASS' ssh -o StrictHostKeyChecking=no $HETZNER"
SCP="sshpass -p '$PASS' scp -o StrictHostKeyChecking=no -o PubkeyAuthentication=no -o IdentitiesOnly=yes -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1"

REMOTE_ROOT="/opt/avoce"
PRISMA_VER="@prisma+client@5.22.0_prisma@5.22.0"
PRISMA_ROOT_STORE="$REMOTE_ROOT/node_modules/.pnpm/$PRISMA_VER/node_modules/.prisma/client"
PRISMA_SERVER_STORE="$REMOTE_ROOT/server/node_modules/.pnpm/$PRISMA_VER/node_modules/.prisma/client"

LOCAL_ROOT="$(cd "$(dirname "$0")" && pwd)"

MODE="${1:-all}"

step_build_server() {
  echo "→ Build server..."
  cd "$LOCAL_ROOT/server" && npm run build
}

step_deploy_server() {
  echo "→ Deploy server dist..."
  eval "$SCP -r '$LOCAL_ROOT/server/dist/.' $HETZNER:$REMOTE_ROOT/server/dist/"
}

step_prisma() {
  echo "→ Prisma db push + generate no servidor..."
  eval "$SSH 'cd $REMOTE_ROOT && DATABASE_URL=\"$DB_URL\" npx prisma db push --accept-data-loss 2>&1 | tail -5'"
  eval "$SSH 'cd $REMOTE_ROOT && DATABASE_URL=\"$DB_URL\" npx prisma generate 2>&1 | tail -3'"
  echo "→ Sincronizando Prisma client (root → server store)..."
  eval "$SSH 'cp $PRISMA_ROOT_STORE/index.js $PRISMA_SERVER_STORE/index.js && cp $PRISMA_ROOT_STORE/index.d.ts $PRISMA_SERVER_STORE/index.d.ts && cp $PRISMA_ROOT_STORE/schema.prisma $PRISMA_SERVER_STORE/schema.prisma && echo \"Prisma client OK\"'"
}

step_build_web() {
  echo "→ Build web..."
  cd "$LOCAL_ROOT/web" && npm run build
}

step_deploy_web() {
  echo "→ Apagando assets antigos..."
  eval "$SSH 'rm -f $REMOTE_ROOT/web/dist/index.html $REMOTE_ROOT/web/dist/assets/*.js $REMOTE_ROOT/web/dist/assets/*.css $REMOTE_ROOT/web/dist/assets/*.svg $REMOTE_ROOT/web/dist/assets/*.png 2>/dev/null; mkdir -p $REMOTE_ROOT/web/dist/assets/banks'"
  echo "→ Deploy web dist..."
  $SCP \
    "$LOCAL_ROOT/web/dist/index.html" \
    "$LOCAL_ROOT"/web/dist/assets/index-*.js \
    "$LOCAL_ROOT"/web/dist/assets/index-*.css \
    "$HETZNER:$REMOTE_ROOT/web/dist/assets/"
  eval "$SSH 'mv $REMOTE_ROOT/web/dist/assets/index.html $REMOTE_ROOT/web/dist/'"
  echo "→ Deploy banks SVGs..."
  if ls "$LOCAL_ROOT/web/dist/assets/banks/"*.svg 1>/dev/null 2>&1; then
    $SCP "$LOCAL_ROOT"/web/dist/assets/banks/*.svg "$HETZNER:$REMOTE_ROOT/web/dist/assets/banks/"
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
