# Monitor de Produtividade — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Medir, por pessoa e por dia, as horas efetivas no computador e quanto delas foi trabalho, pessoal ou neutro, com ActivityWatch nas máquinas e um painel no Avoce visível só aos três sócios.

**Architecture:** ActivityWatch roda em cada PC (Windows/Mac). Um coletor em Go lê o `aw-server` local a cada 5 min e envia os eventos ao Avoce (`POST /api/produtividade/ingest`, token por dispositivo). O Avoce guarda os eventos brutos (90 dias), recalcula um agregado diário (`MonitorDia`) num cron e serve o painel por um router tRPC `produtividade` e uma página React.

**Tech Stack:** Fastify 4 + tRPC 10 + Prisma 5/Postgres + vitest (server); React/Vite (web); Go 1.26 (coletor); ActivityWatch v0.13.x + extensão aw-watcher-web.

**Spec:** `docs/superpowers/specs/2026-11-13-monitor-produtividade-design.md`

## Global Constraints

- Fonte em `~/NfseCapium`; build no Mac (`server/node_modules/.bin/tsc -p tsconfig.json`, `web/node_modules/.bin/vite build`); nunca buildar em `/opt/avoce/*/src`.
- Mudança de schema **não** usa `prisma db push` nem `./deploy.sh prisma`: SQL gerado por `prisma migrate diff`, sem `DROP TABLE "bkp_*"`, aplicado numa transação como `postgres`, com `ALTER TABLE … OWNER TO avoce`; o Pedro roda com `!`.
- Painel visível **só a Pedro, Luana e Nadine**: flag `Usuario.verProdutividade` (default `false`). Nada de admin/`permissoes = null` liberar acesso. (Flag em vez de entrada em `MODULOS`: dar `{modulos:[...]}` a quem tem `permissoes = null` restringiria todos os outros módulos dele.)
- Escopo global: cargos, regras, dispositivos e pessoas do monitor **não** são filtrados por `empresaId`.
- Coleta 24 h; expediente por pessoa só separa "no expediente" / "fora do expediente". Padrão: seg–sex 08:00–18:00.
- Fuso fixo `-03:00` (America/Sao_Paulo, sem horário de verão) para dia e expediente.
- Ocioso: o que o `aw-watcher-afk` marcar como `afk` não conta (limiar padrão do ActivityWatch: 3 min).
- Categorias: `trabalho | pessoal | neutro`; sem regra = `neutro`. Precedência: pessoa > cargo > geral.
- Sem gravação de tela/teclado; dados não vão a IA externa.
- Eventos brutos: retenção 90 dias. `MonitorDia`: permanente.
- Commits: `git add` só dos arquivos da tarefa (a árvore do repo tem outras mudanças não commitadas).

## Review Focus

1. **Evento do ActivityWatch que cresce** (heartbeat: mesmo `timestamp`, `duration` maior a cada envio) — o reenvio deve atualizar a duração, não duplicar nem ignorar. Teste na Task 3.
2. **Coletor offline por dias** (notebook em viagem) e depois volta — os dias antigos devem ser recalculados, não só hoje. Teste na Task 3 (marca dias sujos) e Task 4.
3. **Duas máquinas da mesma pessoa ativas ao mesmo tempo** — o tempo não pode somar em dobro. Teste na Task 2.
4. **Bloco que atravessa meia-noite ou o fim do expediente** — dividido entre dias/faixas, não jogado inteiro num lado. Teste na Task 2.
5. **Token revogado ou código de pareamento vencido/reusado** — 401 e nenhum evento gravado. Teste na Task 3.

---

## File Structure

```
server/prisma/schema.prisma                         (modify) modelos Monitor* + campos em Usuario
server/prisma/migrations-manual/2026-11-13-monitor-produtividade.sql   (create) SQL de produção
server/src/lib/produtividade/tipos.ts               (create) tipos compartilhados
server/src/lib/produtividade/classificar.ts         (create) regra → categoria
server/src/lib/produtividade/calculo.ts             (create) eventos → totais/linha do tempo
server/src/lib/produtividade/ingest.ts              (create) pareamento + gravação de eventos
server/src/lib/produtividade/agregar.ts             (create) recálculo de MonitorDia + retenção
server/src/lib/produtividade/regras-iniciais.ts     (create) semente de regras
server/src/lib/produtividade/*.test.ts              (create) testes
server/src/routers/produtividade.ts                 (create) router tRPC
server/src/routers/index.ts                         (modify) registra `produtividade`
server/src/routers/auth.ts                          (modify) `me` devolve verProdutividade
server/src/index.ts                                 (modify) rotas REST ingest/parear/download
server/src/cron.ts                                  (modify) agendamentos
web/src/pages/Produtividade/{index,Equipe,Pessoa,Regras,Dispositivos}.tsx   (create)
web/src/App.tsx, web/src/components/Layout.tsx, web/src/lib/usePermission.ts (modify)
coletor-produtividade/ (Go module: main.go, aw.go, envio.go, estado.go, *_test.go, Makefile)
coletor-produtividade/instalar/{instalar-mac.sh,instalar-windows.ps1,LEIA-ME.md}
```

