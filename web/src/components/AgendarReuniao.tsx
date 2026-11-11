import { useEffect, useState } from "react";
import { trpc } from "../lib/trpc";
import { dataHoraLocal } from "./RegistrarLigacao";

/**
 * Reunião marcada pelo SDR/closer, vinculada ao lead: quem conduz, quando, como, pauta e
 * anotações. Vai para a agenda (Reuniões → Agenda) e para o histórico do lead.
 */

export const MODALIDADES = [
  ["video", "📹 Vídeo"],
  ["whatsapp", "💬 WhatsApp"],
  ["telefone", "📞 Telefone"],
  ["presencial", "🏢 Presencial"],
] as const;
type Modalidade = (typeof MODALIDADES)[number][0];
export const ROTULO_MODALIDADE: Record<string, string> = Object.fromEntries(MODALIDADES);

const DURACOES = [30, 45, 60, 90, 120];

export const STATUS_REUNIAO: Record<string, { rotulo: string; cor: string }> = {
  agendada: { rotulo: "agendada", cor: "bg-amber-100 text-amber-800" },
  em_andamento: { rotulo: "ao vivo", cor: "bg-green-100 text-green-700" },
  encerrada: { rotulo: "realizada", cor: "bg-gray-100 text-gray-600" },
  no_show: { rotulo: "não compareceu", cor: "bg-orange-100 text-orange-700" },
  cancelada: { rotulo: "cancelada", cor: "bg-red-100 text-red-600" },
};

export const dataHoraTxt = (s: string | Date) =>
  new Date(s).toLocaleString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });

/** Próxima hora cheia, para o campo não abrir no passado. */
function proximaHora() {
  const d = new Date(Date.now() + 3600_000);
  d.setMinutes(0, 0, 0);
  return dataHoraLocal(d);
}

export interface ReuniaoEditavel {
  id: string;
  agendadaPara: string | null;
  duracaoMin: number;
  modalidade: string;
  responsavelId: string | null;
  pauta: string | null;
  notas: string | null;
  status: string;
}

