# Plano — Ajustes no Avoce: Financeiro gerencial + Funil de Acordos

Origem: `~/Downloads/AJUSTES NO AVOCE.docx` (12/11/2026). Este arquivo é o contrato entre as fases
de execução. Numeração `§1.x / §2.x` = itens do documento.

## Regras para quem executa

- Fonte em `~/NfseCapium` (branch `feature/sdr-refactor-funil-completo`). **Não** fazer commit, stash,
  reset, checkout nem deploy. **Não** rodar `prisma db push`/`migrate` contra banco nenhum — só
  `npx prisma generate` e `npx prisma validate` locais (em `server/`).
- Mudanças **aditivas**. Não renomear nem remover coluna/modelo/rota existente. Colunas novas em
  modelos existentes: opcionais ou com `@default`.
- Arquivos compartilhados (`schema.prisma`, `routers/index.ts`, `cron.ts`, `index.ts`, `App.tsx`,
  `Layout.tsx`, `permission-constants.ts`): só inserções pequenas e localizadas; outro agente pode
  estar editando o mesmo arquivo em paralelo — reler antes de editar, nunca reescrever o arquivo.
- Seguir os padrões do código vizinho (tRPC `authProc`, `tenant-utils`, Tailwind, páginas em
  `web/src/pages/Financeiro/`). Textos de UI em português. Dinheiro em `Decimal`; cálculo em
  centavos inteiros ou `Prisma.Decimal`, nunca float acumulado.
- Datas de competência/vencimento são datas-calendário (fuso America/Bahia): cuidado com `new Date("YYYY-MM-DD")` em UTC.
- Verificação obrigatória antes de concluir: `server/node_modules/.bin/tsc -p server/tsconfig.json --noEmit`,
  `cd server && npx vitest run` (os testes novos + os existentes), e, para web,
  `cd web && npx tsc -b && node_modules/.bin/vite build`. Relatar a saída real, inclusive falhas.
- Sem dependência nova no **server** (o servidor recebe só o `dist`). No web pode (vai no bundle).

## Decisões de desenho

1. **Escopo**: tudo do financeiro é por `emitenteId` (`EmpresaEmitente`), como o `Lancamento` atual;
   acesso via `whereEmitenteFilter` / `assertEmitenteAccess`.
2. **Processo = `CrmDeal`** (funil `tipo: "processual"`). Empresa ré = `CrmVinculoEmprego` principal do
   deal / `deal.organizacao` (conferir o que `routers/audiencia.ts` usa para `{empresa}` e reutilizar).
3. **Parcela de acordo = `FinRecebimento`** com `acordoId` + `parcelaNumero`. Um só modelo para
   recebimento avulso (execução/sentença) e parcela de acordo; cada linha carrega seu repasse e sua NF.
4. **Valores de terceiros**: receita do escritório = `valorHonorarios + valorSucumbencia`. O repasse ao
   cliente nunca entra em receita/DRE; repasse pendente aparece como passivo "Valores de terceiros" e é
   abatido do "caixa disponível".
5. **Selic**: tabela `FinIndiceMensal` (global). Importação automática do BCB/SGS — série **4390**
   (Selic acumulada no mês, % a.m.) e **4391** (CDI acumulado no mês) em
   `https://api.bcb.gov.br/dados/serie/bcdata.sgs.{serie}/dados?formato=json&dataInicial=dd/mm/aaaa&dataFinal=dd/mm/aaaa`
   — cron diário + botão "Importar agora" + edição manual (`origem: manual` não é sobrescrita pelo cron).
   Mês sem taxa publicada: projeção usa a última taxa conhecida e marca como "projetado".
6. **Empréstimo PSA** (§1.2): cada aporte é corrigido separadamente a partir da própria data.
   No mês de entrada, pro rata por dias corridos: `fator = (1+selic_mes)^(dias_restantes/dias_do_mês)`;
   meses cheios: `1+selic_mes`. Amortização/devolução abate o saldo dos aportes mais antigos primeiro
   (FIFO), na data. Extrato mensal: saldo anterior, aportes, correção, amortizações, saldo atual.