---

### Task 1: Schema e SQL de produção

**Files:**
- Modify: `server/prisma/schema.prisma` (model `Usuario`, linha ~67; novos models no fim)
- Create: `server/prisma/migrations-manual/2026-11-13-monitor-produtividade.sql`

**Interfaces — Produces (nomes Prisma usados por todas as tarefas):**
- `Usuario`: `verProdutividade Boolean @default(false)`, `monitorado Boolean @default(false)`, `monitorCargoId String?` (→ `MonitorCargo`), `monitorExpediente Json?` (`{ dias: number[] /*0=dom..6=sáb*/, inicio: "HH:MM", fim: "HH:MM" }`; `null` = padrão).
- `MonitorCargo { id cuid, nome String @unique, criadoEm }`
- `MonitorDispositivo { id cuid, usuarioId, nome String, so String? /*"windows"|"mac"*/, tokenHash String? @unique, codigoPareamento String? @unique, codigoExpiraEm DateTime?, pareadoEm DateTime?, ultimoEnvioEm DateTime?, versaoColetor String?, bucketsVistos String[] @default([]), ultimoTituloEm DateTime?, ativo Boolean @default(true), criadoEm }` — index `usuarioId`.
- `MonitorEvento { id BigInt @id @default(autoincrement()), dispositivoId, bucket String /*"janela"|"afk"|"web"*/, inicio DateTime, duracaoSeg Float, app String?, titulo String?, url String?, dominio String?, afk Boolean? }` — `@@unique([dispositivoId, bucket, inicio])`, `@@index([dispositivoId, inicio])`, `onDelete: Cascade` do dispositivo.
- `MonitorRegra { id cuid, alvo String /*"app"|"dominio"|"titulo"*/, padrao String, categoria String, cargoId String?, usuarioId String?, prioridade Int @default(0), criadoEm }`
- `MonitorDia { usuarioId, data String /*"YYYY-MM-DD"*/, segAtivo Int, segTrabalho Int, segPessoal Int, segNeutro Int, segAtivoFora Int, segTrabalhoFora Int, segPessoalFora Int, segNeutroFora Int, primeiroEvento DateTime?, ultimoEvento DateTime?, topJson Json?, sujo Boolean @default(true), calculadoEm DateTime? }` — `@@id([usuarioId, data])`, `@@index([sujo])`. Contadores com `@default(0)`.

- [ ] **Step 1:** Editar o schema com os modelos acima (relações nomeadas onde `Usuario` tiver mais de uma relação com o mesmo model).
- [ ] **Step 2:** Run `cd server && npx prisma validate && npx prisma generate` → Expected: "The schema … is valid" e client gerado.
- [ ] **Step 3:** Gerar o SQL só-leitura contra produção (túnel SSH até o Postgres do Debian) com `npx prisma migrate diff --from-url "$PROD_URL" --to-schema-datamodel prisma/schema.prisma --script`; salvar em `migrations-manual/2026-11-13-monitor-produtividade.sql` envolvido em `BEGIN; … COMMIT;`, **removendo qualquer `DROP`**, acrescentando `ALTER TABLE "<cada tabela nova>" OWNER TO avoce;`.
- [ ] **Step 4:** Conferir: `grep -c DROP server/prisma/migrations-manual/2026-11-13-monitor-produtividade.sql` → Expected: `0`; o SQL só contém `CREATE TABLE "Monitor…"`, `CREATE INDEX`, `ALTER TABLE "Usuario" ADD COLUMN …` e FKs.
- [ ] **Step 5:** Commit `feat(produtividade): schema do monitor`.

---

### Task 2: Classificação e cálculo (núcleo puro, sem banco)

**Files:**
- Create: `server/src/lib/produtividade/tipos.ts`, `classificar.ts`, `calculo.ts`
- Test: `server/src/lib/produtividade/classificar.test.ts`, `calculo.test.ts`

