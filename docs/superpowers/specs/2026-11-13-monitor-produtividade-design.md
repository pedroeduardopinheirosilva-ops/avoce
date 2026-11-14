# Monitor de Produtividade da Equipe — design

Data: 13/11/2026 · Projeto: Avoce (`~/NfseCapium`, produção no Debian 192.168.20.100)

## 1. Intenção e porquê

O Pedro quer saber, por funcionário e por dia:

1. **Quantas horas cada um efetivamente trabalha** no computador (tempo ativo, não tempo logado).
2. **Se desvia para coisas pessoais**, e quanto: quais sites/apps, quanto tempo.

Inspiração: a plataforma comercial "Time is Money" (timeismoney.tec.br), mas sem gravação de tela e sem
registro de teclado — risco de sigilo profissional (senhas de PJe/e-CAC/bancos, peças de clientes) e
trabalhista/LGPD alto demais para o que se quer medir.

## 2. Objetivos, não-objetivos, anti-objetivos

**Objetivos**
- Horas efetivas por pessoa/dia: tempo ativo (teclado/mouse com atividade nos últimos 3 min), início e fim
  do dia, pausas.
- Tempo por categoria: **trabalho / pessoal / neutro**, com o top de sites/apps de cada categoria.
- Visão da equipe (quem trabalhou quanto, % pessoal) e detalhe de uma pessoa (linha do tempo do dia).
- Regras de classificação editáveis no próprio Avoce, **por cargo com exceção por pessoa**.

**Não-objetivos (agora)**
- Gravação de tela, screenshots, registro de teclas, conteúdo de mensagens.
- Celulares.
- Medir tempo por cliente/processo (os títulos de janela permitiriam; fica para depois).
- Visualização ao vivo minuto a minuto.

**Anti-objetivos (seria fracasso mesmo funcionando)**
- Alguém além dos três sócios ver o painel.
- Títulos de janela (têm nome de cliente e nº de processo) saírem do servidor próprio ou irem para IA externa.
- O coletor deixar o PC lento ou travar a máquina.

## 3. Restrições

- Computadores **Windows e Mac**, alguns possivelmente notebooks fora do escritório → coleta tem de funcionar
  fora da rede local.
- Stack Avoce: Fastify + tRPC + Prisma/Postgres (server), React/Vite (web), JWT, multi-empresa
  (`Usuario.empresaId`), permissão por módulo (`permissoes.modulos`, `server/src/routers/permission-constants.ts`).
- Fonte em `~/NfseCapium`; build no Mac e rsync do `dist`. **Mudança de schema não usa `prisma db push`** do
  `deploy.sh`: gerar SQL via `prisma migrate diff`, aplicar como `postgres` numa transação e dar `OWNER TO avoce`;
  o Pedro roda o script com `!`.
- ActivityWatch não tem servidor central: cada máquina roda o `aw-server` local (`http://localhost:5600`), com
  buckets `aw-watcher-window_<host>`, `aw-watcher-afk_<host>` e `aw-watcher-web-<navegador>_<host>`.
- URLs/domínios de sites só existem se a extensão **aw-watcher-web** estiver instalada no navegador
  (Chrome/Edge/Firefox/Brave). Safari não tem suporte confiável → nos Macs, padronizar Chrome.
- No Mac, o ActivityWatch precisa da permissão de Acessibilidade para ler títulos de janela.

## 4. Abordagens consideradas

1. **Coletor que envia (ESCOLHIDA).** Programa leve em cada PC lê o `aw-server` local a cada 5 min e faz
   POST ao Avoce com token próprio do dispositivo; guarda o que falhou e reenvia. Funciona dentro e fora do
   escritório. Custo: mais um programa por máquina.
2. **Avoce busca em cada PC.** Sem coletor, mas exige IP fixo/porta aberta, só funciona na LAN e expõe o
   histórico de uso na rede. Descartada.
3. **Sincronização por pasta (aw-sync) para o Debian.** Recurso experimental do ActivityWatch, frágil.
   Descartada.

