import { useEffect, useRef, useState } from "react";
import { trpc } from "../lib/trpc";
import { type Atividade, ProximoFollowup, chip, dataHoraLocal, durTxt, hora, isoLocal } from "./RegistrarLigacao";
import { ROTULO_MODALIDADE, dataHoraTxt as dataHoraReuniao } from "./AgendarReuniao";

const RESULTADOS: { v: "realizada" | "no_show" | "remarcada" | "cancelada"; rotulo: string; cor: string }[] = [
  { v: "realizada", rotulo: "Realizada", cor: "bg-green-600" },
  { v: "no_show", rotulo: "Não compareceu", cor: "bg-gray-600" },
  { v: "remarcada", rotulo: "Remarcada", cor: "bg-indigo-600" },
  { v: "cancelada", rotulo: "Cancelada", cor: "bg-red-600" },
];

const CANAIS = [
  ["video", "Vídeo"],
  ["whatsapp", "WhatsApp"],
  ["telefone", "Telefone"],
  ["presencial", "Presencial"],
] as const;

const dataHoraTxt = (v: string) => new Date(`${v}:00-03:00`).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });

/**
 * Registro da reunião com a advogada, no mesmo molde do RegistrarLigacao: resultado, por onde,
 * data/hora, duração, resumo e próximo follow-up. Reunião feita (ou perdida) na sala do Avoce
 * já entra sozinha como atividade automática — o formulário completa aquela em vez de criar outra.
 */