**Interfaces — Produces:**
```ts
// tipos.ts
export type Categoria = "trabalho" | "pessoal" | "neutro";
export type Regra = { alvo: "app" | "dominio" | "titulo"; padrao: string; categoria: Categoria;
  cargoId: string | null; usuarioId: string | null; prioridade: number };
export type Item = { app: string | null; dominio: string | null; titulo: string | null };
export type EventoBruto = { dispositivoId: string; bucket: "janela" | "afk" | "web"; inicio: Date;
  duracaoSeg: number; app?: string | null; titulo?: string | null; url?: string | null;
  dominio?: string | null; afk?: boolean | null };
export type Expediente = { dias: number[]; inicio: string; fim: string };
export const EXPEDIENTE_PADRAO: Expediente = { dias: [1, 2, 3, 4, 5], inicio: "08:00", fim: "18:00" };
export type Totais = { ativo: number; trabalho: number; pessoal: number; neutro: number };
export type ResultadoDia = { data: string; dentro: Totais; fora: Totais;
  primeiroEvento: Date | null; ultimoEvento: Date | null;
  top: Record<Categoria, { chave: string; seg: number }[]>;   // top 10 por categoria
  blocos: { inicio: Date; fim: Date; categoria: Categoria | "pausa"; chave: string; titulos: string[] }[] };
// classificar.ts
export function classificar(item: Item, regras: Regra[], pessoa: { usuarioId: string; cargoId: string | null }): Categoria;
export function dominioDaUrl(url: string): string | null;   // "https://www.youtube.com/x" → "youtube.com"
// calculo.ts
export function calcularDia(data: string, eventos: EventoBruto[], regras: Regra[],
  pessoa: { usuarioId: string; cargoId: string | null; expediente: Expediente | null }): ResultadoDia;
export function dataLocal(d: Date): string;  // "YYYY-MM-DD" em -03:00
```

**Regras de `classificar`:** casa sem diferenciar maiúsculas. `app`: `item.app` contém `padrao`. `dominio`: `item.dominio === padrao` ou termina com `"." + padrao`. `titulo`: `item.titulo` contém `padrao`. Entre as regras que casam, vence o nível mais específico (regra com `usuarioId === pessoa.usuarioId` > `cargoId === pessoa.cargoId` > geral com ambos `null`; regras de outra pessoa/cargo são ignoradas); empate → maior `prioridade` → `padrao` mais longo. Nenhuma → `"neutro"`.

**Algoritmo de `calcularDia`** (não determinado pelos testes, por isso aqui): grade de 86 400 posições (1 s) do dia `data` em -03:00.
1. Marcar ativo: cada evento `afk` com `afk === false` marca as posições que cobre (recortado ao dia). A união entre dispositivos evita contagem em dobro.
2. Atribuir item: percorrer eventos `janela` ordenados por `inicio` e gravar o item nas posições ativas ainda sem item (primeiro a ocupar fica). Se o `app` for navegador (`chrome`, `google chrome`, `msedge`, `microsoft edge`, `firefox`, `brave`, `safari`, `opera`, sem diferenciar maiúsculas), o item da posição passa a ser o do evento `web` que cobre aquela posição, se houver (`dominio`, `titulo` da aba).
3. Posições ativas sem nenhum evento de janela → item vazio → `neutro`.
4. Cada posição ativa entra em `dentro` ou `fora` conforme o expediente (dia da semana em `dias` e hora em `[inicio, fim)`).
5. `top`: chave = `dominio` se houver, senão `app`; soma por categoria, 10 maiores.
6. `blocos`: posições consecutivas com a mesma categoria (inativas = `"pausa"`, só entre o primeiro e o último evento ativo), juntando blocos de < 60 s ao anterior; `chave` = item mais frequente do bloco; `titulos` = até 5 títulos distintos mais frequentes.

- [ ] **Step 1: Testes que falham** (`classificar.test.ts`):
  - `regra de pessoa vence a de cargo`: regras `{app "whatsapp" → neutro, cargo "adv"}` e `{app "whatsapp" → trabalho, usuario "u1"}`; `classificar({app:"WhatsApp"…}, regras, {usuarioId:"u1", cargoId:"adv"})` → `"trabalho"`.
  - `regra de cargo vence a geral`: geral `{dominio "instagram.com" → pessoal}`, cargo "mkt" `→ trabalho`; pessoa do cargo "mkt" → `"trabalho"`; pessoa do cargo "adv" → `"pessoal"`.
  - `regra de outra pessoa é ignorada`: regra só de "u2" → para "u1" sem outras regras dá `"neutro"`.
  - `domínio casa subdomínio mas não sufixo solto`: `"m.youtube.com"` casa `youtube.com`; `"notyoutube.com"` não casa.
  - `dominioDaUrl` tira `www.` e devolve `null` para URL inválida.
