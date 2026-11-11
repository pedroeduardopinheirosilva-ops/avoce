import { useState } from "react";
import { trpc } from "../lib/trpc";
import { RegistrarLigacao } from "./RegistrarLigacao";
import { RegistrarReuniao } from "./RegistrarReuniao";
import { BotaoAgendarReuniao, ReunioesDoLead, dataHoraTxt } from "./AgendarReuniao";

/** Motivos de perda do CRM padrão (planilha da mentoria) — é o motivo que mostra onde o funil vaza. */
export const MOTIVOS_PERDA = [
  "Sem retorno",
  "Sem documentos",
  "Sem aderência jurídica",
  "Preço",
  "Contratou outro profissional",
  "Não deseja prosseguir",
  "Fora da área de atuação",
  "Conflito de interesse",
  "Prescrito",
  "Outro",
];

const ROTULO_ATIVIDADE: Record<string, string> = {
  "ligacao:atendeu": "📞 atendeu",
  "ligacao:nao_atendeu": "📞 não atendeu",
  "ligacao:recusou": "📞 recusou",
  "ligacao:pediu_retorno": "📞 pediu retorno",
  "ligacao:numero_errado": "📞 número errado",
  "reuniao:agendada": "🗓 reunião agendada",
  "reuniao:realizada": "🗓 reunião realizada",
  "reuniao:no_show": "🗓 não compareceu",
  "reuniao:remarcada": "🗓 remarcada",
  "reuniao:cancelada": "🗓 cancelada",
  "encerramento:ganho": "✅ ganho",
  "encerramento:perdido": "❌ perdido",
  "encerramento:aberto": "↩ reaberto",
};

function isoLocal(d: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(d);
}
function maisDias(n: number) {
  return isoLocal(new Date(Date.now() + n * 86400_000));
}

/**
 * Barra da rotina do SDR na conversa: registrar ligação e reunião, marcar o próximo
 * follow-up e encerrar como ganho/perdido (com motivo). Tudo isso alimenta o Funil do SDR
 * no Painel Diário — é o que a SDR anotava à mão no relatório.
 */