export function RegistrarReuniao({ dealId, atividades, onSalvo, alinharDireita = false }: {
  dealId: string;
  atividades: Atividade[];
  onSalvo: () => void;
  alinharDireita?: boolean;
}) {
  const [aberto, setAberto] = useState(false);
  const [resultado, setResultado] = useState<(typeof RESULTADOS)[number]["v"] | null>(null);
  const [canal, setCanal] = useState<(typeof CANAIS)[number][0]>("video");
  const [duracao, setDuracao] = useState("");
  const [nota, setNota] = useState("");
  const [followup, setFollowup] = useState<number | null>(null);
  const [quando, setQuando] = useState("");
  const [novaData, setNovaData] = useState("");
  const [responsavel, setResponsavel] = useState<string | null>(null);
  // Reunião agendada que este registro conclui ("" = registro avulso, sem agendamento).
  const [reuniaoId, setReuniaoId] = useState<string>("");
  const [reuniaoEscolhida, setReuniaoEscolhida] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const utils = trpc.useUtils();
  const reunioesQ = trpc.reunioes.doLead.useQuery({ dealId }, { enabled: aberto, staleTime: 15_000 });
  const pendentes = ((reunioesQ.data ?? []) as any[])
    .filter((r) => r.status === "agendada" || r.status === "em_andamento")
    .sort((a, b) => new Date(a.agendadaPara ?? 0).getTime() - new Date(b.agendadaPara ?? 0).getTime());
  const reuniao = pendentes.find((r) => r.id === reuniaoId) ?? null;
  const registrarResultado = trpc.reunioes.registrarResultado.useMutation();

  const registrar = trpc.crm.registrarAtividade.useMutation();
  const proximo = trpc.crm.definirProximoContato.useMutation();
  const resp = trpc.crm.responsaveisFollowup.useQuery({ dealId }, { enabled: aberto, staleTime: 60_000 });
  const responsavelFinal = responsavel ?? resp.data?.sugerido ?? undefined;

  // Reunião registrada pela sala do Avoce nas últimas 24h e ainda sem resumo → completar ela.
  const detectada = atividades.find(
    (a) => a.tipo === "reuniao" && a.origem === "automatica" && !a.nota && Date.now() - new Date(a.criadoEm).getTime() < 24 * 3600_000,
  );

  useEffect(() => {
    if (!aberto) return;
    setQuando(dataHoraLocal(detectada ? new Date(detectada.criadoEm) : new Date()));
    if (detectada) {
      setResultado(detectada.resultado as any);
      setCanal("video");
    }
    const fechar = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setAberto(false); };
    document.addEventListener("mousedown", fechar);
    return () => document.removeEventListener("mousedown", fechar);
  }, [aberto, detectada?.id]);

  // Ao abrir: já escolhe a reunião agendada mais provável — a última que já passou do horário,
  // senão a próxima. Reunião detectada pela sala do Avoce segue o fluxo dela.
  useEffect(() => {
    if (!aberto || reuniaoEscolhida || detectada || !reunioesQ.data) return;
    const agora = Date.now() + 3600_000;
    const passadas = pendentes.filter((r) => r.agendadaPara && new Date(r.agendadaPara).getTime() <= agora);
    const alvo = passadas[passadas.length - 1] ?? pendentes[0];
    if (alvo) escolherReuniao(alvo.id);
    setReuniaoEscolhida(true);
  }, [aberto, reunioesQ.data, detectada?.id]);

  function escolherReuniao(id: string) {
    setReuniaoId(id);
    const r = pendentes.find((x) => x.id === id);
    if (!r) return;
    if (CANAIS.some(([v]) => v === r.modalidade)) setCanal(r.modalidade);
    if (r.agendadaPara && new Date(r.agendadaPara).getTime() < Date.now()) setQuando(dataHoraLocal(new Date(r.agendadaPara)));
  }

  function limpar() {
    setResultado(null); setDuracao(""); setNota(""); setFollowup(null); setCanal("video"); setQuando(""); setNovaData(""); setResponsavel(null);
    setReuniaoId(""); setReuniaoEscolhida(false);
  }

  async function registrarDaAgendada(ignorarConflito = false): Promise<boolean> {
    try {
      await registrarResultado.mutateAsync({
        id: reuniaoId, resultado: resultado!, canal,
        nota: nota.trim() || undefined,
        duracaoMin: duracao ? Number(duracao.replace(",", ".")) : undefined,
        em: (resultado === "realizada" || resultado === "no_show") && quando ? `${quando}:00-03:00` : undefined,
        novaData: resultado === "remarcada" && novaData ? `${novaData}:00-03:00` : undefined,
        ignorarConflito,
      });
      return true;
    } catch (e: any) {
      if (e?.data?.code === "CONFLICT" && window.confirm(`${e.message}\n\nRemarcar mesmo assim?`)) return registrarDaAgendada(true);
      if (e?.data?.code !== "CONFLICT") throw e;
      return false;
    }
  }

  async function salvar() {
    if (!resultado) return;
    const remarcadaPara = resultado === "remarcada" && novaData ? novaData : "";
    const texto = [remarcadaPara && `Remarcada para ${dataHoraTxt(remarcadaPara)}.`, nota.trim()].filter(Boolean).join(" ");
    try {
      if (reuniao) {
        if (!(await registrarDaAgendada())) return;
        utils.reunioes.doLead.invalidate({ dealId });
        utils.reunioes.agendaPeriodo.invalidate();
      } else {
        await registrar.mutateAsync({
          dealId, tipo: "reuniao", resultado, canal,
          nota: texto || undefined,
          duracaoMin: duracao ? Number(duracao.replace(",", ".")) : undefined,
          atividadeId: detectada?.id,
          em: quando ? `${quando}:00-03:00` : undefined,
        });
      }
      if (followup === -1) {
        await proximo.mutateAsync({ dealId, em: null });
      } else if (followup != null) {
        await proximo.mutateAsync({
          dealId, em: `${isoLocal(new Date(Date.now() + followup * 86400_000))}T09:00:00-03:00`,
          responsavelId: responsavelFinal,
        });
      } else if (remarcadaPara) {
        // Sem D+n escolhido, o lead volta para a lista no dia da nova reunião.
        await proximo.mutateAsync({ dealId, em: `${remarcadaPara}:00-03:00`, responsavelId: responsavelFinal });
      }
      limpar();
      setAberto(false);
      onSalvo();
    } catch (e) {
      alert("Erro ao registrar: " + (e instanceof Error ? e.message : e));
    }
  }

  const sugestao =
    followup != null ? "" :
    resultado === "no_show" ? "sugestão: D+1 para remarcar" :
    resultado === "remarcada" && novaData ? "sem D+n: follow-up no dia da nova reunião" : "";

  return (
    <span className="relative" ref={boxRef}>
      <button
        onClick={() => setAberto((v) => !v)}
        className={`text-xs px-2 py-0.5 rounded-md border bg-white hover:bg-gray-50 ${detectada ? "border-green-400 text-green-700" : ""}`}
        title={detectada ? "Há uma reunião da sala do Avoce para completar" : "Registrar reunião com a advogada"}
      >
        🗓 Registrar reunião{detectada ? " •" : ""}
      </button>
      {aberto && (
        <div className={`absolute ${alinharDireita ? "right-0" : "left-0"} top-full mt-1 z-40 w-80 bg-white border rounded-xl shadow-xl p-3 space-y-3 text-left`}>
          {!detectada && pendentes.length > 0 && (
            <div className="space-y-1">
              <label className="block text-xs text-gray-600">
                Reunião agendada
                <select value={reuniaoId} onChange={(e) => { setReuniaoEscolhida(true); if (e.target.value) escolherReuniao(e.target.value); else setReuniaoId(""); }}
                  className="mt-1 w-full border rounded-lg px-2 py-1.5 text-xs bg-white">
                  {pendentes.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.agendadaPara ? dataHoraReuniao(r.agendadaPara) : "sem data"} · {(ROTULO_MODALIDADE[r.modalidade] ?? r.modalidade).replace(/^\S+\s/, "")}{r.responsavelNome ? ` · ${r.responsavelNome.split(" ")[0]}` : ""}
                    </option>
                  ))}
                  <option value="">Outra (sem agendamento)</option>
                </select>
              </label>
              {reuniao && (reuniao.pauta || reuniao.notas) && (
                <div className="text-[11px] bg-indigo-50 text-indigo-900 rounded-md px-2 py-1.5 space-y-0.5 max-h-24 overflow-y-auto">
                  {reuniao.pauta && <p className="whitespace-pre-wrap"><b>Pauta:</b> {reuniao.pauta}</p>}
                  {reuniao.notas && <p className="whitespace-pre-wrap"><b>Anotações:</b> {reuniao.notas}</p>}
                </div>
              )}
            </div>
          )}

          {detectada ? (
            <p className="text-[11px] bg-green-50 text-green-800 rounded-md px-2 py-1.5">
              🤖 {detectada.resultado === "no_show" ? "Ninguém entrou na sala" : "Reunião na sala do Avoce"} às {hora(detectada.criadoEm)}
              {detectada.duracaoSeg != null ? ` · ${durTxt(detectada.duracaoSeg)}` : ""}. Confira o resultado e escreva o resumo.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {CANAIS.map(([v, r]) => (
                <button key={v} onClick={() => setCanal(v)} className={chip(canal === v)}>{r}</button>
              ))}
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

          {resultado === "realizada" && detectada?.duracaoSeg == null && (
            <label className="flex items-center gap-2 text-xs text-gray-600">
              Duração aprox.
              <input value={duracao} onChange={(e) => setDuracao(e.target.value)} inputMode="decimal" className="w-14 border rounded px-1.5 py-0.5" /> min
            </label>
          )}

          {resultado === "remarcada" && (
            <label className="flex items-center gap-2 text-xs text-gray-600">
              Nova data
              <input
                type="datetime-local"
                value={novaData}
                min={dataHoraLocal(new Date())}
                onChange={(e) => setNovaData(e.target.value)}
                className="border rounded-md px-1.5 py-0.5 text-xs"
              />
            </label>
          )}

          <label className="block text-xs text-gray-600">
            {resultado === "realizada" ? "Resumo da reunião" : "Observações"}
            <textarea
              value={nota}
              onChange={(e) => setNota(e.target.value)}
              rows={3}
              placeholder={
                resultado === "realizada"
                  ? "O que foi decidido, documentos pendentes, proposta, objeções"
                  : resultado === "no_show"
                  ? "Ex.: não entrou e não respondeu; avisou que estava na estrada…"
                  : "Motivo e o que ficou combinado"
              }
              className="mt-1 w-full border rounded-lg px-2 py-1.5 text-xs"
            />
          </label>

          <ProximoFollowup
            followup={followup} setFollowup={setFollowup} sugestao={sugestao}
            usuarios={resp.data?.usuarios ?? []} responsavel={responsavelFinal} setResponsavel={setResponsavel}
          />

          <div className="flex justify-end gap-2">
            <button onClick={() => { limpar(); setAberto(false); }} className="text-xs px-3 py-1.5 rounded-lg text-gray-500 hover:bg-gray-100">Cancelar</button>
            <button
              disabled={!resultado || registrar.isLoading || registrarResultado.isLoading || (!!reuniao && resultado === "remarcada" && !novaData)}
              onClick={salvar}
              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white disabled:opacity-40"
            >
              {registrar.isLoading || registrarResultado.isLoading ? "Salvando…" : "Registrar"}
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
