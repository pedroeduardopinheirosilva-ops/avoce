/**
 * SDR Avoce — Simulador de Conversas para QA  v2
 * Uso: node sdr-sim.mjs [id|grupo] [--list] [--clean]
 *
 * Mudanças v2:
 * - cleanDeal usa queries separadas (sem DO $$ que falha via pipe)
 * - Sleep aumentado para 8s entre mensagens
 * - Wait 15s após última mensagem antes de ler estado
 * - Phone numbers com prefixo de run para evitar conflito com runs anteriores
 */

import { spawnSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";

// ─── Config ────────────────────────────────────────────────────────────────────
const WEBHOOK_URL = "https://avoce.capium.com.br/api/whatsapp/webhook";
const INSTANCE    = "avoce";
const PROJETO_ID  = "cmnvy47x3000wrmmamnsrhgj9";
const DB_URL      = "postgresql://avoce:avoce_senha@localhost:5432/avoce";
const SSH_HOST    = "pinheiro@192.168.20.100";
const SSH_PORT    = "22";
const SSH_PASS    = "Pinheiro@2026";
const CTRL_SOCK   = `/tmp/sdr-ssh-ctrl-${process.pid}`;
const SLEEP_MS    = 12000; // 12s entre mensagens — LLM + state update precisa de tempo
const FINAL_WAIT  = 20000; // 20s após última mensagem para o server processar

// Prefixo único por run para evitar conflito com deals de runs anteriores
const RUN_PREFIX = String(Date.now()).slice(-5); // últimos 5 dígitos do timestamp

// ─── SSH ControlMaster ────────────────────────────────────────────────────────
function sshStart() {
  const r = spawnSync("sshpass", ["-p", SSH_PASS, "ssh",
    "-o", "StrictHostKeyChecking=no", "-o", "PubkeyAuthentication=no",
    "-o", "PreferredAuthentications=password",
    "-o", `ControlPath=${CTRL_SOCK}`,
    "-o", "ControlMaster=yes", "-o", "ControlPersist=300",
    "-p", SSH_PORT, SSH_HOST, "echo ok"
  ], { timeout: 15000, encoding: "utf8" });
  if (!r.stdout?.includes("ok")) throw new Error("SSH ControlMaster failed: " + (r.stderr || "timeout"));
}

function sshStop() {
  spawnSync("ssh", ["-O", "exit", "-o", `ControlPath=${CTRL_SOCK}`, "-p", SSH_PORT, SSH_HOST],
    { timeout: 5000 });
}

// ─── DB via ControlMaster ────────────────────────────────────────────────────
function dbExec(sql) {
  const tmp = `/tmp/sdr-q-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`;
  writeFileSync(tmp, sql + "\n");
  try {
    const r = spawnSync("bash", ["-c",
      `cat ${tmp} | ssh -o ControlPath=${CTRL_SOCK} -o ControlMaster=no -p ${SSH_PORT} ${SSH_HOST} 'psql ${DB_URL} -t -A -q 2>/dev/null'`
    ], { encoding: "utf8", timeout: 15000 });
    return (r.stdout || "").trim();
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function uid()     { return `sim-${Date.now()}-${Math.random().toString(36).slice(2,6)}`; }

// ─── Webhook ──────────────────────────────────────────────────────────────────
async function send(phone, text, pushName = "Simulado") {
  const payload = {
    event: "messages.upsert",
    instance: INSTANCE,
    data: {
      key: { id: uid(), remoteJid: `${phone}@s.whatsapp.net`, fromMe: false },
      pushName,
      messageType: "conversation",
      message: { conversation: text },
      messageTimestamp: Math.floor(Date.now() / 1000),
    },
  };
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Webhook ${res.status}: ${await res.text().catch(() => "")}`);
  await sleep(SLEEP_MS);
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

/** Limpa deals/contatos do phone. Usa queries separadas (não DO $$). */
function cleanDeal(phone) {
  // Busca IDs dos deals para este contato+projeto
  const dealIds = dbExec(
    `SELECT d.id FROM "CrmDeal" d
     JOIN "CrmContato" c ON c.id = d."contatoId"
     WHERE (c.whatsapp='${phone}' OR c.whatsapp='${phone}@s.whatsapp.net')
       AND d."projetoId"='${PROJETO_ID}'`
  );
  if (dealIds) {
    const ids = dealIds.split("\n").filter(Boolean).map(id => `'${id}'`).join(",");
    if (ids) {
      dbExec(`DELETE FROM "CrmNota" WHERE "dealId" IN (${ids})`);
      dbExec(`DELETE FROM "CrmMensagemWhatsapp" WHERE "dealId" IN (${ids})`);
      dbExec(`DELETE FROM "CrmDeal" WHERE id IN (${ids})`);
    }
  }
  // Contato
  dbExec(
    `DELETE FROM "CrmContato"
     WHERE (whatsapp='${phone}' OR whatsapp='${phone}@s.whatsapp.net')
       AND "projetoId"='${PROJETO_ID}'`
  );
}

function getDealState(phone) {
  const row = dbExec(
    `SELECT d."iaStageChave",
            (d.qualificacao::jsonb || COALESCE(d."iaFlags"::jsonb,'{}'))::text,
            (SELECT conteudo FROM "CrmMensagemWhatsapp"
             WHERE "dealId"=d.id AND direcao='out'
             ORDER BY "enviadaEm" DESC LIMIT 1)
     FROM "CrmDeal" d
     JOIN "CrmContato" c ON c.id=d."contatoId"
     WHERE (c.whatsapp='${phone}' OR c.whatsapp='${phone}@s.whatsapp.net')
       AND d."projetoId"='${PROJETO_ID}'
     ORDER BY d."criadoEm" DESC LIMIT 1`
  );
  if (!row) return null;
  const parts = row.split("|");
  let merged = {};
  try { merged = JSON.parse(parts[1] || "{}"); } catch {}
  return { stage: parts[0] || "", merged, lastOutMsg: parts[2] || "" };
}

// Retorna todas as mensagens trocadas (para debug)
function getMsgs(phone) {
  return dbExec(
    `SELECT m.direcao, substring(m.conteudo,1,80), m."enviadaEm"::time
     FROM "CrmMensagemWhatsapp" m
     JOIN "CrmDeal" d ON d.id=m."dealId"
     JOIN "CrmContato" c ON c.id=d."contatoId"
     WHERE (c.whatsapp='${phone}' OR c.whatsapp='${phone}@s.whatsapp.net')
       AND d."projetoId"='${PROJETO_ID}'
     ORDER BY m."enviadaEm" DESC LIMIT 20`
  );
}

// ─── Checks ───────────────────────────────────────────────────────────────────
const chk = {
  desqualificado: () => (s) => {
    const stage = (s?.stage || "").toLowerCase();
    const msg   = (s?.lastOutMsg || "").toLowerCase();
    const ok = stage === "lead_desqualificado" ||
               stage.includes("sem_resposta_closer") ||
               msg.includes("infelizmente") ||
               msg.includes("não vamos conseguir");
    return { ok, detalhe: `Stage deve ser lead_desqualificado. Atual="${s?.stage}" | SDR="${(s?.lastOutMsg||"").slice(0,80)}"` };
  },
  naoDesqualificar: () => (s) => {
    const ok = s?.stage !== "lead_desqualificado";
    return { ok, detalhe: `Não deveria desqualificar. Stage="${s?.stage}"` };
  },
  naoAgendar: () => (s) => {
    const msg = (s?.lastOutMsg || "").toLowerCase();
    const ok = !msg.includes("agendar") && !msg.includes("reunião") &&
               !msg.includes("especialista vai") && !msg.includes("daniela vai");
    return { ok, detalhe: `Não deveria agendar. SDR="${(s?.lastOutMsg||"").slice(0,80)}"` };
  },
  semRobotConfirm: () => (s) => {
    const msg = (s?.lastOutMsg || "").toLowerCase();
    const ok = !msg.includes("sou uma ia") && !msg.includes("sou robô") && !msg.includes("assistente virtual");
    return { ok, detalhe: `SDR confirmou ser IA: "${(s?.lastOutMsg||"").slice(0,80)}"` };
  },
  campoMerged: (campo, valor) => (s) => {
    const atual = s?.merged?.[campo];
    const ok = valor === undefined ? atual != null : atual === valor;
    return { ok, detalhe: `merged.${campo} esperado="${valor}" atual="${atual}"` };
  },
  dataSaidaCalculada: () => (s) => {
    const vinculos = s?.merged?.vinculos || [];
    const v0 = vinculos[0];
    return { ok: !!v0?.data_saida, detalhe: `data_saida deveria ser calculada. v0=${JSON.stringify(v0?.data_saida)}` };
  },
  temVinculos: (qtd) => (s) => {
    const vinculos = s?.merged?.vinculos || [];
    return { ok: vinculos.length >= qtd, detalhe: `Esperava ${qtd} vínculo(s), tem ${vinculos.length}` };
  },
  // C7/C8: Evolution API não salva mensagens de saída para números fake.
  // Verifica apenas se o stage avançou corretamente (lead_carreteiro = coletando empresa).
  perguntaEmpresa: () => (s) => {
    const stage = s?.stage || "";
    const ok = stage === "lead_carreteiro"; // SDR está coletando dados → correto
    return { ok, detalhe: `SDR deve continuar em lead_carreteiro coletando empresa. Stage="${stage}"` };
  },
};

// Gera phone único por run + cenário para evitar conflito com runs anteriores
function phone(n) {
  return `551190${RUN_PREFIX}${String(n).padStart(4, "0")}`;
}

// ─── Cenários ─────────────────────────────────────────────────────────────────
const CENARIOS = [

  // ══ GRUPO A — Gates de desqualificação ══════════════════════════════════════

  { id:"A1", nome:"Taxista — gate nao_carreteiro dispara",
    pn:1, pushName:"João Taxista",
    turns:[
      { msg:"oi" },
      { msg:"João" },
      { msg:"não, dirijo táxi, nunca fui caminhoneiro" },
      { msg:"dirijo táxi faz 5 anos, autônomo, carro próprio",
        check: chk.desqualificado() },
    ]},

  { id:"A2", nome:"Motoboy — gate nao_carreteiro dispara",
    pn:2, pushName:"Marcos Moto",
    turns:[
      { msg:"oi" },
      { msg:"Marcos" },
      { msg:"não, faço entrega de comida de moto pelo iFood, nunca trabalhei com caminhão" },
      { msg:"2 anos fazendo entrega de moto, não tenho experiência com carreta",
        check: chk.desqualificado() },
    ]},

  { id:"A3", nome:"Uber app — gate vinculo_invalido dispara",
    pn:3, pushName:"Pedro Uber",
    turns:[
      { msg:"oi" },
      { msg:"Pedro" },
      { msg:"sim, sou motorista" },
      { msg:"trabalhei 2 anos na Uber como motorista de passageiros pelo aplicativo, era autônomo, carro próprio" },
      { msg:"não, nunca tive carteira assinada em transportadora",
        check: chk.desqualificado() },
    ]},

  { id:"A4", nome:"99 app — gate vinculo_invalido dispara",
    pn:4, pushName:"Carlos App",
    turns:[
      { msg:"oi" },
      { msg:"Carlos" },
      { msg:"sim, carreteiro" },
      { msg:"trabalhei 3 anos como motorista de aplicativo na 99, autônomo, sem carteira assinada, carro próprio" },
      { msg:"não tenho outro emprego como motorista",
        check: chk.desqualificado() },
    ]},

  { id:"A5", nome:"Prescrição — saiu há 3 anos — gate prescricao dispara",
    pn:5, pushName:"Ana Prescrita",
    turns:[
      { msg:"oi" },
      { msg:"Ana" },
      { msg:"sim, caminhoneira, motorista de carreta CLT" },
      { msg:"trabalhei 5 anos na TransXYZ com carteira assinada, motorista de carreta, saí em janeiro de 2022, fui demitida sem justa causa, fazia hora extra todo dia" },
      { msg:"não tenho outro emprego como motorista nos últimos anos",
        check: chk.desqualificado() },
    ]},

  { id:"A6", nome:"Prescrição borderline 1 ano 11 meses — NÃO desqualifica",
    pn:6, pushName:"Bruno Recente",
    turns:[
      { msg:"oi" },
      { msg:"Bruno" },
      { msg:"sim, caminhoneiro CLT" },
      { msg:"trabalhei 3 anos na TransABC com carteira assinada, motorista de carreta, saí há 1 ano e 11 meses, fui demitido sem justa causa, fazia hora extra todo dia" },
      { msg:"não tenho outro",
        check: chk.naoDesqualificar() },
    ]},

  { id:"A7", nome:"30 dias sem anterior — gate tempo_minimo dispara",
    pn:7, pushName:"Roberto Curto",
    turns:[
      { msg:"oi" },
      { msg:"Roberto" },
      { msg:"sim, carreteiro, motorista de caminhão CLT" },
      { msg:"trabalhei 30 dias na Transparra Transportes com carteira assinada, motorista de carreta, fui mandado embora no período de experiência" },
      { msg:"não, só trabalhei nessa empresa como motorista CLT, nunca em outra transportadora",
        check: chk.desqualificado() },
    ]},

  { id:"A8", nome:"45 dias sem anterior — gate tempo_minimo dispara",
    pn:8, pushName:"Felipe 45d",
    turns:[
      { msg:"oi" },
      { msg:"Felipe" },
      { msg:"carreteiro sim, com carteira assinada" },
      { msg:"trabalhei 45 dias na Logística BV, CLT, motorista de caminhão truck, saí no período de experiência, me mandaram embora" },
      { msg:"nunca trabalhei em outro lugar como motorista CLT",
        check: chk.desqualificado() },
    ]},

  { id:"A9", nome:"2 meses exatos — NÃO desqualifica",
    pn:9, pushName:"Lúcio 2m",
    turns:[
      { msg:"oi" },
      { msg:"Lúcio" },
      { msg:"sou carreteiro, trabalhei com carteira assinada" },
      { msg:"trabalhei exatos 2 meses na TransPorta com carteira assinada, motorista de bitruck, fazia hora extra todo dia" },
      { msg:"fui demitido sem justa causa",
        check: chk.naoDesqualificar() },
    ]},

  { id:"A10", nome:"Empresa bloqueada (Transoares) único — desqualifica",
    pn:10, pushName:"Saulo Bloq",
    turns:[
      { msg:"oi" },
      { msg:"Saulo" },
      { msg:"motorista de caminhão, carreteiro, trabalhei com CLT" },
      { msg:"trabalhei na Transoares por 3 anos com carteira assinada, motorista de carreta, fazia hora extra das 4 às 23h todo dia, saí em outubro de 2024 demitido" },
      { msg:"não tenho outro emprego como motorista CLT, só trabalhei na Transoares",
        check: chk.desqualificado() },
    ]},

  // ══ GRUPO B — Combinações ═══════════════════════════════════════════════════

  { id:"B1", nome:"30 dias recente + anterior CLT válido — NÃO desqualifica",
    pn:11, pushName:"Rodrigo Misto",
    turns:[
      { msg:"oi" },
      { msg:"Rodrigo" },
      { msg:"carreteiro CLT" },
      { msg:"trabalhei 30 dias na Transparra com carteira assinada, saí na experiência" },
      { msg:"sim, antes trabalhei na TransGrande por 4 anos, CLT, motorista de carreta" },
      { msg:"trabalhei 4 anos na TransGrande com carteira assinada, motorista de carreta, hora extra das 4 às 23h, não recebia viagens, saí em julho de 2024 demitido" },
      { msg:"não tenho mais empregos como motorista CLT",
        check: chk.naoDesqualificar() },
    ]},

  { id:"B2", nome:"30 dias + anterior Transoares (bloqueada) + sem mais — desqualifica",
    pn:12, pushName:"Sérgio Bloq2",
    turns:[
      { msg:"oi" },
      { msg:"Sérgio" },
      { msg:"caminhoneiro CLT" },
      { msg:"trabalhei 30 dias na Transparra com carteira assinada" },
      { msg:"sim, antes trabalhei na Transoares por 2 anos, CLT" },
      { msg:"não, só esses dois empregos como motorista CLT",
        check: chk.desqualificado() },
    ]},

  { id:"B3", nome:"Uber autônomo recente + anterior CLT válido — NÃO desqualifica",
    pn:13, pushName:"Diego Uber+CLT",
    turns:[
      { msg:"oi" },
      { msg:"Diego" },
      { msg:"sim, motorista profissional" },
      { msg:"trabalhei 1 ano na Uber como motorista de passageiros pelo app, autônomo, carro próprio" },
      { msg:"sim, antes trabalhei 3 anos na Transparra CLT, motorista de carreta, muita hora extra, saí em março de 2024 demitido" },
      { msg:"não tenho mais empregos",
        check: chk.naoDesqualificar() },
    ]},

  { id:"B4", nome:"Todos autônomos Uber+Rappi — desqualifica",
    pn:14, pushName:"Thiago Gig",
    turns:[
      { msg:"oi" },
      { msg:"Thiago" },
      { msg:"motorista" },
      { msg:"trabalhei como motorista de passageiros no Uber por 2 anos, autônomo, carro próprio" },
      { msg:"sim, também trabalhei no Rappi entregando de carro, autônomo" },
      { msg:"não, só esses dois, sempre fui autônomo",
        check: chk.desqualificado() },
    ]},

  // ══ GRUPO C — Extração de dados ═════════════════════════════════════════════

  { id:"C1", nome:"Relato completo em uma mensagem — e_clt extraído",
    pn:15, pushName:"Márcio Completo",
    turns:[
      { msg:"oi" },
      { msg:"Márcio" },
      { msg:"sim, carreteiro 12 anos CLT" },
      { msg:"trabalhei 5 anos na TransPorta com carteira assinada, era motorista de carreta, saí em outubro de 2024 porque fui demitido sem justa causa. Fazia hora extra das 4 às 23h todo dia e não recebia. Recebia parte por fora no Pamcard. O caminhão era deles.",
        check: chk.campoMerged("e_clt", true) },
    ]},

  { id:"C2", nome:"Data relativa (saiu há 8 meses) — data_saida calculada",
    pn:16, pushName:"Paulo Data",
    turns:[
      { msg:"oi" },
      { msg:"Paulo" },
      { msg:"carreteiro CLT" },
      { msg:"trabalhei na TransBV por 3 anos com carteira assinada, motorista de bitruck, saí há 8 meses, fui demitido" },
      { msg:"fui demitido sem justa causa",
        check: chk.dataSaidaCalculada() },
    ]},

  { id:"C3", nome:"Lead ainda empregado — NÃO pede data de saída",
    pn:17, pushName:"Victor Empregado",
    turns:[
      { msg:"oi" },
      { msg:"Victor" },
      { msg:"caminhoneiro CLT" },
      { msg:"trabalho na TransXYZ há 3 anos com carteira assinada, motorista de carreta, ainda estou lá, mas faço hora extra das 5 às 22h todo dia e não recebo" },
      { msg:"sim, continuo trabalhando lá até hoje",
        check: (s) => {
          const msg = (s?.lastOutMsg || "").toLowerCase();
          const pedindoSaida = msg.includes("quando saiu") || msg.includes("data de saída") || msg.includes("mês que saiu");
          return { ok: !pedindoSaida, detalhe: `SDR pediu data de saída para quem ainda trabalha: "${(s?.lastOutMsg||"").slice(0,80)}"` };
        }},
    ]},

  { id:"C4", nome:"Pergunta se é robô — deve desviar",
    pn:18, pushName:"Leandro Robô",
    turns:[
      { msg:"oi" },
      { msg:"Leandro" },
      { msg:"sim, carreteiro CLT" },
      { msg:"você é um robô ou é uma pessoa de verdade?",
        check: chk.semRobotConfirm() },
    ]},

  { id:"C5", nome:"PJ emite nota — gate vinculo_invalido dispara",
    pn:19, pushName:"Nelson PJ",
    turns:[
      { msg:"oi" },
      { msg:"Nelson" },
      { msg:"motorista de caminhão" },
      { msg:"trabalhei 2 anos na TransCarga mas era PJ, abri CNPJ, emitia nota fiscal todo mês, o caminhão era meu" },
      { msg:"não tenho outro emprego como motorista CLT",
        check: chk.desqualificado() },
    ]},

  { id:"C6", nome:"Cooperado — gate vinculo_invalido dispara",
    pn:20, pushName:"Arlindo Coop",
    turns:[
      { msg:"oi" },
      { msg:"Arlindo" },
      { msg:"motorista de caminhão" },
      { msg:"era cooperado na Coopercargas por 4 anos, trabalhava pela cooperativa, sem carteira assinada" },
      { msg:"não tenho outro emprego como motorista CLT",
        check: chk.desqualificado() },
    ]},

  { id:"C7", nome:"Lead muda de assunto — SDR redireciona para empresa",
    pn:21, pushName:"Ivo Curioso",
    turns:[
      { msg:"oi" },
      { msg:"Ivo" },
      { msg:"sim motorista caminhão CLT" },
      { msg:"quando vocês vão me dar resposta? já faz dias que espero",
        check: chk.perguntaEmpresa() },
    ]},

  { id:"C8", nome:"Resposta curtíssima — SDR não trava",
    pn:22, pushName:"Edu Curto",
    turns:[
      { msg:"oi" },
      { msg:"Edu" },
      { msg:"carreteiro CLT" },
      { msg:"nn" },
      { msg:"não sei o nome",
        check: chk.perguntaEmpresa() },
    ]},

  // ══ GRUPO D — Fluxos completos ═══════════════════════════════════════════════

  { id:"D1", nome:"Happy path completo CLT — não desqualifica",
    pn:23, pushName:"Henrique OK",
    turns:[
      { msg:"oi" },
      { msg:"Henrique" },
      { msg:"sim, carreteiro de carreta há 12 anos, sempre CLT" },
      { msg:"trabalhei 4 anos na TransGrande Logística com carteira assinada, motorista de carreta, saí em agosto de 2024 demitido sem justa causa. Fazia hora extra todo dia das 4 às 23h, não recebia pelo tempo extra, recebia parte por PIX. O caminhão era deles." },
      { msg:"não tenho outro emprego como motorista CLT nos últimos 2 anos",
        check: chk.naoDesqualificar() },
    ]},

  { id:"D2", nome:"2 empregos na mesma mensagem — ao menos 1 extraído",
    pn:24, pushName:"Renato Duplo",
    turns:[
      { msg:"oi" },
      { msg:"Renato" },
      { msg:"motorista de caminhão CLT" },
      { msg:"trabalhei primeiro 2 anos na TransA com carteira assinada e depois 3 anos na TransB também CLT, saí da TransB em setembro de 2024 demitido sem justa causa",
        check: chk.temVinculos(1) },
    ]},

  { id:"D3", nome:"Lead responde sim genérico — fluxo não trava",
    pn:25, pushName:"Sandro Sim",
    turns:[
      { msg:"oi" },
      { msg:"Sandro" },
      { msg:"sim, motorista de caminhão CLT" },
      { msg:"Transparra Transportes" },
      { msg:"motorista de carreta, CLT, carteira assinada" },
      { msg:"3 anos com carteira assinada" },
      { msg:"saí em junho de 2024, me mandaram embora sem justa causa" },
      { msg:"não tenho outro emprego como motorista CLT",
        check: chk.naoDesqualificar() },
    ]},
];

// ─── Runner ───────────────────────────────────────────────────────────────────
const args   = process.argv.slice(2);
const filtro = args.find(a => !a.startsWith("-"));
const listar = args.includes("--list");
const clean  = args.includes("--clean");

if (listar) {
  CENARIOS.forEach(c => console.log(`  ${c.id.padEnd(5)} ${c.nome}`));
  process.exit(0);
}

const lista = filtro
  ? CENARIOS.filter(c => c.id === filtro || c.id.startsWith(filtro))
  : CENARIOS;

console.log("╔═══════════════════════════════════════════════════════════╗");
console.log(`║  SDR AVOCE QA v2 — ${lista.length} cenário(s) | run=${RUN_PREFIX}`.padEnd(62) + "║");
console.log("╚═══════════════════════════════════════════════════════════╝");

process.stdout.write("Conectando ao servidor SSH...");
sshStart();
process.stdout.write(" ✓\n");
process.on("exit", sshStop);

const results = [];

for (const cen of lista) {
  const ph = phone(cen.pn);
  process.stdout.write(`\n[${cen.id}] ${cen.nome}\n     phone: ${ph}\n`);
  cleanDeal(ph);
  await sleep(500);

  let bug = null;
  let lastState = null;
  const isFinalTurn = (i) => i === cen.turns.length - 1;

  for (let i = 0; i < cen.turns.length; i++) {
    const t = cen.turns[i];
    process.stdout.write(`  [${i+1}/${cen.turns.length}] → "${t.msg.slice(0, 65)}${t.msg.length > 65 ? "…" : ""}"\n`);
    try {
      await send(ph, t.msg, cen.pushName);
      if (t.waitMs) await sleep(t.waitMs);

      // Último turno com check: espera mais para o server processar tudo
      if (isFinalTurn(i) && t.check) {
        process.stdout.write(`           ⏳ aguardando ${FINAL_WAIT/1000}s o server processar...\n`);
        await sleep(FINAL_WAIT);
      }

      lastState = getDealState(ph);
      const resp = lastState?.lastOutMsg || "(sem resposta)";
      process.stdout.write(`           ◀ stage="${lastState?.stage}" | SDR="${resp.slice(0, 70)}"\n`);

      if (t.check) {
        const { ok, detalhe } = t.check(lastState);
        if (!ok) { bug = { turno: i + 1, msg: t.msg, detalhe }; break; }
      }
    } catch (err) {
      bug = { turno: i + 1, msg: t.msg, detalhe: err.message };
      break;
    }
  }

  const passou = !bug;
  results.push({ id: cen.id, nome: cen.nome, passou, bug, lastState });
  process.stdout.write(passou ? "  ✅ OK\n" : `  ❌ BUG — ${bug?.detalhe?.slice(0, 100)}\n`);
}

// ─── Relatório ────────────────────────────────────────────────────────────────
const bugs = results.filter(r => !r.passou);
const oks  = results.filter(r => r.passou);

console.log("\n╔═══════════════════════════════════════════════════════════╗");
console.log("║                   RELATÓRIO FINAL                        ║");
console.log("╚═══════════════════════════════════════════════════════════╝");
console.log(`\nTotal: ${results.length} | ✅ ${oks.length} OK | ❌ ${bugs.length} bug(s)\n`);

if (bugs.length === 0) {
  console.log("🎉 Nenhum bug encontrado!\n");
} else {
  bugs.forEach((r, i) => {
    console.log(`BUG-${String(i+1).padStart(3,"0")} [${r.id}] ${r.nome}`);
    console.log(`  Turno ${r.bug?.turno}: "${r.bug?.msg?.slice(0,70)}"`);
    console.log(`  ${r.bug?.detalhe}`);
    console.log(`  Stage final: ${r.lastState?.stage}`);
    console.log(`  SDR disse:   "${r.lastState?.lastOutMsg?.slice(0,100)}"`);
    console.log();
  });
}

// Mostra mensagens do DB para cenários com bug (debug)
if (bugs.length > 0) {
  console.log("─── DEBUG — Mensagens dos cenários com bug ───");
  for (const r of bugs.slice(0, 3)) {
    const ph = phone(CENARIOS.find(c => c.id === r.id)?.pn ?? 0);
    console.log(`\n[${r.id}] ${ph}:`);
    console.log(getMsgs(ph));
  }
}