- [ ] **Step 2: Testes que falham** (`calculo.test.ts`, helper `ev(bucket, "HH:MM:SS", seg, extra)` criando datas `2026-11-13T…-03:00`):
  - `ocioso não conta`: afk `false` 09:00 por 3600 s, afk `true` 10:00 por 1800 s, janela Word 09:00 por 5400 s → `dentro.ativo === 3600`, `dentro.trabalho === 3600` com regra `{app "winword" → trabalho}` e app `"WINWORD.EXE"`.
  - `navegador usa o domínio da aba`: janela `chrome.exe` 09:00 por 600 s; web `youtube.com` 09:00 por 300 s e `pje.jus.br` 09:05 por 300 s; regras youtube→pessoal, pje.jus.br→trabalho → `pessoal 300`, `trabalho 300`.
  - `duas máquinas ao mesmo tempo não somam em dobro`: dispositivos A e B com afk `false` 09:00 por 3600 s cada → `dentro.ativo === 3600`.
  - `fim do expediente divide o bloco`: afk `false` 17:30 por 3600 s, janela Word no mesmo intervalo → `dentro.ativo 1800`, `fora.ativo 1800`.
  - `sábado é todo fora do expediente`: data `2026-11-14` → `dentro.ativo === 0`.
  - `evento que atravessa meia-noite só conta a parte do dia`: afk `false` `2026-11-12T23:30-03:00` por 3600 s, `calcularDia("2026-11-13", …)` → ativo 1800.
  - `top e blocos`: o top de `pessoal` começa com `{chave:"youtube.com"}`; existe bloco `pausa` entre dois blocos ativos separados por 10 min de afk.
- [ ] **Step 3:** Run `cd server && npx vitest run src/lib/produtividade` → Expected: FAIL (módulos não existem).
- [ ] **Step 4:** Implementar `tipos.ts`, `classificar.ts`, `calculo.ts` com as assinaturas e o algoritmo acima.
- [ ] **Step 5:** Run `npx vitest run src/lib/produtividade` → Expected: PASS.
- [ ] **Step 6:** Commit `feat(produtividade): classificação e cálculo diário`.

---

### Task 3: Pareamento e ingestão (REST)

**Files:**
- Create: `server/src/lib/produtividade/ingest.ts`, `ingest.test.ts`
- Modify: `server/src/index.ts` (registrar rotas perto das demais `/api/*`, ~linha 613)

**Interfaces:**
- Consumes: `dominioDaUrl`, `dataLocal` (Task 2); models da Task 1.
- Produces:
```ts
export function gerarCodigoPareamento(): string;           // 8 chars A-Z2-9 sem 0/O/1/I
export function hashToken(token: string): string;          // sha256 hex
export async function parear(input: { codigo: string; nome: string; so: string }):
  Promise<{ token: string; dispositivoId: string }>;        // erro "codigo_invalido" se não existe/vencido/já usado
export type LoteIngest = { versao: string; so: string; eventos: { bucket: "janela"|"afk"|"web"; inicio: string;
  duracaoSeg: number; app?: string; titulo?: string; url?: string; afk?: boolean }[] };
export async function ingerir(token: string, lote: LoteIngest): Promise<{ gravados: number; dias: string[] }>;
  // erro "token_invalido" se não acha dispositivo ativo pelo hash
```
- Rotas: `POST /api/produtividade/parear` (body `{codigo,nome,so}` → 200 `{token}` | 400); `POST /api/produtividade/ingest` (header `Authorization: Bearer <token>`, body `LoteIngest` → 200 `{gravados}` | 401 | 413 se > 5000 eventos). Sem JWT do Avoce.

**Regras de `ingerir`:** descarta eventos com `inicio` > agora + 5 min ou < agora − 90 dias, ou `duracaoSeg < 0`; trunca `titulo` em 500 e `url` em 1000 caracteres; `dominio` calculado no servidor via `dominioDaUrl`; grava com `upsert` por `(dispositivoId, bucket, inicio)` atualizando `duracaoSeg` (e campos) — em lotes, com `INSERT … ON CONFLICT … DO UPDATE` via `prisma.$executeRaw` se o upsert um-a-um ficar lento; atualiza `ultimoEnvioEm`, `versaoColetor`, `so`, acrescenta a `bucketsVistos` os tipos de bucket presentes no lote e, se houver evento `janela` com `titulo` não vazio, `ultimoTituloEm = now`; para cada dia local coberto pelos eventos (início e fim), faz upsert de `MonitorDia { usuarioId, data, sujo: true }`. Lote vazio vale como sinal de vida.

- [ ] **Step 1: Testes que falham** (`ingest.test.ts`, `vi.mock("../../db.js")` com prisma falso em memória, no estilo de `src/lib/reuniao-agenda.test.ts`):
  - `pareia com código válido e o código não serve de novo`: segundo `parear` com o mesmo código → rejeita `"codigo_invalido"`.
  - `código vencido é recusado` (`codigoExpiraEm` no passado).
  - `token revogado é recusado e nada é gravado` (`ativo: false` → `"token_invalido"`, 0 eventos).
  - `reenvio do mesmo evento com duração maior atualiza, não duplica`: dois lotes com o mesmo `inicio` e `duracaoSeg` 60 → 300 → 1 evento com 300.
  - `evento de 10 dias atrás marca aquele dia como sujo`: retorno `dias` contém a data de 10 dias atrás.
  - `evento no futuro distante é descartado`.
  - `lote com evento web marca o bucket como visto e janela com título atualiza ultimoTituloEm`.
