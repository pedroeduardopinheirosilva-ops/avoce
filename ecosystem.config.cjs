module.exports = {
  apps: [
    {
      name: "avoce",
      script: "./server/dist/index.js",
      cwd: "/opt/avoce",
      env: {
        NODE_ENV:         "production",
        PORT:             "8470",
        DATABASE_URL:     "postgresql://avoce:avoce_senha@localhost:5432/avoce?connection_limit=5&pool_timeout=10",
        JWT_SECRET:       "TROQUE_ESTE_VALOR",
        ADMIN_EMAIL:      "admin@avoce.com.br",
        ADMIN_SENHA:      "TROQUE_ESTA_SENHA",
        CERTS_DIR:        "/opt/avoce/certs",
        CERT_PASS_DEFAULT: "",
        APP_BASE_URL:     "https://avoce.capium.com.br",
        PAKT_BASE_URL:    "https://pakt.capium.com.br",
        PAKT_API_KEY:     "CONFIGURE_AQUI",
        PAKT_WEBHOOK_SECRET: "CONFIGURE_AQUI",
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "300M",
    },
  ],
};
