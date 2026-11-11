import { useEffect, useRef, useState } from "react";
import { trpc } from "../lib/trpc";
import { AgendarReuniaoModal } from "./AgendarReuniao";

export type Atividade = {
  id: string; tipo: string; resultado: string; nota: string | null; canal: string | null;
  direcao: string | null; duracaoSeg: number | null; origem: string; criadoEm: string;
};

const RESULTADOS: { v: "atendeu" | "nao_atendeu" | "recusou" | "pediu_retorno" | "numero_errado"; rotulo: string; cor: string }[] = [
  { v: "atendeu", rotulo: "Atendeu", cor: "bg-green-600" },
  { v: "nao_atendeu", rotulo: "Não atendeu", cor: "bg-gray-600" },
  { v: "recusou", rotulo: "Recusou", cor: "bg-orange-600" },
  { v: "pediu_retorno", rotulo: "Pediu p/ ligar depois", cor: "bg-indigo-600" },
  { v: "numero_errado", rotulo: "Número errado", cor: "bg-red-600" },
];

export function isoLocal(d: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(d);
}
/** Date → "YYYY-MM-DDTHH:mm" no relógio de São Paulo (valor de <input type="datetime-local">). */
export function dataHoraLocal(d: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
export const hora = (s: string) => new Date(s).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
export const durTxt = (s: number | null) => (s == null ? "" : s < 60 ? `${s}s` : `${Math.round(s / 60)} min`);

/**
 * Registro da ligação feita FORA do VoIP — a SDR liga pelo WhatsApp desktop do número da
 * Isabella. Se o Avoce detectou a chamada sozinho (evento CALL do WhatsApp), o formulário
 * completa aquela ligação em vez de criar outra.
 */
export function RegistrarLigacao({ dealId, atividades, onSalvo, modoBaixa = false, rotulo, alinharDireita = false }: {
  dealId: string;
  atividades: Atividade[];
  onSalvo: () => void;
  /** Aberto pela lista de follow-ups: exige escolher o próximo passo (nova data ou encerrar). */
  modoBaixa?: boolean;
  rotulo?: string;
  alinharDireita?: boolean;
}) {
  const [aberto, setAberto] = useState(false);
  const [resultado, setResultado] = useState<(typeof RESULTADOS)[number]["v"] | null>(null);
  const [canal, setCanal] = useState<"whatsapp" | "celular" | "voip">("whatsapp");
  const [direcao, setDirecao] = useState<"saida" | "entrada">("saida");
  const [duracao, setDuracao] = useState("");
  const [nota, setNota] = useState("");
  // n = D+n · -1 = encerrar follow-up (tira o lead da lista) · null = não mexer
  const [followup, setFollowup] = useState<number | null>(null);
  const [agendou, setAgendou] = useState(false);
  // Reunião combinada na ligação: abre o agendamento (data, quem conduz, pauta) em vez de
  // registrar só uma atividade sem data, que não aparecia na agenda.
  const [agendarAgora, setAgendarAgora] = useState(false);
  const [quando, setQuando] = useState("");
  // Quem faz o próximo follow-up; null = a sugestão (quem registra, se for SDR; senão a SDR padrão)
  const [responsavel, setResponsavel] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const registrar = trpc.crm.registrarAtividade.useMutation();
  const proximo = trpc.crm.definirProximoContato.useMutation();
  const resp = trpc.crm.responsaveisFollowup.useQuery({ dealId }, { enabled: aberto, staleTime: 60_000 });
  const responsavelFinal = responsavel ?? resp.data?.sugerido ?? undefined;

  // Ligação detectada automaticamente nas últimas 3h e ainda sem resumo → completar ela.
  const detectada = atividades.find(
    (a) => a.tipo === "ligacao" && a.origem === "automatica" && !a.nota && Date.now() - new Date(a.criadoEm).getTime() < 3 * 3600_000,
  );

  useEffect(() => {
    if (!aberto) return;
    // Data/hora já vem preenchida (a da chamada detectada, ou agora); a SDR pode corrigir.
    setQuando(dataHoraLocal(detectada ? new Date(detectada.criadoEm) : new Date()));
    if (detectada) {
      setResultado(detectada.resultado as any);
      setDirecao((detectada.direcao as any) ?? "saida");
      setCanal("whatsapp");
    }
    const fechar = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setAberto(false); };
    document.addEventListener("mousedown", fechar);
    return () => document.removeEventListener("mousedown", fechar);
  }, [aberto, detectada?.id]);

  function limpar() {
    setResultado(null); setDuracao(""); setNota(""); setFollowup(null); setAgendou(false); setDirecao("saida"); setCanal("whatsapp"); setQuando(""); setResponsavel(null);
  }

  async function salvar() {
    if (!resultado) return;
    try {
      await registrar.mutateAsync({
        dealId, tipo: "ligacao", resultado, canal, direcao,
        nota: nota.trim() || undefined,
        duracaoMin: duracao ? Number(duracao.replace(",", ".")) : undefined,
        atividadeId: detectada?.id,
        em: quando ? `${quando}:00-03:00` : undefined,
      });
      const abrirAgenda = agendou;
      if (followup === -1) {
        await proximo.mutateAsync({ dealId, em: null });
      } else if (followup != null) {
        await proximo.mutateAsync({
          dealId, em: `${isoLocal(new Date(Date.now() + followup * 86400_000))}T09:00:00-03:00`,
          responsavelId: responsavelFinal,
        });
      }
      limpar();
      setAberto(false);
      onSalvo();
      if (abrirAgenda) setAgendarAgora(true);
    } catch (e) {
      alert("Erro ao registrar: " + (e instanceof Error ? e.message : e));
    }
  }


  return (
    <span className="relative" ref={boxRef}>
      <button
        onClick={() => setAberto((v) => !v)}
        className={`text-xs px-2 py-0.5 rounded-md border bg-white hover:bg-gray-50 ${detectada ? "border-green-400 text-green-700" : ""}`}
        title={detectada ? "Há uma ligação de WhatsApp detectada para completar" : "Registrar ligação feita pelo WhatsApp/celular"}
      >
        {rotulo ?? "📞 Registrar ligação"}{detectada ? " •" : ""}
      </button>
      {aberto && (
        <div className={`absolute ${alinharDireita ? "right-0" : "left-0"} top-full mt-1 z-40 w-80 bg-white border rounded-xl shadow-xl p-3 space-y-3 text-left`}>
          {detectada ? (
            <p className="text-[11px] bg-green-50 text-green-800 rounded-md px-2 py-1.5">
              🤖 Ligação de WhatsApp detectada às {hora(detectada.criadoEm)} · {detectada.direcao === "entrada" ? "o lead ligou" : "você ligou"}
              {detectada.duracaoSeg != null ? ` · ${durTxt(detectada.duracaoSeg)}` : ""}. Confira o resultado e escreva o resumo.
            </p>
          ) : (
            <div className="flex gap-1">
              {([["saida", "Eu liguei"], ["entrada", "O lead ligou"]] as const).map(([v, r]) => (
                <button key={v} onClick={() => setDirecao(v)} className={chip(direcao === v)}>{r}</button>
              ))}
              <select value={canal} onChange={(e) => setCanal(e.target.value as any)} className="ml-auto text-xs border rounded-md px-1">
                <option value="whatsapp">WhatsApp</option>
                <option value="celular">Celular</option>
                <option value="voip">VoIP</option>
              </select>
            </div>
          )}

          <label className="flex items-center gap-2 text-xs text-gray-600">
            Data e hora
            <input
              type="datetime-local"
              value={quando}
              max={dataHoraLocal(new Date())}
              onChange={(e) => setQuando(e.target.value)}
              className="border rounded-md px-1.5 py-0.5 text-xs"
            />
          </label>

          <div className="flex flex-wrap gap-1">
            {RESULTADOS.map((r) => (
              <button
                key={r.v}
                onClick={() => setResultado(r.v)}
                className={`text-xs px-2 py-1 rounded-md border ${resultado === r.v ? `${r.cor} text-white border-transparent` : "bg-white text-gray-700 hover:border-gray-400"}`}
              >
                {r.rotulo}
              </button>
            ))}
          </div>

          {(resultado === "atendeu" || resultado === "pediu_retorno") && detectada?.duracaoSeg == null && (
            <label className="flex items-center gap-2 text-xs text-gray-600">
              Duração aprox.
              <input value={duracao} onChange={(e) => setDuracao(e.target.value)} inputMode="decimal" className="w-14 border rounded px-1.5 py-0.5" /> min
            </label>
          )}

          <label className="block text-xs text-gray-600">
            Observações
            <textarea
              value={nota}
              onChange={(e) => setNota(e.target.value)}
              rows={3}
              placeholder={
                resultado === "atendeu" || resultado === "pediu_retorno"
                  ? "O que ele contou, objeções, o que ficou combinado"
                  : "Ex.: chamou até cair, caixa postal, número de outra pessoa…"
              }
              className="mt-1 w-full border rounded-lg px-2 py-1.5 text-xs"
            />
          </label>

          {resultado === "atendeu" && (
            <label className="flex items-center gap-1.5 text-xs text-gray-700">
              <input type="checkbox" checked={agendou} onChange={(e) => setAgendou(e.target.checked)} className="accent-indigo-600" />
              Agendou reunião (abre a agenda para marcar data e pauta)
            </label>
          )}

          <ProximoFollowup
            followup={followup} setFollowup={setFollowup} obrigatorio={modoBaixa}
            sugestao={resultado === "nao_atendeu" && followup == null ? "sugestão: D+1" : ""}
            usuarios={resp.data?.usuarios ?? []} responsavel={responsavelFinal} setResponsavel={setResponsavel}
          />

          <div className="flex justify-end gap-2">
            <button onClick={() => { limpar(); setAberto(false); }} className="text-xs px-3 py-1.5 rounded-lg text-gray-500 hover:bg-gray-100">Cancelar</button>
            <button
              disabled={!resultado || registrar.isLoading || (modoBaixa && followup == null)}
              onClick={salvar}
              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white disabled:opacity-40"
            >
              {registrar.isLoading ? "Salvando…" : "Registrar"}
            </button>
          </div>
        </div>
      )}
      {agendarAgora && (
        <AgendarReuniaoModal dealId={dealId} titulo="🗓 Agendar a reunião combinada na ligação"
          onClose={() => setAgendarAgora(false)} onSalvo={onSalvo} />
      )}
    </span>
  );
}

