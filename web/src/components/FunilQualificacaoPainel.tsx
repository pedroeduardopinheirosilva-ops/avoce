import { Filter } from "lucide-react";
import { trpc } from "../lib/trpc";

type Contagem = { leads: number; engajou: number; mql: number; qualificado: number; sql: number; cliente: number };

const ETAPAS: { chave: keyof Contagem; rotulo: string; dica: string; cor: string }[] = [
  { chave: "leads",       rotulo: "Lead",        dica: "Contato que chegou ao funil no período",                                 cor: "bg-slate-400" },
  { chave: "engajou",     rotulo: "Engajou",     dica: "Respondeu: mandou 2 ou mais mensagens no WhatsApp",                     cor: "bg-sky-400" },
  { chave: "mql",         rotulo: "MQL",         dica: "Interesse validado: engajou e a conversa confirmou que é carreteiro",   cor: "bg-indigo-500" },
  { chave: "qualificado", rotulo: "Qualificado", dica: "Triagem concluída: entrou em Lead Qualificado ou etapa posterior",       cor: "bg-violet-500" },
  { chave: "sql",         rotulo: "SQL",         dica: "Pronto para reunião: reunião agendada com a advogada",                   cor: "bg-fuchsia-500" },
  { chave: "cliente",     rotulo: "Cliente",     dica: "Assinatura, documentos ou protocolo",                                    cor: "bg-emerald-500" },
];

const FAIXAS: Record<string, { rotulo: string; dica: string; cor: string }> = {
  ideal:     { rotulo: "Persona ideal", dica: "Carreteiro + CLT + no prazo + frota ≥ 30, ≥ 1,5 ano de casa ou pagamento por fora", cor: "text-emerald-700" },
  parcial:   { rotulo: "Parcial",       dica: "Carreteiro confirmado, sem fechar todos os critérios do ideal",                      cor: "text-amber-700" },
  fora:      { rotulo: "Fora",          dica: "Não é carreteiro, sem carteira assinada ou saiu há 2 anos ou mais",                 cor: "text-red-700" },
  sem_dados: { rotulo: "Sem dados",     dica: "A conversa ainda não disse se é carreteiro",                                         cor: "text-gray-400" },
};

const GLOSSARIO: { etapa: string; oque: string; exemplo: string; quem: string }[] = [
  { etapa: "Lead",        oque: "O contato chegou",                                  exemplo: "Clicou no anúncio e mandou “Olá, vi o vídeo de vocês…” (mensagem pronta)", quem: "Ninguém — chega sozinho" },
  { etapa: "Engajou",     oque: "Respondeu de verdade (2+ mensagens)",                exemplo: "“Bom dia, quero saber dos meus direitos”",                                  quem: "O próprio lead" },
  { etapa: "MQL",         oque: "Mostrou interesse E é do nosso público",            exemplo: "“Sou carreteiro, puxo carreta há 3 anos”",                                  quem: "A conversa (o que ele diz)" },
  { etapa: "Qualificado", oque: "Triagem terminou: sabemos se tem caso",              exemplo: "Empresa, carteira assinada, quando saiu e jornada levantados; card em “Lead Qualificado”", quem: "IA ou SDR, no funil" },
  { etapa: "SQL",         oque: "Aceitou falar com a advogada",                       exemplo: "Reunião marcada; card em “Reunião Agendada”",                               quem: "SDR, no funil" },
  { etapa: "Cliente",     oque: "Fechou",                                             exemplo: "Assinou, mandou documentos ou o processo foi protocolado",                  quem: "Equipe, no funil" },
];