export function AgendarReuniaoModal({ dealId, reuniao, titulo, onClose, onSalvo }: {
  dealId: string;
  reuniao?: ReuniaoEditavel | null;
  titulo?: string;
  onClose: () => void;
  onSalvo?: () => void;
}) {
  const utils = trpc.useUtils();
  const editando = !!reuniao;
  const podeMudarAgenda = !reuniao || ["agendada", "em_andamento"].includes(reuniao.status);
  const resp = trpc.crm.responsaveisFollowup.useQuery({ dealId }, { staleTime: 60_000 });
  const me = trpc.auth.me.useQuery(undefined, { staleTime: 300_000 });

  const [responsavelId, setResponsavelId] = useState(reuniao?.responsavelId ?? "");
  const [quando, setQuando] = useState(reuniao?.agendadaPara ? dataHoraLocal(new Date(reuniao.agendadaPara)) : proximaHora());
  const [duracaoMin, setDuracaoMin] = useState(reuniao?.duracaoMin ?? 60);
  const [modalidade, setModalidade] = useState<Modalidade>((reuniao?.modalidade as Modalidade) ?? "video");
  const [pauta, setPauta] = useState(reuniao?.pauta ?? "");
  const [notas, setNotas] = useState(reuniao?.notas ?? "");
  const [avisar, setAvisar] = useState(true);
  const [conflito, setConflito] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  // Quem marca a própria reunião não precisa escolher a si mesmo.
  useEffect(() => {
    if (responsavelId || editando) return;
    const eu = me.data?.id;
    if (eu && resp.data?.usuarios.some((u) => u.id === eu)) setResponsavelId(eu);
  }, [me.data?.id, resp.data, editando, responsavelId]);

  const aposSalvar = () => {
    utils.reunioes.doLead.invalidate({ dealId });
    utils.reunioes.agendaPeriodo.invalidate();
    utils.reunioes.listar.invalidate();
    utils.crm.listAtividades.invalidate({ dealId });
    onSalvo?.();
    onClose();
  };
  const tratarErro = (e: any) => {
    if (e?.data?.code === "CONFLICT") { setConflito(e.message); setErro(null); }
    else setErro(e?.message ?? "Erro ao salvar");
  };
  const agendar = trpc.reunioes.agendar.useMutation({ onSuccess: aposSalvar, onError: tratarErro });
  const atualizar = trpc.reunioes.atualizar.useMutation({ onSuccess: aposSalvar, onError: tratarErro });
  const salvando = agendar.isLoading || atualizar.isLoading;

  function salvar(ignorarConflito = false) {
    setErro(null);
    const agendadaPara = `${quando}:00-03:00`;
    if (editando) {
      atualizar.mutate({
        id: reuniao!.id, pauta, notas, ignorarConflito,
        ...(podeMudarAgenda ? { agendadaPara, duracaoMin, modalidade, ...(responsavelId ? { responsavelId } : {}) } : {}),
      });
    } else {
      agendar.mutate({
        dealId, responsavelId, agendadaPara, duracaoMin, modalidade,
        pauta: pauta || undefined, notas: notas || undefined,
        avisarCliente: modalidade === "video" && avisar, ignorarConflito,
      });
    }
  }

  const valido = !!quando && (editando || !!responsavelId);
  const campo = "w-full border rounded-lg px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-indigo-300 bg-white disabled:bg-gray-50";

  return (
    <div className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center p-4" onMouseDown={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[92vh] overflow-y-auto" onMouseDown={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b flex items-center justify-between">
          <h3 className="font-semibold text-gray-800 text-sm">{titulo ?? (editando ? "Editar reunião" : "🗓 Agendar reunião")}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>
        </div>

        <div className="p-5 space-y-3 text-sm">
          <div>
            <label className="text-xs text-gray-500 block mb-1">Quem conduz *</label>
            <select value={responsavelId} onChange={(e) => setResponsavelId(e.target.value)} className={campo} disabled={!podeMudarAgenda}>
              <option value="">Escolha…</option>
              {(resp.data?.usuarios ?? []).map((u) => (
                <option key={u.id} value={u.id}>{u.nome}{u.id === me.data?.id ? " (eu)" : ""}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-[1fr_auto] gap-2">
            <div>
              <label className="text-xs text-gray-500 block mb-1">Data e hora (Brasília) *</label>
              <input type="datetime-local" value={quando} onChange={(e) => setQuando(e.target.value)} className={campo} disabled={!podeMudarAgenda} />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Duração</label>
              <select value={duracaoMin} onChange={(e) => setDuracaoMin(Number(e.target.value))} className={campo} disabled={!podeMudarAgenda}>
                {[...new Set([...DURACOES, duracaoMin])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{m} min</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="text-xs text-gray-500 block mb-1">Como</label>
            <div className="flex flex-wrap gap-1.5">
              {MODALIDADES.map(([v, r]) => (
                <button key={v} type="button" disabled={!podeMudarAgenda} onClick={() => setModalidade(v)}
                  className={`text-xs px-2.5 py-1 rounded-full border ${modalidade === v ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-gray-600 hover:bg-gray-50"}`}>
                  {r}
                </button>
              ))}
            </div>
          </div>

          {!editando && (
            <label className={`flex items-start gap-2 text-xs ${modalidade === "video" ? "text-gray-700" : "text-gray-400"}`}>
              <input type="checkbox" className="mt-0.5 accent-indigo-600" disabled={modalidade !== "video"}
                checked={modalidade === "video" && avisar} onChange={(e) => setAvisar(e.target.checked)} />
              <span>
                Avisar o cliente pelo WhatsApp (confirmação com o link da sala e lembretes antes da reunião)
                {modalidade !== "video" && " — só para reunião por vídeo"}
              </span>
            </label>
          )}

          <div>
            <label className="text-xs text-gray-500 block mb-1">Pauta</label>
            <textarea value={pauta} onChange={(e) => setPauta(e.target.value)} rows={3} className={campo}
              placeholder="O que vai ser tratado: ex. explicar o cálculo, honorários, documentos que faltam" />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Anotações</label>
            <textarea value={notas} onChange={(e) => setNotas(e.target.value)} rows={3} className={campo}
              placeholder="Contexto para quem vai conduzir, ou o que foi dito na reunião" />
          </div>

          {conflito && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 text-xs text-amber-800 space-y-2">
              <p>{conflito}</p>
              <button onClick={() => salvar(true)} disabled={salvando}
                className="px-2.5 py-1 rounded-md bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50">
                Agendar mesmo assim
              </button>
            </div>
          )}
          {erro && <p className="text-xs text-red-600">{erro}</p>}
        </div>

        <div className="px-5 py-3 border-t flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm border rounded-lg text-gray-600 hover:bg-gray-50">Cancelar</button>
          <button onClick={() => salvar(false)} disabled={!valido || salvando}
            className="px-3 py-1.5 text-sm rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
            {salvando ? "Salvando…" : editando ? "Salvar" : "Agendar"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Botão + modal, para as barras de ação. */
export function BotaoAgendarReuniao({ dealId, onSalvo, className }: { dealId: string; onSalvo?: () => void; className?: string }) {
  const [aberto, setAberto] = useState(false);
  return (
    <>
      <button onClick={() => setAberto(true)} className={className ?? "text-xs px-2 py-0.5 rounded-md border bg-white hover:bg-gray-50 text-indigo-700"}>
        🗓 Agendar reunião
      </button>
      {aberto && <AgendarReuniaoModal dealId={dealId} onClose={() => setAberto(false)} onSalvo={onSalvo} />}
    </>
  );
}

/** Reuniões do lead: próximas primeiro, com pauta e anotações, editar, cancelar e entrar na sala. */
export function ReunioesDoLead({ dealId, onChange, limite }: { dealId: string; onChange?: () => void; limite?: number }) {
  const utils = trpc.useUtils();
  const q = trpc.reunioes.doLead.useQuery({ dealId }, { refetchInterval: 30_000 });
  const [editando, setEditando] = useState<ReuniaoEditavel | null>(null);
  const [notasAbertas, setNotasAbertas] = useState<string | null>(null);
  const [rascunho, setRascunho] = useState("");
  const atualizar = trpc.reunioes.atualizar.useMutation({ onSuccess: () => { utils.reunioes.doLead.invalidate({ dealId }); setNotasAbertas(null); } });
  const cancelar = trpc.reunioes.cancelar.useMutation({
    onSuccess: () => { utils.reunioes.doLead.invalidate({ dealId }); utils.reunioes.agendaPeriodo.invalidate(); utils.crm.listAtividades.invalidate({ dealId }); onChange?.(); },
    onError: (e) => alert(e.message),
  });
  const entrar = trpc.useUtils().reunioes.getJitsiUrl;

  const agora = Date.now();
  const lista = [...(q.data ?? [])].sort((a: any, b: any) => {
    const fa = a.status === "agendada" && a.agendadaPara && new Date(a.agendadaPara).getTime() >= agora - 3600_000;
    const fb = b.status === "agendada" && b.agendadaPara && new Date(b.agendadaPara).getTime() >= agora - 3600_000;
    if (fa !== fb) return fa ? -1 : 1;
    const ta = new Date(a.agendadaPara ?? a.criadaEm).getTime(), tb = new Date(b.agendadaPara ?? b.criadaEm).getTime();
    return fa ? ta - tb : tb - ta;
  }).slice(0, limite ?? 50);

  if (q.isLoading) return <p className="text-xs text-gray-400">Carregando reuniões…</p>;
  if (!lista.length) return <p className="text-xs text-gray-400">Nenhuma reunião marcada.</p>;

  return (
    <div className="space-y-2">
      {lista.map((r: any) => {
        const st = STATUS_REUNIAO[r.status] ?? { rotulo: r.status, cor: "bg-gray-100 text-gray-600" };
        const ativa = r.status === "agendada" || r.status === "em_andamento";
        return (
          <div key={r.id} className="border border-gray-200 rounded-lg p-2.5 bg-white text-xs">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="font-semibold text-gray-800">{r.agendadaPara ? dataHoraTxt(r.agendadaPara) : "sem data"}</span>
              <span className="text-gray-500">{r.duracaoMin} min · {ROTULO_MODALIDADE[r.modalidade] ?? r.modalidade}</span>
              <span className={`px-1.5 py-0.5 rounded-full ${st.cor}`}>{st.rotulo}</span>
            </div>
            <p className="text-gray-500 mt-0.5">
              {r.responsavelNome ? <>Conduz: <b className="font-medium text-gray-700">{r.responsavelNome}</b></> : "Sem responsável"}
              {r.marcadaPorNome && <> · marcada por {r.marcadaPorNome}</>}
            </p>
            {r.pauta && <p className="mt-1 text-gray-700 whitespace-pre-wrap"><span className="text-gray-400">Pauta: </span>{r.pauta}</p>}
            {notasAbertas === r.id ? (
              <div className="mt-1.5 space-y-1">
                <textarea value={rascunho} onChange={(e) => setRascunho(e.target.value)} rows={3} autoFocus
                  className="w-full border rounded-md px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-indigo-300" />
                <div className="flex gap-1.5">
                  <button onClick={() => atualizar.mutate({ id: r.id, notas: rascunho })} disabled={atualizar.isLoading}
                    className="px-2 py-0.5 rounded-md bg-indigo-600 text-white disabled:opacity-50">Salvar anotações</button>
                  <button onClick={() => setNotasAbertas(null)} className="px-2 py-0.5 rounded-md border">Cancelar</button>
                </div>
              </div>
            ) : r.notas ? (
              <p className="mt-1 text-gray-700 whitespace-pre-wrap"><span className="text-gray-400">Anotações: </span>{r.notas}</p>
            ) : null}
            <div className="flex flex-wrap gap-2 mt-1.5">
              {notasAbertas !== r.id && (
                <button className="text-indigo-600 hover:underline" onClick={() => { setNotasAbertas(r.id); setRascunho(r.notas ?? ""); }}>
                  {r.notas ? "editar anotações" : "+ anotações"}
                </button>
              )}
              <button className="text-indigo-600 hover:underline" onClick={() => setEditando(r)}>
                {ativa ? "editar / remarcar" : "editar pauta"}
              </button>
              {ativa && r.modalidade === "video" && (
                <button className="text-green-700 hover:underline" onClick={async () => {
                  const j = await entrar.fetch({ id: r.id });
                  window.open(j.url, "_blank", "noopener");
                }}>entrar na sala</button>
              )}
              {r.status === "agendada" && (
                <button className="text-red-600 hover:underline" disabled={cancelar.isLoading} onClick={() => {
                  const motivo = window.prompt("Cancelar esta reunião? Motivo (opcional):");
                  if (motivo !== null) cancelar.mutate({ id: r.id, motivo: motivo || undefined });
                }}>cancelar</button>
              )}
            </div>
          </div>
        );
      })}
      {editando && (
        <AgendarReuniaoModal dealId={dealId} reuniao={editando} onClose={() => setEditando(null)} onSalvo={onChange} />
      )}
    </div>
  );
}