Classificação de WhatsApp/Instagram — escolhida a **regra por cargo com exceção por pessoa** (ex.: atendimento
e marketing: WhatsApp e Instagram = trabalho; advogados/estagiários: Instagram = pessoal, WhatsApp = neutro).
Descartadas "sempre neutro" (esconde o maior desvio) e "sempre pessoal" (pune quem trabalha neles).

## 5. Como funciona

### 5.1 Nas máquinas
- ActivityWatch instalado (aw-server + aw-watcher-window + aw-watcher-afk), iniciando com o sistema.
- Extensão aw-watcher-web nos navegadores usados.
- **Coletor Avoce**: serviço (Windows: tarefa/serviço; Mac: LaunchAgent). A cada 5 min:
  - lê os eventos novos de cada bucket desde o último envio (`GET /api/0/buckets/<id>/events?start=...`);
  - envia em lote para `POST /api/produtividade/ingest` com header `Authorization: Bearer <token do dispositivo>`;
  - grava localmente o ponteiro do último envio; em falha, tenta de novo no ciclo seguinte (sem perder dados,
    porque o aw-server local guarda tudo);
  - envia também um "sinal de vida" (versão do coletor, buckets encontrados), para o painel mostrar
    "coletor parado há X horas".
- Instalação: script por SO (PowerShell / shell) que instala ActivityWatch + coletor e registra o dispositivo
  com um **código de pareamento** gerado no Avoce (o código vira o token do dispositivo e liga a máquina ao usuário).

### 5.2 No servidor (Avoce)
Tabelas novas (nomes indicativos):
- `MonitorCargo` (id, nome) e `Usuario.monitorCargoId` (opcional) — cargo para fins de classificação.
- `MonitorDispositivo` (id, usuarioId, nome, so, tokenHash, ultimoEnvioEm, versaoColetor, ativo).
- `MonitorEvento` (id, dispositivoId, bucketTipo `janela|afk|web`, inicio, duracaoSeg, app, titulo, url, dominio,
  status afk) — chave única (dispositivoId, bucket, awEventId/inicio) para reenvio idempotente.
- `MonitorRegra` (id, alvo `app|dominio|titulo`, padrao, categoria `trabalho|pessoal|neutro`,
  cargoId?, usuarioId?, prioridade). Precedência: **pessoa > cargo > padrão geral**; sem regra = neutro.
- `MonitorDia` (usuarioId, data, segAtivo, segTrabalho, segPessoal, segNeutro, primeiroEvento, ultimoEvento,
  topJson) — agregado diário recalculável.

Cálculo (job no `cron.ts`, ex. a cada 15 min para o dia corrente e reprocessando o dia anterior de madrugada):
- Tempo ativo = intervalos em que o afk diz "não ausente".
- Sobre o tempo ativo, a janela em foco define o app; se o app for navegador, usa-se o evento web sobreposto
  (domínio) para classificar.
- Cada trecho recebe a categoria pela regra de maior precedência; somam-se os segundos por categoria.
- Vários dispositivos do mesmo usuário somam sem duplicar períodos sobrepostos.

Retenção: eventos brutos 90 dias (apagados por cron); `MonitorDia` permanente. Ajustar depois se precisar.

Regras iniciais (semente, editáveis): trabalho = PJe/tribunais, PSA Docs, Avoce, e-CAC/Receita/SEFAZ, Word/Excel,
Outlook/Gmail do escritório, OnlyOffice; pessoal = YouTube, Instagram, Facebook, TikTok, X, Netflix, sites de
compras, portais de notícia/esporte, jogos; neutro = o resto, inclusive WhatsApp onde o cargo não disser o contrário.

### 5.3 Telas no Avoce (módulo novo `produtividade`)
- **Equipe (por dia ou período):** uma linha por pessoa — horas ativas, início/fim, barra trabalho/pessoal/neutro,
  % pessoal, alerta de coletor parado.

  ```
  13/11  ◀ ▶                     Ativo   Início Fim    Trabalho ███████░ Pessoal  %Pess
  Ana (Atendimento)              7h12    08:04  17:58  ██████████▒░         0h31    7%
  Bruno (Estagiário)             5h40    08:30  18:10  ██████▒▒▒▒░          1h55   34% ⚠
  Carla (Advogada)               —       coletor parado há 26 h ⚠
  ```