function Explicacoes() {
  return (
    <div className="mb-4 space-y-1.5">
      <details className="group rounded-lg border border-gray-100 bg-gray-50/60">
        <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-gray-600 hover:text-gray-900">
          ❓ O que significa cada etapa?
        </summary>
        <div className="px-3 pb-3 text-xs text-gray-600 space-y-2">
          <p>
            É o caminho de um motorista do primeiro contato até virar cliente. Cada degrau é um passo a mais, e quem
            sobe um degrau conta também em todos os anteriores.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-gray-400 border-b border-gray-200">
                  <th className="text-left font-medium py-1 pr-2">Etapa</th>
                  <th className="text-left font-medium py-1 pr-2">O que aconteceu</th>
                  <th className="text-left font-medium py-1 pr-2">Exemplo</th>
                  <th className="text-left font-medium py-1">Quem confirma</th>
                </tr>
              </thead>
              <tbody>
                {GLOSSARIO.map((g) => (
                  <tr key={g.etapa} className="border-b border-gray-100 last:border-0 align-top">
                    <td className="py-1 pr-2 font-semibold text-gray-800 whitespace-nowrap">{g.etapa}</td>
                    <td className="py-1 pr-2">{g.oque}</td>
                    <td className="py-1 pr-2 text-gray-500">{g.exemplo}</td>
                    <td className="py-1 text-gray-500">{g.quem}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            <b>MQL × SQL:</b> MQL = “é motorista e quer conversar”, mas ainda não se sabe se tem caso. SQL = “tem caso e
            marcou reunião”, vale o tempo da advogada.
          </p>
        </div>
      </details>

      <details className="rounded-lg border border-gray-100 bg-gray-50/60">
        <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-gray-600 hover:text-gray-900">
          ❓ O que é a Persona?
        </summary>
        <div className="px-3 pb-3 text-xs text-gray-600 space-y-1.5">
          <p>
            Persona não é um degrau: diz <b>quem</b> é o lead, para comparar se o perfil ideal converte mais que os outros.
          </p>
          <ul className="list-disc pl-4 space-y-0.5">
            <li><b className="text-emerald-700">Ideal:</b> carreteiro, carteira assinada, ainda na empresa ou saiu há menos de 2 anos, e ao menos um agravante — frota de 30+ caminhões, 1,5 ano ou mais de casa, ou pagamento por fora.</li>
            <li><b className="text-amber-700">Parcial:</b> carreteiro confirmado, mas sem fechar todos os critérios do ideal (ou a conversa ainda não disse).</li>
            <li><b className="text-red-700">Fora:</b> não é carreteiro, trabalhou sem carteira ou saiu há 2 anos ou mais.</li>
            <li><b className="text-gray-500">Sem dados:</b> só mandou a mensagem pronta ou não disse a função.</li>
          </ul>
          <p>Vem do que a IA extraiu da conversa; quando a SDR assume, do que o próprio lead escreveu (as mensagens da SDR não contam).</p>
        </div>
      </details>

      <details className="rounded-lg border border-gray-100 bg-gray-50/60">
        <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-gray-600 hover:text-gray-900">
          ❓ Como o período funciona aqui?
        </summary>
        <div className="px-3 pb-3 text-xs text-gray-600 space-y-1.5">
          <p>
            O bloco pega os leads que <b>chegaram</b> no período escolhido no topo do painel e mostra até onde cada um avançou
            <b> até hoje</b> — mesmo que a reunião ou a assinatura tenha sido depois do fim do período.
          </p>
          <p>
            Responde “os leads que chegaram neste período foram bons?”. Por isso períodos recentes sempre parecem converter
            menos: os leads ainda não tiveram tempo de avançar. Para comparar meses, use períodos encerrados há algumas semanas.
          </p>
          <p className="text-gray-500">
            Ex.: período de 01/10 a 31/10. Pedro chegou em 05/10 e marcou reunião em 12/10 → conta como SQL. Ana chegou em
            28/10 e marcou em 02/11 → também conta. João chegou em 25/09 e assinou em 10/10 → não aparece (chegou antes).
          </p>
        </div>
      </details>
    </div>
  );
}

const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

/** 45 → "45 min" · 150 → "2h30" · 3000 → "2d 2h" */
function fmtTempo(m: number | null | undefined): string {
  if (m === null || m === undefined) return "—";
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) { const h = Math.floor(m / 60), r = m % 60; return r ? `${h}h${String(r).padStart(2, "0")}` : `${h}h`; }
  const d = Math.floor(m / 1440), h = Math.round((m % 1440) / 60);
  return h ? `${d}d ${h}h` : `${d}d`;
}

function TabelaConversao({ titulo, linhas }: { titulo: string; linhas: { nome: string; dica?: string; cor?: string; c: Contagem }[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-gray-400 border-b border-gray-100">
            <th className="text-left font-medium py-1.5">{titulo}</th>
            <th className="text-right font-medium py-1.5 px-2">Leads</th>
            <th className="text-right font-medium py-1.5 px-2" title="MQL ÷ leads">MQL</th>
            <th className="text-right font-medium py-1.5 px-2" title="SQL ÷ MQL">SQL</th>
            <th className="text-right font-medium py-1.5 px-2" title="Clientes ÷ SQL">Cliente</th>
            <th className="text-right font-medium py-1.5 pl-2" title="Clientes ÷ leads">Lead→Cliente</th>
          </tr>
        </thead>
        <tbody>
          {linhas.map((l) => (
            <tr key={l.nome} className="border-b border-gray-50 last:border-0">
              <td className={`py-1.5 ${l.cor ?? "text-gray-700"}`} title={l.dica}>{l.nome}</td>
              <td className="py-1.5 px-2 text-right tabular-nums font-semibold text-gray-800">{l.c.leads}</td>
              <td className="py-1.5 px-2 text-right tabular-nums text-gray-700">{l.c.mql} <span className="text-gray-400 text-xs">{pct(l.c.mql, l.c.leads)}</span></td>
              <td className="py-1.5 px-2 text-right tabular-nums text-gray-700">{l.c.sql} <span className="text-gray-400 text-xs">{pct(l.c.sql, l.c.mql)}</span></td>
              <td className="py-1.5 px-2 text-right tabular-nums text-gray-700">{l.c.cliente} <span className="text-gray-400 text-xs">{pct(l.c.cliente, l.c.sql)}</span></td>
              <td className="py-1.5 pl-2 text-right tabular-nums font-medium text-gray-800">{pct(l.c.cliente, l.c.leads)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Funil de qualificação: Lead → Engajou → MQL → Qualificado → SQL → Cliente, montado com as
 * conversas do WhatsApp e as movimentações do funil, e a mesma conversão por Persona (ICP) e
 * por origem. Coorte = leads que ENTRARAM no período; cada marco conta quem chegou até ele.
 */
export function FunilQualificacaoPainel({ de, ate, pipelineIds }: { de: string; ate: string; pipelineIds?: string[] }) {
  const q = trpc.painel.funilQualificacao.useQuery({ de, ate, pipelineIds }, { enabled: !!pipelineIds?.length, keepPreviousData: true });
  const d = q.data;
  const t = d?.totais;
  const comPersona = (d?.persona ?? []).filter((p) => p.faixa !== "sem_dados").reduce((a, p) => a + p.leads, 0);

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <Filter size={16} className="text-gray-400" />
        <h2 className="text-sm font-semibold text-gray-800">Lead → MQL → SQL → Cliente</h2>
        <span className="text-xs text-gray-400">leads que entraram no período · conversa do WhatsApp + etapas do funil</span>
      </div>

      <Explicacoes />

      {q.isLoading ? (
        <p className="text-sm text-gray-400 py-6 text-center">Carregando…</p>
      ) : !t || t.leads === 0 ? (
        <p className="text-sm text-gray-400 py-6 text-center">Nenhum lead no período.</p>
      ) : (
        <>
          <div className="space-y-1.5 mb-4">
            {ETAPAS.map((e, i) => {
              const v = t[e.chave];
              const ant = i > 0 ? t[ETAPAS[i - 1].chave] : null;
              return (
                <div key={e.chave} className="flex items-center gap-3" title={e.dica}>
                  <span className="w-24 shrink-0 text-xs font-medium text-gray-700">{e.rotulo}</span>
                  <div className="flex-1 h-6 bg-gray-50 rounded relative">
                    <div className={`h-6 rounded ${e.cor}`} style={{ width: `${Math.max(v > 0 ? 1.5 : 0, (v / t.leads) * 100)}%` }} />
                    <span className="absolute inset-y-0 left-2 flex items-center text-xs font-semibold text-gray-900 tabular-nums">
                      {v} <span className="ml-1 font-normal text-gray-600">({pct(v, t.leads)} dos leads)</span>
                    </span>
                  </div>
                  <span className="w-28 shrink-0 text-right text-[11px] text-gray-500 tabular-nums">
                    {ant !== null ? `${pct(v, ant)} da etapa anterior` : ""}
                  </span>
                </div>
              );
            })}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
            {[
              ["Lead → MQL", d!.tempos.leadMql, "da entrada até o lead responder confirmando o perfil"],
              ["MQL → SQL", d!.tempos.mqlSql, "do interesse validado até a reunião agendada"],
              ["SQL → Cliente", d!.tempos.sqlCliente, "da reunião agendada até a assinatura/documentos"],
            ].map(([rot, v, dica]) => (
              <div key={rot as string} className="rounded-lg border border-gray-100 bg-gray-50 p-3" title={dica as string}>
                <p className="text-xl font-bold tracking-tight text-gray-800">{fmtTempo(v as number | null)}</p>
                <p className="text-xs text-gray-500 font-medium">Mediana {rot as string}</p>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div>
              <TabelaConversao
                titulo="Persona (ICP)"
                linhas={(d!.persona ?? []).map((p) => ({ nome: FAIXAS[p.faixa].rotulo, dica: FAIXAS[p.faixa].dica, cor: FAIXAS[p.faixa].cor, c: p }))}
              />
              <p className="text-[11px] text-gray-400 mt-1.5">
                Persona identificada em {comPersona} de {t.leads} leads ({pct(comPersona, t.leads)}). Vem do que a IA extraiu da
                conversa e, quando a SDR assume, do que o próprio lead escreveu. “Sem dados” = só mandou a mensagem pronta ou não disse a função.
              </p>
            </div>
            <div>
              <TabelaConversao titulo="Origem" linhas={(d!.origem ?? []).map((o) => ({ nome: o.grupo, c: o }))} />
              <p className="text-[11px] text-gray-400 mt-1.5">Taxas: MQL ÷ leads · SQL ÷ MQL · Cliente ÷ SQL.</p>
            </div>
          </div>
          {(d!.conteudo ?? []).length > 0 && (
            <div className="mt-6">
              <TabelaConversao
                titulo="Orgânico por vídeo / palavra-chave"
                linhas={(d!.conteudo ?? []).map((o) => ({ nome: o.titulo, c: o }))}
              />
              <p className="text-[11px] text-gray-400 mt-1.5">
                Junta o mesmo vídeo em qualquer canal: palavra-chave mandada no WhatsApp ou no Direct, link com ?ref= e comentário no post ou no Live.
                Ordenado por clientes, depois SQL — o vídeo que vira contrato fica no topo, não o que só traz curtida.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
