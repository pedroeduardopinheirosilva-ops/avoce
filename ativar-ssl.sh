#!/bin/bash
# Execute após criar o DNS A record: nfse.capium.com.br → 188.40.110.170
# ./ativar-ssl.sh

PASS="Dm2_8SGAAR7pvQ"
sshpass -p "$PASS" ssh -o StrictHostKeyChecking=no root@188.40.110.170 bash << 'EOF'
set -e

# Emitir certificado
certbot certonly --nginx -d nfse.capium.com.br --non-interactive --agree-tos -m admin@capium.com.br

# Atualizar nginx com SSL
cat > /etc/nginx/sites-available/nfse << 'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name nfse.capium.com.br;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name nfse.capium.com.br;

    ssl_certificate     /etc/letsencrypt/live/nfse.capium.com.br/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/nfse.capium.com.br/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;

    root /opt/nfse-capium/web/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /trpc {
        proxy_pass http://127.0.0.1:8470;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 10m;
    }

    location /api {
        proxy_pass http://127.0.0.1:8470;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 10m;
    }
}
NGINX

nginx -t && nginx -s reload
echo "✅ HTTPS ativo em https://nfse.capium.com.br"
EOF