export const chip = (ativo: boolean) =>
  `text-xs px-2 py-1 rounded-md border ${ativo ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-gray-600 hover:border-gray-400"}`;

/** D+n / encerrar follow-up e com quem — igual na ligação e na reunião. n = D+n · -1 = encerrar · null = não mexer. */
export function ProximoFollowup({ followup, setFollowup, obrigatorio, sugestao, usuarios, responsavel, setResponsavel }: {
  followup: number | null;
  setFollowup: (n: number | null) => void;
  obrigatorio?: boolean;
  sugestao?: string;
  usuarios: { id: string; nome: string }[];
  responsavel: string | undefined;
  setResponsavel: (id: string | null) => void;
}) {
  return (
    <div>
      <p className="text-[11px] text-gray-400 mb-1">{obrigatorio ? "Próximo passo (obrigatório)" : "Próximo follow-up"}</p>
      <div className="flex flex-wrap gap-1">
        {[1, 3, 5, 7, 9].map((n) => (
          <button key={n} onClick={() => setFollowup(followup === n ? null : n)} className={chip(followup === n)}>D+{n}</button>
        ))}
        {/* Sempre disponível: o lead que responde horas depois de ganhar um D+n precisa
            sair da lista sem ter que esperar a baixa no painel. */}
        <button onClick={() => setFollowup(followup === -1 ? null : -1)} className={chip(followup === -1)} title="Tira o lead da lista de follow-ups">
          Encerrar follow-up
        </button>
        <span className="text-[11px] text-gray-400 self-center ml-1">
          {sugestao}
        </span>
      </div>
      {followup != null && followup > 0 && (
        <label className="flex items-center gap-1.5 mt-1.5 text-[11px] text-gray-500">
          Follow-up com
          <select
            value={responsavel ?? ""}
            onChange={(e) => setResponsavel(e.target.value || null)}
            className="border rounded-md px-1.5 py-0.5 text-xs text-gray-700"
          >
            {usuarios.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}