- [ ] **Step 2:** Run `npx vitest run src/lib/produtividade/ingest.test.ts` → Expected: FAIL.
- [ ] **Step 3:** Implementar `ingest.ts` e as duas rotas em `index.ts` (mapear erros: `codigo_invalido`→400, `token_invalido`→401).
- [ ] **Step 4:** Run os testes → Expected: PASS. Run `npx tsc -p tsconfig.json --noEmit` → Expected: sem erros novos.
- [ ] **Step 5:** Commit `feat(produtividade): pareamento e ingestão de eventos`.

---

### Task 4: Recálculo diário, retenção e cron

**Files:**
- Create: `server/src/lib/produtividade/agregar.ts`, `agregar.test.ts`
- Modify: `server/src/cron.ts` (dentro de `iniciarCron()`)

**Interfaces:**
- Consumes: `calcularDia`, `EXPEDIENTE_PADRAO` (Task 2); `MonitorDia.sujo` (Task 3).
- Produces:
```ts
export async function recalcularDia(usuarioId: string, data: string): Promise<ResultadoDia>; // lê eventos dos dispositivos do usuário que cruzam o dia (inicio entre data−1d e data+1d), regras, cargo, expediente; grava MonitorDia (segundos arredondados, topJson = top, sujo=false, calculadoEm=now)
export async function recalcularSujos(limite?: number): Promise<number>;   // default 200; também marca "hoje" sujo para todo usuário monitorado com dispositivo ativo
export async function apagarEventosAntigos(): Promise<number>;            // apaga MonitorEvento com inicio < now − 90 dias
```
- Cron: `"*/15 * * * *"` → `recalcularSujos()`; `"30 3 * * *"` → `apagarEventosAntigos()`. Cada um em `try/catch` com `console.error("[PRODUTIVIDADE] …")`, igual aos demais.