7. **Empréstimo bancário** (§1.3): juros do mês `= (1+selic_mes) × 1,06^(1/12) − 1` (spread parametrizável).
   Carência: `juros_pagos` (saldo constante, juros viram saída de caixa mensal) ou `capitalizados`
   (somam ao saldo). Após carência: SAC ou Price sobre o saldo do fim da carência, `numParcelas`;
   Price recalcula a prestação a cada mês com a taxa do mês e o prazo remanescente. Meses passados usam
   Selic real; futuros, projetada. IOF e tarifas entram como custo na contratação.
8. **Aplicação** (§1.4): movimentos `aplicacao | resgate | rendimento | ir`. Rendimento mensal
   sugerido = saldo × (Selic ou %CDI do mês), editável. Resgate exige `fonteId` (default: fonte do
   empréstimo bancário). Custo líquido do empréstimo = juros incorridos − rendimento líquido de IR.
9. **Permissões** (§1.9): módulo `financeiro` continua liberando leitura; novo módulo
   `financeiro_editar` é exigido nas mutações do financeiro gerencial (permissões `null` = acesso
   total, como hoje). Novo módulo `acordos` para o funil. Toda mutação grava `FinAuditLog` (antes/depois).
10. **Exportação**: Excel gerado no navegador (`exceljs`, import dinâmico); PDF por impressão da própria
    tela (CSS `@media print`). Nada novo no server.
11. **Funil de acordo não mexe no funil processual**: o `Acordo` é um registro paralelo ao deal;
    `stageId`, `proximoPrazo` e audiência do deal não são tocados (§2.2 "prazos não podem ser afetados").
    "Encerrado por acordo" = `Acordo.status = "homologado"` + `deal.valorAcordo` preenchido; mover o card
    de coluna é ação opcional do usuário na homologação.

## Modelo de dados (adicionar em `server/prisma/schema.prisma`)

Campos de valor `Decimal @db.Decimal(14,2)`; taxas `Decimal @db.Decimal(12,8)`. Todos com `id cuid`,
`criadoEm`, e `atualizadoEm @updatedAt` onde fizer sentido. Índices por `emitenteId` e datas.

- **`Lancamento`** (existente) + `competencia DateTime?`, `fornecedor String?`, `formaPagamento String?`,
  `comprovantePath String?`, `comprovanteNome String?`, `recorrente Boolean @default(false)`,
  `recorrenciaFimEm DateTime?`, `recorrenciaOrigemId String?`, `criadoPorId String?`, relação `fontes FinLancamentoFonte[]`.
- **`FinFonte`**: `emitenteId, nome, tipo (emprestimo_psa | emprestimo_bancario | receita_propria | outra), ativo, ordem`.
  Semeadas sob demanda (primeiro acesso do emitente): "Empréstimo PSA", "Empréstimo bancário", "Receita própria (honorários)".
- **`FinLancamentoFonte`**: `lancamentoId (cascade), fonteId, valor, percentual Decimal(7,4)?` — soma dos valores = valor do lançamento.
- **`FinOrcamento`**: `emitenteId, categoria, ano, mes, valor` · `@@unique([emitenteId, categoria, ano, mes])`.
- **`FinIndiceMensal`**: `indice (selic | cdi), ano, mes, taxa (% a.m.), origem (bcb | manual)` · `@@unique([indice, ano, mes])`.
- **`FinEmprestimo`**: `emitenteId, fonteId?, tipo (psa | bancario), nome, dataContratacao, valor?, carenciaMeses @default(0),
  spreadAnual Decimal(7,4) @default(6), numParcelas?, sistema (sac | price)?, carenciaModo (juros_pagos | capitalizados)?,
  iof?, tarifas?, ativo, obs`.
- **`FinEmprestimoMov`**: `emprestimoId (cascade), tipo (saldo_inicial | aporte | amortizacao | devolucao | pagamento_juros | pagamento_parcela),
  data, valor, previsto Boolean @default(false), obs, criadoPorId`. (`previsto` = aporte futuro da PSA para a projeção.)