- **Pessoa:** linha do tempo do dia (blocos coloridos por categoria, pausas em cinza), top 10 apps/sites
  por categoria com tempo, e os títulos de janela ao clicar num bloco.
- **Regras:** lista de regras com filtro por cargo/pessoa; botão "classificar" direto a partir dos itens
  "neutros" mais usados (o jeito rápido de ir refinando).
- **Dispositivos:** máquinas pareadas, usuário, SO, último envio; gerar código de pareamento; revogar.

Permissão (decidido pelo Pedro): **só os sócios Pedro, Luana e Nadine veem o painel.** Implementado como
flag `Usuario.verProdutividade` (só os três com `true`), e não como entrada em `MODULOS`: dar
`{modulos:[...]}` a quem tem `permissoes = null` restringiria todos os outros módulos dessa pessoa. Admin não
ganha acesso automático. O funcionário não vê o painel (nem os próprios números).

Escopo (decidido pelo Pedro): **os escritórios não são separados** — uma equipe só. Cargos, regras, pessoas e
dispositivos do monitor são globais (não filtrados por `empresaId`); os três sócios veem todo mundo.

Computadores (decidido pelo Pedro): **não são compartilhados** — um dispositivo pertence a uma pessoa; uma pessoa
pode ter mais de um (ex.: desktop + notebook).

Pessoas sem login no Avoce *(decisão do design)*: cria-se um `Usuario` "só monitorado" (sem senha utilizável,
`permissoes = { modulos: [] }`, sem acesso a nenhuma tela), para ligar o dispositivo.

Coleta (decidido pelo Pedro): **o tempo inteiro, 24 h**, sem janela de horário no coletor.
*(decisão do design)* Cada pessoa tem um horário de expediente configurável (padrão seg–sex 08:00–18:00), usado
só no painel para separar as horas em **"no expediente"** e **"fora do expediente"** — as duas aparecem, com a
mesma divisão trabalho/pessoal/neutro. `MonitorDia` guarda os totais das duas faixas.

## 6. Aviso aos funcionários
- Decidido pelo Pedro: **sem termo de ciência**; o sistema não trata aceite.
- O ActivityWatch roda com o ícone padrão na bandeja/barra (não se constrói nada para escondê-lo).
- Os dados ficam só no servidor do escritório e não são enviados a IA externa.

## 7. Deixado ao construtor
- Linguagem do coletor (sugestão: Go, um binário por SO, sem dependências) e formato exato do lote.
- Forma de empacotar a instalação (script vs. instalador) e onde hospedar os binários. Preferir instalação
  por usuário (tarefa no logon no Windows, LaunchAgent no Mac), que não exige senha de administrador; a
  permissão de Acessibilidade no Mac e a extensão do navegador são passos manuais, um por máquina.
- Índices, particionamento e tamanho de lote; detalhes de idempotência.
- Layout fino das telas, seguindo o padrão visual das páginas existentes (`web/src/pages`).
- Testes (vitest já existe no server) para o cálculo de tempo ativo/categoria, que é a parte crítica.

## 8. Instalação mais simples possível (decidido pelo Pedro, 13/11)
- No Avoce, botão **"Instalar para <pessoa>"** (por SO) gera o código de pareamento (24 h) e copia um comando
  de uma linha que já leva o código. Nada de digitar código.
- Na máquina: colar o comando no PowerShell (Windows) ou Terminal (Mac) e Enter. Sem senha de administrador.
  O instalador instala ActivityWatch + coletor, configura início automático, pareia e começa a enviar.
- Passos que o SO não deixa automatizar, o instalador **abre na tela certa**: página da extensão
  aw-watcher-web na Chrome Web Store (pessoa clica "Usar no Chrome") e, no Mac, o painel de Acessibilidade.
- Painel mostra por máquina: ✓ enviando (último envio < 2 h), ✓ sites chegando (bucket web já visto),
  ✓ janelas com título (Mac: Acessibilidade liberada; evento de janela com título nas últimas 24 h).
- Opcional: rodado como administrador, o instalador força a extensão por política do Chrome (verificar
  comportamento em Windows e Mac na construção).
- Descartado: instalador de duplo clique (Gatekeeper/SmartScreen bloqueiam arquivo não assinado).