- [ ] **Step 1: Testes que falham** (`agregar.test.ts`, prisma mockado): `recalcularDia grava os totais e limpa sujo` (eventos de um dia útil → `MonitorDia.segTrabalho` esperado e `sujo: false`); `usa EXPEDIENTE_PADRAO quando monitorExpediente é null`; `apagarEventosAntigos usa corte de 90 dias` (verifica o `where.inicio.lt` passado ao `deleteMany`).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implementar e agendar no `cron.ts`. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(produtividade): agregado diário e retenção`.

---

### Task 5: Router tRPC `produtividade` + regras iniciais

**Files:**
- Create: `server/src/routers/produtividade.ts`, `server/src/routers/produtividade.test.ts`, `server/src/lib/produtividade/regras-iniciais.ts`
- Modify: `server/src/routers/index.ts` (`produtividade: produtividadeRouter`), `server/src/routers/auth.ts` (`me` seleciona e devolve `verProdutividade`)

**Interfaces:**
- Consumes: `authProc` (`routers/trpc.ts`), `recalcularDia`, `calcularDia`, `gerarCodigoPareamento`, `hashToken`.
- Produces `produtividadeProc = authProc.use(...)`: lê `Usuario.verProdutividade` do `ctx.userId`; se `false` → `TRPCError FORBIDDEN` (inclusive para admin). Procedures:
  - `equipe({ de: string, ate: string })` → por pessoa monitorada: `{ usuarioId, nome, cargo, dias: MonitorDia[], soma: {dentro: Totais, fora: Totais}, coletorParadoHa: number | null /*horas desde o último ultimoEnvioEm, null se < 2 h*/ }`.
  - `pessoa({ usuarioId, data })` → `ResultadoDia` calculado na hora com `calcularDia` (eventos brutos); se o dia for mais antigo que 90 dias, devolve só o `MonitorDia` com `blocos: []`.
  - `neutrosMaisUsados({ de, ate })` → top 30 chaves classificadas como `neutro` no período (a partir de `topJson`).
  - `regras.listar / criar / editar / excluir`; `cargos.listar / criar / renomear / excluir` (excluir cargo com pessoas → BAD_REQUEST).
  - `pessoas.listar` (usuários com `monitorado = true` + dispositivos, cada um com `checks: { enviando: boolean /*ultimoEnvioEm < 2 h*/, sites: boolean /*bucketsVistos inclui "web"*/, titulos: boolean /*ultimoTituloEm < 24 h*/ }`); `pessoas.criarSoMonitorado({ nome })` (cria `Usuario` com email sintético `monitor+<cuid>@avoce.local`, senha = hash bcrypt de bytes aleatórios, `permissoes = { modulos: [] }`, `monitorado = true`, `ativo = true`); `pessoas.atualizar({ usuarioId, monitorado?, cargoId?, expediente? })`.
  - `dispositivos.gerarCodigo({ usuarioId, nome })` → `{ codigo, expiraEm }` (24 h; cria `MonitorDispositivo` pendente); `dispositivos.revogar({ id })` (`ativo=false`, `tokenHash=null`).
  - `regras.semear()` → insere `REGRAS_INICIAIS` se não houver nenhuma regra.
- `REGRAS_INICIAIS: Omit<Regra,"cargoId"|"usuarioId">[]` (gerais): trabalho → domínios `pje.jus.br`, `jus.br`, `tjba.jus.br`, `trf1.jus.br`, `stj.jus.br`, `receita.fazenda.gov.br`, `gov.br`, `sefaz.ba.gov.br`, `avoce.capium.com.br`, `avoce.com.br`, `capium.com.br`, `paktdoc.com`; apps `winword`, `excel`, `outlook`, `onlyoffice`, `acrobat`, `microsoft word`, `microsoft excel`. Pessoal → `youtube.com`, `instagram.com`, `facebook.com`, `tiktok.com`, `x.com`, `twitter.com`, `netflix.com`, `mercadolivre.com.br`, `shopee.com.br`, `amazon.com.br`, `globo.com`, `uol.com.br`, `ge.globo`; apps `steam`, `spotify`. Neutro explícito → `web.whatsapp.com`, app `whatsapp`. (O PSA Docs entra quando o Pedro informar o domínio, pela tela de regras.)

- [ ] **Step 1: Testes que falham** (`produtividade.test.ts`, `createCaller` com contexto falso e prisma mockado): `admin sem verProdutividade recebe FORBIDDEN`; `usuário com verProdutividade lista a equipe`; `criarSoMonitorado cria usuário sem nenhum módulo`; `gerarCodigo expira em 24 h`; `excluir cargo com pessoas falha`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implementar. **Step 4:** Run → PASS; `npx tsc --noEmit` sem erros novos.
- [ ] **Step 5:** Commit `feat(produtividade): router e regras iniciais`.

---

### Task 6: Telas no Avoce

**Files:**
- Create: `web/src/pages/Produtividade/index.tsx` (abas), `Equipe.tsx`, `Pessoa.tsx`, `Regras.tsx`, `Dispositivos.tsx`
- Modify: `web/src/lib/usePermission.ts` (`AuthUser.verProdutividade?: boolean`), `web/src/components/Layout.tsx` (item `{ to: "/produtividade", label: "Produtividade", icon: Activity, moduloChave: "produtividade" }` no grupo de gestão; o filtro da linha ~272 mostra esse item **só** se `user.verProdutividade === true`), `web/src/App.tsx` (rota `produtividade/*`).

**Interfaces — Consumes:** procedures da Task 5 via `trpc.produtividade.*` (padrão `useQuery`/`useMutation` de `pages/Reunioes.tsx`).

Conteúdo (seguir o visual das páginas existentes, tokens de `web/src/tokens.css`):
- **Equipe:** seletor de dia (◀ ▶) e de período (semana/mês); tabela: nome (cargo), ativo no expediente, ativo fora, início, fim, barra empilhada trabalho/pessoal/neutro, % pessoal; ⚠ quando % pessoal ≥ 25 ou coletor parado ≥ 24 h ("coletor parado há N h"). Clique na linha abre Pessoa.
- **Pessoa:** linha do tempo horizontal 00–24 h com os `blocos` coloridos (pausa cinza, faixa do expediente sombreada); clique no bloco mostra `chave` e `titulos`; três listas de top 10 por categoria.
- **Regras:** tabela filtrável (geral / cargo / pessoa) com criar/editar/excluir; painel "Neutros mais usados" com botões "→ trabalho" / "→ pessoal" que criam regra geral (ou do cargo selecionado); botão "Semear regras iniciais" quando a lista estiver vazia; gestão de cargos.
- **Dispositivos:** pessoas monitoradas com cargo, expediente (editar dias/horas), dispositivos (SO, último envio, versão), os três ✓/✗ de `checks` com dica do que fazer quando ✗ ("instalar extensão no Chrome", "liberar Acessibilidade no Mac"); botões **"Instalar para <nome>"** com escolha Windows/Mac — chama `dispositivos.gerarCodigo` e copia para a área de transferência o comando de uma linha da Task 8 com o código embutido, mostrando-o também na tela com a validade (24 h) — e "Revogar"; "Nova pessoa só monitorada"; marcar usuário existente como monitorado.

- [ ] **Step 1:** Implementar as telas e o menu.
- [ ] **Step 2:** Run `cd web && node_modules/.bin/tsc --noEmit && node_modules/.bin/vite build` → Expected: build OK.
- [ ] **Step 3:** Verificar em `pnpm dev` com um usuário de teste com `verProdutividade=true` e eventos falsos inseridos pela rota de ingest: as quatro abas renderizam; com `verProdutividade=false` o menu some e `/produtividade` mostra "sem permissão".
- [ ] **Step 4:** Commit `feat(produtividade): telas do painel`.

---

### Task 7: Coletor em Go

**Files:**
- Create: `coletor-produtividade/go.mod` (`module avoce/coletor`, só biblioteca padrão), `main.go`, `aw.go`, `envio.go`, `estado.go`, `aw_test.go`, `envio_test.go`, `Makefile`

**Interfaces:**
- Consumes: rotas da Task 3 (`/api/produtividade/parear`, `/api/produtividade/ingest`, formato `LoteIngest`).
- Produces (CLI usado pelos instaladores da Task 8):
  - `coletor parear --url <AVOCE_URL> --codigo <COD> --nome <NOME_PC>` → grava `config.json` `{avoceUrl, token, awUrl:"http://localhost:5600"}` em `os.UserConfigDir()/avoce-coletor/`; sai 0 em sucesso, 1 com mensagem em português em erro.
  - `coletor run` → laço infinito, ciclo a cada 5 min (primeiro ciclo imediato).
  - `coletor versao`.
- Funções: `func mapearBuckets(lista map[string]awBucket) map[string]string /* id → "janela"|"afk"|"web" pelo campo type: currentwindow, afkstatus, web.tab.current */`; `func converter(bucketTipo string, ev awEvento) eventoLote /* janela: data.app, data.title; afk: data.status=="afk"; web: data.url, data.title */`; `func (c *Coletor) ciclo(ctx) error`.

**Comportamento do ciclo:** para cada bucket, `GET {awUrl}/api/0/buckets/{id}/events?start={ultimo − 15 min, RFC3339}&limit=5000` (a sobreposição de 15 min reenvia eventos que cresceram); envia em lotes de até 2000 eventos; só avança `estado.json` (`{ "<bucketId>": "<maior inicio enviado>" }`) depois de 2xx. Primeiro uso sem estado: começa de agora − 24 h. aw-server fora do ar ou Avoce inacessível → loga e tenta no próximo ciclo. 401 → loga "token revogado" e continua tentando a cada ciclo (não apaga config). Sempre manda pelo menos um lote (vazio) por ciclo como sinal de vida. Log em `os.UserConfigDir()/avoce-coletor/coletor.log`, truncado ao passar de 5 MB.

- [ ] **Step 1: Testes que falham** com `httptest.Server` simulando o aw-server e o Avoce:
  - `TestMapearBuckets`: buckets `aw-watcher-window_PC` (type `currentwindow`), `aw-watcher-afk_PC` (`afkstatus`), `aw-watcher-web-chrome_PC` (`web.tab.current`) → `janela`, `afk`, `web`; bucket desconhecido é ignorado.
  - `TestCicloEnviaEAvancaEstado`: 3 eventos → Avoce recebe 3 + estado avança para o maior `timestamp`.
  - `TestFalhaNoAvoceNaoAvancaEstado`: Avoce responde 500 → estado igual ao anterior.
  - `TestDivideEmLotes`: 4500 eventos → 3 POSTs (2000, 2000, 500).
  - `TestSinalDeVida`: sem eventos novos → 1 POST com `eventos: []`.
- [ ] **Step 2:** Run `cd coletor-produtividade && go test ./...` → Expected: FAIL.
- [ ] **Step 3:** Implementar. **Step 4:** Run `go test ./...` → Expected: PASS.
- [ ] **Step 5:** `Makefile` alvo `dist`: `GOOS=windows GOARCH=amd64 go build -ldflags "-H=windowsgui -s -w" -o dist/coletor-windows.exe`, `GOOS=darwin GOARCH=arm64 … -o dist/coletor-mac-arm64`, `GOOS=darwin GOARCH=amd64 … -o dist/coletor-mac-amd64`. Run `make dist` → Expected: 3 arquivos em `dist/`.
- [ ] **Step 6:** Commit `feat(produtividade): coletor ActivityWatch → Avoce`.

---

### Task 8: Instaladores e download dos binários

**Files:**
- Create: `coletor-produtividade/instalar/instalar-mac.sh`, `instalar-windows.ps1`, `LEIA-ME.md`
- Modify: `server/src/index.ts` — `GET /api/produtividade/coletor/:arquivo`, servindo de `process.env.COLETOR_DIST_DIR ?? "/opt/avoce/coletor-dist"` só os nomes `coletor-windows.exe`, `coletor-mac-arm64`, `coletor-mac-amd64`, `instalar-mac.sh`, `instalar-windows.ps1` (outros → 404).

**Interfaces:** os scripts recebem `AVOCE_URL` e `CODIGO` (argumentos), e a tela Dispositivos (Task 6) mostra o comando pronto:
- Mac: `curl -fsSL https://avoce.capium.com.br/api/produtividade/coletor/instalar-mac.sh | bash -s -- https://avoce.capium.com.br <CODIGO>`
- Windows (PowerShell do usuário): `irm https://avoce.capium.com.br/api/produtividade/coletor/instalar-windows.ps1 -OutFile $env:TEMP\i.ps1; powershell -ExecutionPolicy Bypass -File $env:TEMP\i.ps1 https://avoce.capium.com.br <CODIGO>`