- **`FinAplicacao`**: `emitenteId, nome, produto?, indexador (selic | cdi), percentualIndexador Decimal(7,2) @default(100), ativo`.
- **`FinAplicacaoMov`**: `aplicacaoId (cascade), tipo (aplicacao | resgate | rendimento | ir), data, valor, fonteId?, obs, criadoPorId`.
- **`Acordo`**: `dealId, emitenteId?, tipo (previo | posterior), status (em_negociacao | firmado | aguardando_homologacao | homologado | sem_acordo),
  motivo, faseOrigem (previo | pos_contestacao | pos_replica | pos_pericia | pos_sentenca | recursal | execucao),
  responsavelId?, contatoEmpresaNome?, contatoEmpresaPapel? (preposto | advogado), contatoEmpresaFone?,
  estimativaCondenacao?, valorMinimoAutorizado?, autorizacaoRegistro?, autorizacaoAnexoPath?, autorizacaoAnexoNome?,
  proximoFollowupEm?, motivoSaida? (empresa_recusou | abaixo_minimo | cliente_recusou | sem_resposta), obsSaida?,
  valorAcordo?, percHonorarios Decimal(5,2)?, multaInadimplemento?, multaTipo? (percentual | valor),
  enviadoExecucaoEm?, firmadoEm?, homologadoEm?, encerradoEm?, criadoPorId?` · relações `deal`, `rodadas`, `recebimentos`.
  Um deal pode ter vários `Acordo` ao longo do tempo (histórico), no máximo um em aberto.
- **`AcordoRodada`**: `acordoId (cascade), data, autor (escritorio | empresa), valor, obs, criadoPorId`.
- **`AcordoAvaliacao`** (tarefa §2.1): `dealId @unique, responsavelId?, prazoEm?, decisao? (tentar | nao_tentar), justificativa?,
  decididoEm?, decididoPorId?, acordoId?`.
- **`FinRecebimento`**: `emitenteId, dealId?, acordoId?, parcelaNumero?, tipo (acordo | execucao), descricao?,
  vencimento?, valorPrevisto?, dataRecebimento?, valorBruto?, percHonorarios Decimal(5,2)?, valorHonorarios?,
  valorSucumbencia @default(0), valorRepasse?, comprovantePath/Nome?,
  repasseStatus (pendente | realizado | nao_aplicavel) @default("pendente"), repasseData?, repasseComprovantePath/Nome?,
  nfStatus (a_emitir | emitida | nao_aplicavel) @default("a_emitir"), nfValor?, nfNumero?, nfData?, nfAnexoPath/Nome?, notaFiscalId?,
  obs, criadoPorId`. Status derivado: `recebida` (tem `dataRecebimento`), `em_atraso` (vencida sem receber), `prevista`.
- **`FinAuditLog`**: `emitenteId?, entidade, entidadeId, acao (criar | atualizar | excluir), usuarioId?, antes Json?, depois Json?, criadoEm`.
- `CrmDeal` + relações inversas (`acordos`, `acordoAvaliacao`, `recebimentos`) e `ajuizadoEm DateTime?`
  (data do protocolo; base do "tempo até o acordo/recebimento").

Categorias de despesa (§1.5), em `financeiro.ts`: Folha, Comissões, Estrutura, Sistemas, Marketing,
Consultorias, Tributos, Despesas processuais, Outros — mantendo as antigas aceitas na leitura.

## Fases de execução

### Fase 1 — Schema + núcleo de cálculo (1 agente)
- Schema acima + `prisma validate` + `prisma generate`.
- `server/src/lib/fin/` — funções **puras** com testes vitest (`*.test.ts`), sem Prisma:
  `indices.ts` (parse do SGS, taxa do mês, projeção), `emprestimo-psa.ts` (extrato mensal por aporte, FIFO),
  `emprestimo-bancario.ts` (carência nas duas modalidades, SAC/Price, cronograma real+projetado),
  `aplicacao.ts` (saldo, rendimento sugerido, custo líquido), `acordo-parcelas.ts` (gera parcelas; soma exata ao valor do acordo;
  honorários/repasse por parcela), `recebimento.ts` (honorários, repasse, status derivado).