export function SdrAcoes({ dealId, status, motivoPerda, proximoContatoEm, onChange }: {
  dealId: string;
  status: string | undefined;
  motivoPerda: string | null | undefined;
  proximoContatoEm: string | null | undefined;
  onChange: () => void;
}) {
  const utils = trpc.useUtils();
  // Refaz a consulta de tempos em tempos: a ligação de WhatsApp detectada sozinha aparece aqui.
  const atividades = trpc.crm.listAtividades.useQuery({ dealId }, { refetchInterval: 20_000 });
  const aposMudar = () => { utils.crm.listAtividades.invalidate({ dealId }); onChange(); };
  const proximo = trpc.crm.definirProximoContato.useMutation({ onSuccess: aposMudar, onError: (e) => alert(e.message) });
  const encerrar = trpc.crm.encerrarDeal.useMutation({ onSuccess: aposMudar, onError: (e) => alert(e.message) });
  const [perdendo, setPerdendo] = useState(false);

  const fu = proximoContatoEm ? isoLocal(new Date(proximoContatoEm)) : "";
  const hoje = isoLocal(new Date());
  const fuClasse = !fu ? "border-amber-300 bg-amber-50" : fu < hoje ? "border-red-300 bg-red-50" : fu === hoje ? "border-indigo-300 bg-indigo-50" : "";
  const aberto = !status || status === "aberto";
  const ultimas = (atividades.data ?? []).slice(0, 3);

  const btn = "text-xs px-2 py-0.5 rounded-md border bg-white hover:bg-gray-50 disabled:opacity-40";

  const reunioes = trpc.reunioes.doLead.useQuery({ dealId }, { refetchInterval: 60_000 });
  const [verReunioes, setVerReunioes] = useState(false);
  const proximaReuniao = (reunioes.data ?? [])
    .filter((r: any) => r.status === "agendada" && r.agendadaPara && new Date(r.agendadaPara).getTime() >= Date.now() - 3600_000)
    .sort((a: any, b: any) => new Date(a.agendadaPara).getTime() - new Date(b.agendadaPara).getTime())[0] as any;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-gray-600 mt-1.5">
      <RegistrarLigacao dealId={dealId} atividades={(atividades.data ?? []) as any} onSalvo={aposMudar} />
      <RegistrarReuniao dealId={dealId} atividades={(atividades.data ?? []) as any} onSalvo={aposMudar} />
      <BotaoAgendarReuniao dealId={dealId} onSalvo={aposMudar} />
      {(reunioes.data?.length ?? 0) > 0 && (
        <button onClick={() => setVerReunioes((v) => !v)}
          className={`text-xs px-2 py-0.5 rounded-md border ${proximaReuniao ? "border-indigo-300 bg-indigo-50 text-indigo-800" : "bg-white text-gray-600"} hover:bg-indigo-100`}
          title="Reuniões do lead: pauta, anotações, remarcar">
          {proximaReuniao
            ? <>🗓 {dataHoraTxt(proximaReuniao.agendadaPara)}{proximaReuniao.responsavelNome ? ` · ${proximaReuniao.responsavelNome.split(" ")[0]}` : ""}</>
            : <>🗓 reuniões ({reunioes.data!.length})</>}
          {verReunioes ? " ▲" : " ▼"}
        </button>
      )}

      {aberto && (
        <span className={`flex items-center gap-1 border rounded-md px-1.5 py-0.5 ${fuClasse}`} title="Próximo follow-up: todo lead ativo precisa de uma data">
          📅
          <input
            type="date"
            value={fu}
            onChange={(e) => proximo.mutate({ dealId, em: e.target.value ? `${e.target.value}T09:00:00-03:00` : null })}
            className="bg-transparent text-xs outline-none"
          />
          {[1, 3, 5, 7, 9].map((n) => (
            <button key={n} className="text-[11px] text-indigo-600 hover:underline" onClick={() => proximo.mutate({ dealId, em: `${maisDias(n)}T09:00:00-03:00` })}>
              D+{n}
            </button>
          ))}
          {fu ? (
            <button className="text-[11px] text-red-600 hover:underline ml-0.5" title="Encerrar follow-up: tira o lead da lista de ligações do dia"
              disabled={proximo.isLoading} onClick={() => proximo.mutate({ dealId, em: null })}>
              ✕ encerrar
            </button>
          ) : <span className="text-amber-700">sem data</span>}
        </span>
      )}

      {aberto ? (
        <span className="flex items-center gap-1">
          <button className={`${btn} text-green-700`} disabled={encerrar.isLoading} onClick={() => confirm("Marcar como GANHO (contrato fechado)?") && encerrar.mutate({ dealId, resultado: "ganho" })}>✅ ganho</button>
          {perdendo ? (
            <select
              autoFocus
              defaultValue=""
              onChange={(e) => { if (e.target.value) { encerrar.mutate({ dealId, resultado: "perdido", motivo: e.target.value }); setPerdendo(false); } }}
              onBlur={() => setPerdendo(false)}
              className="text-xs border rounded-md px-1 py-0.5"
            >
              <option value="" disabled>motivo da perda…</option>
              {MOTIVOS_PERDA.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : (
            <button className={`${btn} text-red-600`} onClick={() => setPerdendo(true)}>❌ perdido</button>
          )}
        </span>
      ) : (
        <span className="flex items-center gap-1">
          <span className={`px-2 py-0.5 rounded-md font-medium ${status === "ganho" ? "bg-green-100 text-green-800" : "bg-red-100 text-red-700"}`}>
            {status === "ganho" ? "✅ Ganho" : `❌ Perdido${motivoPerda ? ` · ${motivoPerda}` : ""}`}
          </span>
          <button className={btn} onClick={() => encerrar.mutate({ dealId, resultado: "aberto" })}>reabrir</button>
        </span>
      )}

      {ultimas.length > 0 && (
        <span className="text-[11px] text-gray-400 truncate max-w-[18rem]" title={ultimas.map((a) => `${new Date(a.criadoEm).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })} ${ROTULO_ATIVIDADE[`${a.tipo}:${a.resultado}`] ?? a.resultado}${(a as any).origem === "automatica" ? " 🤖" : ""}${a.nota ? ` — ${a.nota}` : ""}`).join("\n")}>
          último: {ROTULO_ATIVIDADE[`${ultimas[0].tipo}:${ultimas[0].resultado}`] ?? ultimas[0].resultado} · {new Date(ultimas[0].criadoEm).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}
        </span>
      )}
      {verReunioes && (
        <div className="basis-full mt-1 max-w-xl">
          <ReunioesDoLead dealId={dealId} onChange={aposMudar} />
        </div>
      )}
    </div>
  );
}