Tudo por usuário, sem senha de administrador:
- **Mac:** baixa o `.dmg` do ActivityWatch da release do GitHub, copia `ActivityWatch.app` para `~/Applications`, adiciona como item de login (`osascript … login item`), abre; baixa o coletor certo (`uname -m`), coloca em `~/Library/Application Support/avoce-coletor/`, roda `coletor parear`, cria `~/Library/LaunchAgents/br.com.avoce.coletor.plist` (`RunAtLoad`, `KeepAlive`, `coletor run`) e `launchctl load`. No fim, **abre** `open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"` e a página da extensão na Chrome Web Store (`open -a "Google Chrome" <URL da extensão>`), imprimindo em português uma linha do que clicar em cada uma.
- **Windows:** baixa o `.zip` portátil do ActivityWatch para `%LOCALAPPDATA%\activitywatch`, cria atalho de `aw-qt.exe` na pasta Inicializar do usuário e inicia; baixa `coletor-windows.exe` para `%LOCALAPPDATA%\avoce-coletor`, roda `parear`, cria atalho de `coletor-windows.exe run` na pasta Inicializar e inicia. No fim, **abre** a página da extensão na Chrome Web Store no Chrome (ou Edge, se não houver Chrome) e imprime em português o que clicar.
- Rodar de novo o instalador numa máquina já instalada atualiza os binários sem duplicar atalhos/itens de login.
- Opcional, só se o script estiver rodando como administrador: força a extensão por política do Chrome (Windows: `HKLM\\Software\\Policies\\Google\\Chrome\\ExtensionInstallForcelist`; Mac: perfil/plist gerenciado). Sem admin, pula em silêncio. Verificar no Step 4 se o Chrome respeita a política em máquina fora de domínio; se não respeitar, remover o trecho.
- Sem nenhuma pergunta interativa: tudo vem dos dois argumentos; o nome do PC é o `hostname`.