### Fase 2 — Server (2 agentes em paralelo)
- **2A · `routers/finGerencial.ts`** (`appRouter.fin`): fontes; despesas com rateio (estender `financeiro.criar/atualizar`
  sem quebrar a tela atual), recorrência, orçamento e orçado×realizado; índices (CRUD + importação BCB + cron diário);
  empréstimos PSA/bancário (CRUD, movimentos, extrato, cronograma); aplicações; fluxo de caixa realizado+projetado 12–24 meses;
  DRE mensal por categoria; consumo por fonte × categoria; painel (saldo devedor PSA, banco, aplicado, caixa disponível);
  audit log; endpoints REST de upload/download de comprovante (padrão de `/api/deal-anexos`, com checagem de acesso ao emitente).
- **2B · `routers/acordos.ts`** (`appRouter.acordos`) + `routers/recebimentos.ts` (`appRouter.recebimentos`): avaliação prévia
  (gera tarefa quando o deal é ajuizado — ver gatilho abaixo; decisão obrigatória com justificativa); abrir tentativa de acordo
  em qualquer fase; rodadas; follow-up; saídas (retorno com motivo / firmado → aguardando homologação → homologado);
  homologação gera as parcelas em `FinRecebimento`; recebimentos (acordo e execução), baixa de parcela, repasse, NF;
  alertas (parcela vencida, repasse pendente há X dias, recebimento sem NF, follow-up de acordo vencido, avaliação prévia sem decisão)
  como query `alertas` + envio no cron pelo canal de notificação interno já existente (se houver; senão só a query);
  indicadores §2.4 (conversão prévio×posterior, acordo/valor da causa, acordo/estimativa, fase, tempo médio, inadimplência,
  tudo também por empresa ré) e receita por tipo com ticket médio e tempo ajuizamento→recebimento (§1.9);
  excluir deals com acordo homologado do % de êxito e das métricas de condenação/valor da causa onde hoje são calculados
  (procurar em `routers/painel.ts` e afins).
  Gatilho §2.1: deal entra numa coluna de "ajuizado" do funil processual (chave contendo `ajuizado`) ou recebe `numeroCnj`
  pela primeira vez → cria `AcordoAvaliacao` (idempotente por `dealId`), `responsavelId` = quem redigiu a inicial
  (investigar o melhor campo existente; fallback `deal.responsavelId`), `prazoEm` = 5 dias antes de `audienciaEm`, ou protocolo + 10 dias.

### Fase 3 — Web (2 agentes em paralelo)
- **3A · Financeiro**: menu Financeiro ganha Painel, Despesas (form com fonte/rateio, competência, fornecedor, forma de pagamento,
  comprovante, recorrente), Orçado × Realizado, Fontes, Empréstimo PSA (extrato), Empréstimo bancário (parâmetros + cronograma),
  Aplicações, Índices (Selic/CDI), Fluxo de caixa projetado, DRE, Consumo por fonte, Log de alterações; exportar Excel/PDF nas tabelas.
- **3B · Acordos e Receitas**: página Acordos (quadro por status, tarefas de avaliação prévia pendentes, follow-ups), botão
  "Tentar acordo" + seção "Acordo" no modal do deal (`Crm.tsx`), detalhe da negociação (rodadas, autorização, saídas, homologação com
  gerador de parcelas), página Recebimentos (acordo × execução, parcelas, repasse, NF, alertas, valores de terceiros),
  Indicadores de acordo (geral e por empresa ré).

### Fase 4 — Verificação (orquestrador)
Build server + web, vitest, revisão do diff, e só então perguntar ao Pedro sobre deploy
(`prisma db push` aditivo + dist), seguindo as regras de troca segura de arquivo em produção.