- [ ] **Step 1:** Antes de fixar URLs, conferir em `https://github.com/ActivityWatch/activitywatch/releases/latest` a versão e os nomes exatos dos assets (`…-macos-x86_64.dmg`, `…-windows-x86_64.zip`) e o ID da extensão "ActivityWatch Web Watcher" na Chrome Web Store, e fixar nos scripts.
- [ ] **Step 2:** Implementar scripts e rota.
- [ ] **Step 3:** Run `bash -n coletor-produtividade/instalar/instalar-mac.sh` → Expected: sem saída. Testar a rota com `curl -I` local → 200 para nome permitido, 404 para `../server/.env`.
- [ ] **Step 4:** Teste real num Mac e num Windows do escritório, usuário comum (sem admin), com o comando copiado do botão "Instalar para…": colar + Enter basta; as telas da extensão/Acessibilidade abrem sozinhas; em até 10 min os três ✓ ficam verdes e a aba Pessoa mostra blocos. Reiniciar a máquina e conferir que volta a enviar sem ninguém mexer.
- [ ] **Step 5:** Commit `feat(produtividade): instaladores Mac/Windows`.

---

### Task 9: Publicação em produção

**Files:** nenhum novo; usa os artefatos das tarefas anteriores.

- [ ] **Step 1:** `pg_dump -Fc` do banco `avoce` no Debian (guardar em `/opt/avoce/backups/`).
- [ ] **Step 2:** Pedir ao Pedro para rodar (com `!`) a aplicação do SQL da Task 1 como `postgres`, mais:
  `UPDATE "Usuario" SET "verProdutividade" = true WHERE nome ILIKE 'Pedro%' OR nome ILIKE 'Luana%' OR nome ILIKE 'Nadine%' RETURNING id, nome, email;` → conferir que voltaram **exatamente** os três sócios (se vier mais alguém, ajustar pelo e-mail antes de confirmar).
- [ ] **Step 3:** Copiar o schema para `/opt/avoce/prisma` e `/opt/avoce/server/prisma`; `npx prisma generate` em `/opt/avoce`.
- [ ] **Step 4:** Build no Mac; antes de enviar, `rsync -rcn --itemize-changes` contra `/opt/avoce/server/dist` e `web/dist`, e `find src -newer dist/index.js` (outra sessão pode ter publicado); `cp -r dist dist_bkp_<data>` no servidor; enviar; `pm2 restart` do Avoce.
- [ ] **Step 5:** `make dist` e enviar `coletor-produtividade/dist/*` + `instalar/*.sh|ps1` para `/opt/avoce/coletor-dist/`.
- [ ] **Step 6:** Verificar: login de um sócio vê "Produtividade"; login de não sócio não vê e recebe FORBIDDEN chamando `produtividade.equipe`; "Semear regras iniciais"; parear uma máquina e ver dados em ≤ 15 min.
