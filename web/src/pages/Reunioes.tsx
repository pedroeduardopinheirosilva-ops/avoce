import { useState, useMemo, useEffect, useRef } from "react";
import { Video, Plus, Copy, ExternalLink, Clock, CheckCircle, XCircle, Calendar, FileText, CalendarDays, Trash2, ChevronLeft, ChevronRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { trpc } from "../lib/trpc";
import { AgendarReuniaoModal, ROTULO_MODALIDADE, STATUS_REUNIAO, dataHoraTxt } from "../components/AgendarReuniao";
import { useTranscricaoCapture } from "../lib/useTranscricaoCapture";

const DIAS_SEMANA_NOMES = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

function getWeekBounds(offset: number) {
  const now = new Date();
  const dow = now.getDay(); // 0=Sun
  const monday = new Date(now);
  monday.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1) + offset * 7);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { monday, sunday };
}

type Sessao = {
  id: string;
  titulo: string;
  status: string;
  agendadaPara: string | null;
  iniciadaEm: string | null;
  encerradaEm: string | null;
  duracao: number | null;
  criadaEm: string;
  notas: string | null;
  transcricao: string | null;
  resumoIa: string | null;
  tokenConvidado: string;
  deal: { titulo: string } | null;
  contato: { nome: string; whatsapp: string | null } | null;
};

const STATUS_COLORS: Record<string, string> = {
  agendada: "bg-blue-100 text-blue-700",
  em_andamento: "bg-green-100 text-green-700",
  encerrada: "bg-gray-100 text-gray-600",
  cancelada: "bg-red-100 text-red-600",
};

const STATUS_ICONS: Record<string, JSX.Element> = {
  agendada:     <Calendar size={13} />,
  em_andamento: <Video size={13} />,
  encerrada:    <CheckCircle size={13} />,
  cancelada:    <XCircle size={13} />,
};

function formatDuracao(seg: number | null | undefined) {
  if (seg == null) return null;
  const m = Math.floor(seg / 60), s = seg % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatDateTime(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).catch(() => {});
}

export default function ReunioesPage({ abaInicial = "reunioes" }: { abaInicial?: "reunioes" | "agenda" } = {}) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<"reunioes" | "agenda">(abaInicial);
  const [showModal, setShowModal] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [novaForm, setNovaForm] = useState({ titulo: "", agendadaPara: "" });
  const [notasEdit, setNotasEdit] = useState("");
  const [showJitsi, setShowJitsi] = useState(false);
  const [jitsiUrl, setJitsiUrl] = useState("");
  const [linkConvidado, setLinkConvidado] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Agenda state
  const [agendaForm, setAgendaForm]             = useState({ data: "", horaInicio: "", horaFim: "", titulo: "" });
  const [agendaEmitenteId, setAgendaEmitenteId] = useState("");
  const [agendaUsuarioId,  setAgendaUsuarioId]  = useState("");
  const [agendaProjetoId,  setAgendaProjetoId]  = useState("");
  const [recorrente, setRecorrente]             = useState({
    diasSemana: [] as number[],
    horarios:   [{ hora: "09:00", durMin: 30 }] as { hora: string; durMin: number }[],
    semanas:    4,
  });
  const [weekOffset,        setWeekOffset]       = useState(0);
  const [showRecForm,       setShowRecForm]       = useState(false);
  const [showAvulsoForm,    setShowAvulsoForm]    = useState(false);

  const { monday, sunday } = useMemo(() => getWeekBounds(weekOffset), [weekOffset]);

  const agendaQ = trpc.agenda.listar.useQuery(
    {
      apenasDisponiveis: false,
      de:  monday.toISOString(),
      ate: sunday.toISOString(),
      ...(agendaEmitenteId ? { emitenteId: agendaEmitenteId } : {}),
      ...(agendaUsuarioId  ? { usuarioId:  agendaUsuarioId }  : {}),
      ...(agendaProjetoId  ? { projetoId:  agendaProjetoId }  : {}),
    },
    { enabled: tab === "agenda", staleTime: 30_000 }
  );

  // Reuniões marcadas (SDR, closer, IA) na semana — o que de fato ocupa a agenda.
  const fimSemana = useMemo(() => { const d = new Date(monday); d.setDate(d.getDate() + 7); return d; }, [monday]);
  const reunioesSemanaQ = trpc.reunioes.agendaPeriodo.useQuery(
    { de: monday.toISOString(), ate: fimSemana.toISOString(), ...(agendaUsuarioId ? { responsavelId: agendaUsuarioId } : {}) },
    { enabled: tab === "agenda", refetchInterval: 60_000 },
  );
  const reunioesPorDia = useMemo(() => {
    const g: Record<string, any[]> = {};
    for (const r of (reunioesSemanaQ.data as any[] | undefined) ?? []) {
      if (!r.agendadaPara) continue;
      (g[new Date(r.agendadaPara).toDateString()] ??= []).push(r);
    }
    return g;
  }, [reunioesSemanaQ.data]);
  const idsReunioesSemana = useMemo(() => new Set(((reunioesSemanaQ.data as any[] | undefined) ?? []).map(r => r.id)), [reunioesSemanaQ.data]);
  const [reuniaoAberta, setReuniaoAberta] = useState<any | null>(null);
  const [editandoReuniao, setEditandoReuniao] = useState<any | null>(null);

  const slotsByDay = useMemo(() => {
    const groups: Record<string, any[]> = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      groups[d.toDateString()] = [];
    }
    for (const slot of (agendaQ.data as any[] | undefined) ?? []) {
      const key = new Date(slot.inicio).toDateString();
      if (groups[key]) groups[key].push(slot);
    }
    return groups;
  }, [agendaQ.data, monday]);
  const criarSlotMut        = trpc.agenda.criar.useMutation({ onSuccess: () => { agendaQ.refetch(); setAgendaForm({ data: "", horaInicio: "", horaFim: "", titulo: "" }); } });
  const criarRecorrenteMut  = trpc.agenda.criarRecorrente.useMutation({ onSuccess: () => agendaQ.refetch() });
  const deletarSlotMut      = trpc.agenda.deletar.useMutation({ onSuccess: () => agendaQ.refetch() });
  const fecharSlotMut       = trpc.agenda.fechar.useMutation({ onSuccess: () => agendaQ.refetch() });
  const reabrirSlotMut      = trpc.agenda.reabrir.useMutation({ onSuccess: () => agendaQ.refetch() });

  const lista    = trpc.reunioes.listar.useQuery({}, { refetchInterval: 15_000 });
  const sessao   = trpc.reunioes.get.useQuery({ id: selectedId ?? "" }, { enabled: !!selectedId });
  const jitsiQ   = trpc.reunioes.getJitsiUrl.useQuery({ id: selectedId ?? "" }, { enabled: !!selectedId });

  const criar    = trpc.reunioes.criar.useMutation({ onSuccess: () => { lista.refetch(); setShowModal(false); setNovaForm({ titulo: "", agendadaPara: "" }); } });
  const iniciar  = trpc.reunioes.iniciar.useMutation({ onSuccess: () => { lista.refetch(); sessao.refetch(); } });
  const encerrar = trpc.reunioes.encerrar.useMutation({ onSuccess: () => { lista.refetch(); sessao.refetch(); } });
  const cancelar = trpc.reunioes.cancelar.useMutation({ onSuccess: () => { lista.refetch(); sessao.refetch(); } });
  const updateNotas = trpc.reunioes.updateNotas.useMutation({ onSuccess: () => sessao.refetch() });

  const appBase = window.location.origin;

  // Transcrição — captura o microfone do operador com o nome do usuário logado
  const me = trpc.auth.me.useQuery();
  useTranscricaoCapture({
    sessaoId: selectedId ?? undefined,
    enabled:  showJitsi && !!selectedId,
    nome:     me.data?.nome,
  });

  // Transcrição ao vivo — chunks rotulados por interlocutor
  const emAndamento = sessao.data?.status === "em_andamento";
  const transcricaoQ = trpc.reunioes.getTranscricao.useQuery(
    { id: selectedId ?? "" },
    { enabled: !!selectedId, refetchInterval: emAndamento ? 4_000 : false },
  );

  // Copiloto IA — sugestões em tempo real enquanto a reunião acontece
  const copilotoQ = trpc.reunioes.copiloto.useQuery(
    { id: selectedId ?? "" },
    { enabled: !!selectedId && emAndamento, refetchInterval: 45_000 },
  );

  function handleEntrar() {
    if (!jitsiQ.data) return;
    setJitsiUrl(jitsiQ.data.url);
    setLinkConvidado(jitsiQ.data.linkConvidado);
    setShowJitsi(true);
    if (sessao.data?.status === "agendada") iniciar.mutate({ id: selectedId! });
  }

  function handleCopyLink(id: string, token: string) {
    copyToClipboard(`${appBase}/sala/${token}`);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }

  const s = sessao.data as Sessao | undefined;

  // Agenda: need emitenteId + usuarioId + projetoId
  const emitentesQ  = trpc.empresa.listar.useQuery(undefined, { enabled: tab === "agenda" });
  const usuariosQ   = trpc.auth.listUsuarios.useQuery(undefined, { enabled: tab === "agenda" });
  const projetosQ   = trpc.ia.listProjetos.useQuery(undefined, { enabled: tab === "agenda" });

  // O que ainda falta para liberar os botões de criar slot — sem isso o botão fica
  // desabilitado sem dizer por quê (Escritório e Projeto SDR começam em "Todos",
  // que não serve para criar).
  const emitentesVazio = tab === "agenda" && !emitentesQ.isLoading && !(emitentesQ.data as any[])?.length;
  const faltaBase = [
    !agendaEmitenteId && "Escritório",
    !agendaProjetoId  && "Projeto SDR",
  ].filter(Boolean) as string[];
  const faltaRecorrente = [
    ...faltaBase,
    !recorrente.diasSemana.length && "ao menos um dia da semana",
  ].filter(Boolean) as string[];

  function gerarRecorrente() {
    if (!agendaEmitenteId || !recorrente.diasSemana.length || !recorrente.horarios.length) return;
    criarRecorrenteMut.mutate({
      emitenteId: agendaEmitenteId,
      usuarioId:  agendaUsuarioId || undefined,
      projetoId:  agendaProjetoId || undefined,
      diasSemana: recorrente.diasSemana,
      horarios:   recorrente.horarios,
      semanas:    recorrente.semanas,
    });
  }

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar */}
      <div className="w-72 bg-white border-r flex flex-col">
        <div className="p-4 border-b">
          <h1 className="text-lg font-bold text-gray-800 flex items-center gap-2 mb-3">
            <Video size={20} className="text-indigo-600" /> Reuniões & Agenda
          </h1>
          <div className="flex rounded-lg overflow-hidden border border-gray-200">
            <button
              onClick={() => setTab("reunioes")}
              className={`flex-1 text-xs py-1.5 font-medium transition-colors ${tab === "reunioes" ? "bg-indigo-600 text-white" : "text-gray-600 hover:bg-gray-50"}`}
            >
              Reuniões
            </button>
            <button
              onClick={() => setTab("agenda")}
              className={`flex-1 text-xs py-1.5 font-medium transition-colors ${tab === "agenda" ? "bg-purple-600 text-white" : "text-gray-600 hover:bg-gray-50"}`}
            >
              Agenda SDR
            </button>
          </div>
        </div>

        {tab === "reunioes" && (
          <>
            <div className="px-4 py-2 border-b">
              <button onClick={() => setShowModal(true)}
                className="w-full bg-indigo-600 text-white rounded-lg py-1.5 text-xs font-medium hover:bg-indigo-700 flex items-center justify-center gap-1">
                <Plus size={14} /> Nova reunião
              </button>
            </div>
            <div className="flex-1 overflow-y-auto divide-y">
              {lista.isLoading && <p className="text-center text-gray-400 mt-8 text-sm">Carregando...</p>}
              {(lista.data as Sessao[] | undefined)?.map(s => (
                <button key={s.id}
                  onClick={() => { setSelectedId(s.id); setNotasEdit(s.notas ?? ""); setShowJitsi(false); }}
                  className={`w-full text-left px-4 py-3 hover:bg-gray-50 ${selectedId === s.id ? "bg-indigo-50 border-l-4 border-l-indigo-500" : ""}`}>
                  <div className="flex justify-between items-start">
                    <p className="font-medium text-sm text-gray-800 truncate pr-2">{s.titulo}</p>
                    <span className={`flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full flex-shrink-0 ${STATUS_COLORS[s.status] ?? "bg-gray-100 text-gray-600"}`}>
                      {STATUS_ICONS[s.status]} {s.status}
                    </span>
                  </div>
                  {s.contato && <p className="text-xs text-gray-400 mt-0.5 truncate">{s.contato.nome}</p>}
                  <p className="text-xs text-gray-400 mt-0.5">{formatDateTime(s.agendadaPara ?? s.criadaEm)}</p>
                </button>
              ))}
              {!lista.isLoading && (lista.data as Sessao[] | undefined)?.length === 0 && (
                <p className="text-center text-gray-400 mt-8 text-sm">Nenhuma reunião</p>
              )}
            </div>
          </>
        )}

        {tab === "agenda" && (
          <div className="flex-1 overflow-y-auto">
            {/* Filtros */}
            <div className="p-3 border-b space-y-2">
              <div>
                <label className="text-xs text-gray-500 block mb-1">Escritório</label>
                <select value={agendaEmitenteId} onChange={e => setAgendaEmitenteId(e.target.value)}
                  className="w-full border rounded-lg px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-purple-300">
                  <option value="">Todos</option>
                  {(emitentesQ.data as any[])?.map((e: any) => (
                    <option key={e.id} value={e.id}>{e.razaoSocial ?? e.nomeFantasia ?? e.id}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Advogado</label>
                <select value={agendaUsuarioId} onChange={e => setAgendaUsuarioId(e.target.value)}
                  className="w-full border rounded-lg px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-purple-300">
                  <option value="">Todos</option>
                  {(usuariosQ.data as any[])?.map((u: any) => (
                    <option key={u.id} value={u.id}>{u.nome}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Projeto SDR</label>
                <select value={agendaProjetoId} onChange={e => setAgendaProjetoId(e.target.value)}
                  className="w-full border rounded-lg px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-purple-300">
                  <option value="">Todos</option>
                  {(projetosQ.data as any[])?.map((p: any) => (
                    <option key={p.id} value={p.id}>{p.nome}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Agenda recorrente — colapsável */}
            <div className="border-b">
              <button onClick={() => setShowRecForm(v => !v)}
                className="w-full px-3 py-2.5 text-left text-xs font-medium text-purple-700 flex items-center justify-between hover:bg-purple-50">
                <span className="flex items-center gap-1.5"><CalendarDays size={13} /> Agenda recorrente</span>
                <span>{showRecForm ? "▲" : "▼"}</span>
              </button>
              {showRecForm && (
                <div className="px-3 pb-3 space-y-3">
                  <div>
                    <label className="text-xs text-gray-500 block mb-1">Projeto SDR <span className="text-red-500">*</span></label>
                    <select value={agendaProjetoId} onChange={e => setAgendaProjetoId(e.target.value)}
                      className="w-full border rounded-lg px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-purple-300">
                      <option value="">— selecione o projeto —</option>
                      {(projetosQ.data as any[])?.map((p: any) => (
                        <option key={p.id} value={p.id}>{p.nome}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 block mb-1.5">Dias</label>
                    <div className="flex gap-1 flex-wrap">
                      {DIAS_SEMANA_NOMES.map((d, i) => (
                        <button key={i}
                          onClick={() => setRecorrente(r => ({ ...r, diasSemana: r.diasSemana.includes(i) ? r.diasSemana.filter(x => x !== i) : [...r.diasSemana, i] }))}
                          className={`text-xs px-2 py-1 rounded border transition-colors ${recorrente.diasSemana.includes(i) ? "bg-purple-600 text-white border-purple-600" : "text-gray-600 border-gray-300"}`}>
                          {d}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 block mb-1.5">Horários</label>
                    {recorrente.horarios.map((h, idx) => (
                      <div key={idx} className="flex gap-1.5 items-center mb-1.5">
                        <input type="time" value={h.hora}
                          onChange={e => setRecorrente(r => ({ ...r, horarios: r.horarios.map((x, i) => i === idx ? { ...x, hora: e.target.value } : x) }))}
                          className="border rounded px-1.5 py-1 text-xs outline-none w-24" />
                        <select value={h.durMin}
                          onChange={e => setRecorrente(r => ({ ...r, horarios: r.horarios.map((x, i) => i === idx ? { ...x, durMin: Number(e.target.value) } : x) }))}
                          className="border rounded px-1 py-1 text-xs outline-none flex-1">
                          {[15,20,30,45,60,90,120].map(m => <option key={m} value={m}>{m}min</option>)}
                        </select>
                        {recorrente.horarios.length > 1 && (
                          <button onClick={() => setRecorrente(r => ({ ...r, horarios: r.horarios.filter((_, i) => i !== idx) }))}
                            className="text-red-400 text-xs">✕</button>
                        )}
                      </div>
                    ))}
                    <button onClick={() => setRecorrente(r => ({ ...r, horarios: [...r.horarios, { hora: "14:00", durMin: 30 }] }))}
                      className="text-xs text-purple-600 hover:underline flex items-center gap-1">
                      <Plus size={10} /> Horário
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <input type="number" value={recorrente.semanas} min={1} max={52}
                      onChange={e => setRecorrente(r => ({ ...r, semanas: Number(e.target.value) }))}
                      className="border rounded px-2 py-1 text-xs w-16 outline-none" />
                    <span className="text-xs text-gray-500">semanas</span>
                  </div>
                  <button disabled={!agendaEmitenteId || !agendaProjetoId || !recorrente.diasSemana.length || criarRecorrenteMut.isPending}
                    onClick={gerarRecorrente}
                    className="w-full bg-purple-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-purple-700 disabled:opacity-50">
                    {criarRecorrenteMut.isPending ? "Gerando..." : `Gerar ${recorrente.semanas} semanas`}
                  </button>
                  {faltaRecorrente.length > 0 && (
                    <p className="text-xs text-amber-600">
                      Para habilitar, selecione: {faltaRecorrente.join(", ")}.
                    </p>
                  )}
                  {emitentesVazio && (
                    <p className="text-xs text-red-600">
                      Seu usuário não tem nenhuma empresa emissora liberada — peça a um administrador
                      para marcar o escritório em Usuários → Permissões.
                    </p>
                  )}
                  {criarRecorrenteMut.isSuccess && (
                    <p className="text-xs text-green-600">✓ {criarRecorrenteMut.data?.count} slots criados</p>
                  )}
                </div>
              )}
            </div>

            {/* Horário avulso — colapsável */}
            <div className="border-b">
              <button onClick={() => setShowAvulsoForm(v => !v)}
                className="w-full px-3 py-2.5 text-left text-xs font-medium text-gray-600 flex items-center justify-between hover:bg-gray-50">
                <span className="flex items-center gap-1.5"><Plus size={13} /> Horário avulso</span>
                <span>{showAvulsoForm ? "▲" : "▼"}</span>
              </button>
              {showAvulsoForm && (
                <div className="px-3 pb-3 space-y-2">
                  <div>
                    <label className="text-xs text-gray-500 block mb-1">Projeto SDR <span className="text-red-500">*</span></label>
                    <select value={agendaProjetoId} onChange={e => setAgendaProjetoId(e.target.value)}
                      className="w-full border rounded-lg px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-purple-300">
                      <option value="">— selecione o projeto —</option>
                      {(projetosQ.data as any[])?.map((p: any) => (
                        <option key={p.id} value={p.id}>{p.nome}</option>
                      ))}
                    </select>
                  </div>
                  <input type="date" value={agendaForm.data}
                    onChange={e => setAgendaForm(f => ({ ...f, data: e.target.value }))}
                    className="w-full border rounded px-2 py-1.5 text-xs outline-none" />
                  <div className="flex gap-2">
                    <input type="time" value={agendaForm.horaInicio}
                      onChange={e => setAgendaForm(f => ({ ...f, horaInicio: e.target.value }))}
                      className="flex-1 border rounded px-2 py-1.5 text-xs outline-none" placeholder="Início" />
                    <input type="time" value={agendaForm.horaFim}
                      onChange={e => setAgendaForm(f => ({ ...f, horaFim: e.target.value }))}
                      className="flex-1 border rounded px-2 py-1.5 text-xs outline-none" placeholder="Fim" />
                  </div>
                  <button disabled={!agendaEmitenteId || !agendaProjetoId || !agendaForm.data || !agendaForm.horaInicio || !agendaForm.horaFim || criarSlotMut.isPending}
                    onClick={() => {
                      const inicio = new Date(`${agendaForm.data}T${agendaForm.horaInicio}`);
                      const fim    = new Date(`${agendaForm.data}T${agendaForm.horaFim}`);
                      criarSlotMut.mutate({ emitenteId: agendaEmitenteId, usuarioId: agendaUsuarioId || undefined, projetoId: agendaProjetoId || undefined, inicio: inicio.toISOString(), fim: fim.toISOString() });
                    }}
                    className="w-full bg-gray-700 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-gray-800 disabled:opacity-50">
                    {criarSlotMut.isPending ? "..." : "Adicionar"}
                  </button>
                  {faltaBase.length > 0 && (
                    <p className="text-xs text-amber-600">
                      Para habilitar, selecione: {faltaBase.join(", ")}.
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Legenda */}
            <div className="p-3 space-y-1.5">
              <p className="text-xs font-medium text-gray-500 mb-2">Legenda</p>
              <div className="flex items-center gap-2 text-xs text-gray-500"><span className="w-3 h-3 rounded bg-green-200 inline-block flex-shrink-0" /> Livre — clique para fechar</div>
              <div className="flex items-center gap-2 text-xs text-gray-500"><span className="w-3 h-3 rounded bg-gray-200 inline-block flex-shrink-0" /> Fechado — clique para reabrir</div>
              <div className="flex items-center gap-2 text-xs text-gray-500"><span className="w-3 h-3 rounded bg-orange-200 inline-block flex-shrink-0" /> Reservado</div>
            </div>
          </div>
        )}
      </div>

      {/* Main */}
      {tab === "reunioes" && selectedId && s ? (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Header */}
          <div className="bg-white border-b px-6 py-4 flex justify-between items-center">
            <div>
              <h2 className="font-semibold text-gray-800">{s.titulo}</h2>
              <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                <span className={`flex items-center gap-1 px-2 py-0.5 rounded-full ${STATUS_COLORS[s.status] ?? ""}`}>
                  {STATUS_ICONS[s.status]} {s.status}
                </span>
                {s.contato && <span>{s.contato.nome}</span>}
                {s.deal && <span>Lead: {s.deal.titulo}</span>}
                {s.duracao && <span className="flex items-center gap-1"><Clock size={11} /> {formatDuracao(s.duracao)}</span>}
              </div>
            </div>
            <div className="flex gap-2">
              {/* Link do convidado */}
              <button
                onClick={() => handleCopyLink(s.id, s.tokenConvidado)}
                className="flex items-center gap-1.5 text-xs border rounded-lg px-3 py-2 hover:bg-gray-50">
                {copiedId === s.id ? <CheckCircle size={14} className="text-green-500" /> : <Copy size={14} />}
                {copiedId === s.id ? "Copiado!" : "Link Convidado"}
              </button>

              {s.status !== "encerrada" && s.status !== "cancelada" && (
                <button onClick={handleEntrar}
                  className="flex items-center gap-1.5 text-xs bg-indigo-600 text-white rounded-lg px-3 py-2 hover:bg-indigo-700">
                  <ExternalLink size={14} /> Entrar na Sala
                </button>
              )}

              {s.status === "em_andamento" && (
                <button onClick={() => encerrar.mutate({ id: s.id })}
                  className="flex items-center gap-1.5 text-xs bg-gray-200 text-gray-700 rounded-lg px-3 py-2 hover:bg-gray-300">
                  <CheckCircle size={14} /> Encerrar
                </button>
              )}

              {(s.status === "agendada" || s.status === "em_andamento") && (
                <button onClick={() => cancelar.mutate({ id: s.id })}
                  className="flex items-center gap-1.5 text-xs bg-red-50 text-red-600 rounded-lg px-3 py-2 hover:bg-red-100">
                  <XCircle size={14} /> Cancelar
                </button>
              )}
            </div>
          </div>

          {/* Jitsi iframe */}
          {showJitsi && jitsiUrl ? (
            <div className="flex-1 flex flex-col">
              <div className="bg-indigo-50 border-b px-6 py-2 flex items-center justify-between">
                <p className="text-xs text-indigo-700 flex items-center gap-2">
                  <Video size={12} /> Reunião em andamento
                </p>
                <div className="flex items-center gap-3">
                  {linkConvidado && (
                    <button onClick={() => copyToClipboard(linkConvidado)} className="text-xs text-indigo-600 hover:underline flex items-center gap-1">
                      <Copy size={11} /> Compartilhar link
                    </button>
                  )}
                  <button onClick={() => setShowJitsi(false)} className="text-xs text-gray-500 hover:text-gray-700">
                    Ocultar
                  </button>
                </div>
              </div>
              <iframe
                src={jitsiUrl}
                className="flex-1 border-0"
                allow="camera; microphone; display-capture; fullscreen; autoplay"
                title="Reunião Jitsi"
              />
            </div>
          ) : (
            <div className="flex-1 overflow-auto p-6">
              <div className="max-w-2xl space-y-6">
                {/* Informações */}
                <div className="bg-white rounded-xl border p-5">
                  <h3 className="font-medium text-gray-800 mb-4 text-sm">Informações</h3>
                  <dl className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <dt className="text-xs text-gray-400">Agendada para</dt>
                      <dd className="font-medium text-gray-800">{formatDateTime(s.agendadaPara)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-gray-400">Criada em</dt>
                      <dd className="font-medium text-gray-800">{formatDateTime(s.criadaEm)}</dd>
                    </div>
                    {s.iniciadaEm && (
                      <div>
                        <dt className="text-xs text-gray-400">Iniciada</dt>
                        <dd className="font-medium text-gray-800">{formatDateTime(s.iniciadaEm)}</dd>
                      </div>
                    )}
                    {s.encerradaEm && (
                      <div>
                        <dt className="text-xs text-gray-400">Encerrada</dt>
                        <dd className="font-medium text-gray-800">{formatDateTime(s.encerradaEm)}</dd>
                      </div>
                    )}
                    {s.duracao && (
                      <div>
                        <dt className="text-xs text-gray-400">Duração</dt>
                        <dd className="font-medium text-gray-800">{formatDuracao(s.duracao)}</dd>
                      </div>
                    )}
                  </dl>

                  {/* Link do convidado */}
                  <div className="mt-4 pt-4 border-t">
                    <p className="text-xs text-gray-400 mb-2">Link para o convidado</p>
                    <div className="flex items-center gap-2">
                      <input readOnly value={`${appBase}/sala/${s.tokenConvidado}`}
                        className="flex-1 text-xs border rounded px-2 py-1.5 bg-gray-50 text-gray-600" />
                      <button onClick={() => handleCopyLink(s.id, s.tokenConvidado)}
                        className="text-xs border rounded px-2 py-1.5 hover:bg-gray-50">
                        {copiedId === s.id ? "✓" : "Copiar"}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Notas */}
                <div className="bg-white rounded-xl border p-5">
                  <h3 className="font-medium text-gray-800 mb-3 text-sm flex items-center gap-2">
                    <FileText size={14} /> Notas
                  </h3>
                  <textarea
                    value={notasEdit}
                    onChange={e => setNotasEdit(e.target.value)}
                    rows={6}
                    placeholder="Anotações da reunião..."
                    className="w-full text-sm border rounded-lg px-3 py-2 resize-none outline-none focus:ring-2 focus:ring-indigo-300"
                  />
                  <button
                    onClick={() => updateNotas.mutate({ id: s.id, notas: notasEdit })}
                    disabled={updateNotas.isLoading}
                    className="mt-2 text-xs bg-indigo-600 text-white px-4 py-1.5 rounded-lg hover:bg-indigo-700 disabled:opacity-50">
                    Salvar notas
                  </button>
                </div>

                {/* Copiloto IA — sugestões em tempo real durante a reunião */}
                {emAndamento && copilotoQ.data?.sugestoes && (
                  <div className="bg-amber-50 rounded-xl border border-amber-200 p-5">
                    <h3 className="font-medium text-amber-800 mb-2 text-sm flex items-center gap-2">
                      💡 Copiloto IA
                      <span className="text-[10px] bg-amber-100 text-amber-600 px-2 py-0.5 rounded-full">atualiza a cada 45s</span>
                    </h3>
                    <p className="text-xs text-amber-900 whitespace-pre-wrap">{copilotoQ.data.sugestoes}</p>
                  </div>
                )}

                {/* Relatório IA — gerado automaticamente ao encerrar */}
                {s.resumoIa && (
                  <div className="bg-white rounded-xl border p-5">
                    <h3 className="font-medium text-gray-800 mb-3 text-sm">📋 Relatório da Reunião (IA)</h3>
                    <p className="text-xs text-gray-700 whitespace-pre-wrap bg-gray-50 rounded p-3 max-h-80 overflow-auto">
                      {s.resumoIa}
                    </p>
                  </div>
                )}

                {/* Transcrição — ao vivo (chunks rotulados) ou final (texto montado) */}
                {(transcricaoQ.data?.length ?? 0) > 0 ? (
                  <div className="bg-white rounded-xl border p-5">
                    <h3 className="font-medium text-gray-800 mb-3 text-sm flex items-center gap-2">
                      Transcrição
                      {emAndamento && <span className="text-[10px] bg-red-100 text-red-600 px-2 py-0.5 rounded-full animate-pulse">ao vivo</span>}
                    </h3>
                    <div className="space-y-2 bg-gray-50 rounded p-3 max-h-72 overflow-auto">
                      {transcricaoQ.data!.map(c => (
                        <div key={c.id} className="text-xs">
                          <span className="text-gray-400 mr-1.5">
                            [{String(Math.floor(c.segundos / 60)).padStart(2, "0")}:{String(c.segundos % 60).padStart(2, "0")}]
                          </span>
                          <span className={`font-semibold mr-1 ${c.role === "convidado" ? "text-green-700" : "text-indigo-700"}`}>
                            {c.nome}:
                          </span>
                          <span className="text-gray-700">{c.texto}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : s.transcricao ? (
                  <div className="bg-white rounded-xl border p-5">
                    <h3 className="font-medium text-gray-800 mb-3 text-sm">Transcrição</h3>
                    <p className="text-xs text-gray-600 whitespace-pre-wrap bg-gray-50 rounded p-3 max-h-72 overflow-auto">
                      {s.transcricao}
                    </p>
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>
      ) : tab === "agenda" ? (null) : (
        <div className="flex-1 flex items-center justify-center text-gray-400">
          <div className="text-center">
            <Video size={48} className="mx-auto mb-3 opacity-30" />
            <p className="text-lg font-medium">Selecione uma reunião</p>
            <p className="text-sm mt-1">ou crie uma nova com o botão +</p>
          </div>
        </div>
      )}

      {/* Agenda main panel — calendário semanal */}
      {tab === "agenda" && (
        <div className="flex-1 p-4 overflow-auto bg-gray-50">
          {/* Week navigation */}
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-bold text-gray-800 flex items-center gap-2">
              <CalendarDays size={18} className="text-purple-600" /> Agenda
              <span className="text-xs font-normal text-gray-500">
                · {((reunioesSemanaQ.data as any[] | undefined) ?? []).filter(r => r.status === "agendada").length} reunião(ões) marcada(s) na semana
              </span>
            </h2>
            <div className="flex items-center gap-2">
              <button onClick={() => setWeekOffset(w => w - 1)}
                className="p-1.5 border rounded-lg bg-white hover:bg-gray-50 text-gray-600">
                <ChevronLeft size={15} />
              </button>
              <span className="text-sm font-medium text-gray-700 min-w-[200px] text-center">
                {monday.toLocaleDateString("pt-BR", { day: "2-digit", month: "long" })} – {sunday.toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" })}
              </span>
              <button onClick={() => setWeekOffset(w => w + 1)}
                className="p-1.5 border rounded-lg bg-white hover:bg-gray-50 text-gray-600">
                <ChevronRight size={15} />
              </button>
              {weekOffset !== 0 && (
                <button onClick={() => setWeekOffset(0)}
                  className="text-xs text-purple-600 hover:underline border rounded-lg px-2 py-1.5 bg-white">
                  Hoje
                </button>
              )}
            </div>
          </div>

          {/* Calendar grid */}
          <div className="bg-white rounded-xl border overflow-hidden">
            {/* Day headers */}
            <div className="grid grid-cols-7 border-b bg-gray-50">
              {Array.from({ length: 7 }, (_, i) => {
                const d = new Date(monday);
                d.setDate(monday.getDate() + i);
                const isToday = d.toDateString() === new Date().toDateString();
                return (
                  <div key={i} className={`p-2 text-center border-r last:border-r-0 ${isToday ? "bg-purple-50" : ""}`}>
                    <p className={`text-xs font-semibold uppercase tracking-wide ${isToday ? "text-purple-700" : "text-gray-500"}`}>
                      {DIAS_SEMANA_NOMES[d.getDay()]}
                    </p>
                    <p className={`text-lg font-bold leading-tight ${isToday ? "text-purple-700" : "text-gray-700"}`}>
                      {d.getDate()}
                    </p>
                    <p className="text-xs text-gray-400">
                      {d.toLocaleDateString("pt-BR", { month: "short" })}
                    </p>
                  </div>
                );
              })}
            </div>
            {/* Slot cells */}
            <div className="grid grid-cols-7" style={{ minHeight: 220 }}>
              {Array.from({ length: 7 }, (_, i) => {
                const d = new Date(monday);
                d.setDate(monday.getDate() + i);
                // Horário reservado por uma reunião que já aparece como cartão não se repete.
                const daySlots: any[] = (slotsByDay[d.toDateString()] ?? []).filter((sl: any) => !sl.reuniaoId || !idsReunioesSemana.has(sl.reuniaoId));
                const dayReunioes: any[] = reunioesPorDia[d.toDateString()] ?? [];
                const isToday = d.toDateString() === new Date().toDateString();
                return (
                  <div key={i} className={`p-1.5 border-r last:border-r-0 space-y-1 ${isToday ? "bg-purple-50/20" : ""}`}>
                    {agendaQ.isLoading && i === 0 && (
                      <p className="text-xs text-gray-400 text-center mt-4">...</p>
                    )}
                    {dayReunioes.map((r: any) => {
                      const st = STATUS_REUNIAO[r.status] ?? { rotulo: r.status, cor: "bg-gray-100 text-gray-600" };
                      return (
                        <button key={r.id} onClick={() => setReuniaoAberta(r)}
                          title={r.pauta ? `Pauta: ${r.pauta}` : r.titulo}
                          className={`w-full text-left rounded px-1.5 py-1 text-xs border transition-colors ${
                            r.status === "agendada" ? "bg-indigo-50 border-indigo-200 hover:bg-indigo-100 text-indigo-900"
                            : r.status === "cancelada" ? "bg-gray-50 border-gray-200 text-gray-400 line-through"
                            : "bg-white border-gray-200 hover:bg-gray-50 text-gray-700"}`}>
                          <p className="font-semibold tabular-nums leading-tight">
                            {new Date(r.agendadaPara).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                            <span className="font-normal opacity-60"> · {r.duracaoMin}min</span>
                          </p>
                          <p className="truncate font-medium">{r.contato?.nome ?? r.deal?.titulo ?? r.titulo}</p>
                          <p className="truncate opacity-70">{r.responsavelNome?.split(" ")[0] ?? "sem responsável"} · {(ROTULO_MODALIDADE[r.modalidade] ?? r.modalidade).replace(/^\S+\s/, "")}</p>
                          {r.status !== "agendada" && <p className={`mt-0.5 inline-block px-1 rounded ${st.cor}`}>{st.rotulo}</p>}
                        </button>
                      );
                    })}
                    {daySlots.map((slot: any) => {
                      const reservado = !slot.disponivel && slot.reuniaoId;
                      const fechado   = !slot.disponivel && !slot.reuniaoId;
                      return (
                        <div key={slot.id}
                          onClick={() => {
                            if (slot.disponivel) fecharSlotMut.mutate({ id: slot.id });
                            else if (fechado) reabrirSlotMut.mutate({ id: slot.id });
                          }}
                          title={reservado ? "Reservado por cliente" : slot.disponivel ? "Livre — clique para fechar" : "Fechado — clique para reabrir"}
                          className={`rounded px-1.5 py-1 text-xs select-none transition-opacity group
                            ${slot.disponivel  ? "bg-green-100 hover:bg-green-200 text-green-900 cursor-pointer" :
                              reservado        ? "bg-orange-100 text-orange-900 cursor-default" :
                                                 "bg-gray-100 text-gray-500 opacity-60 hover:opacity-80 cursor-pointer"}`}
                        >
                          <p className="font-semibold tabular-nums leading-tight">
                            {new Date(slot.inicio).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                          </p>
                          <p className="opacity-70 leading-tight">
                            {new Date(slot.fim).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                          </p>
                          {reservado && (
                            <p className="text-orange-600 font-medium mt-0.5 truncate">
                              {(slot as any).dealTitulo ?? "reservado"}
                            </p>
                          )}
                          {fechado   && <p className="text-gray-400 mt-0.5">fechado</p>}
                          {slot.usuario?.nome && (
                            <p className="truncate opacity-60 mt-0.5">{slot.usuario.nome.split(" ")[0]}</p>
                          )}
                          {(slot.disponivel || fechado) && (
                            <button onClick={e => { e.stopPropagation(); deletarSlotMut.mutate({ id: slot.id }); }}
                              className="hidden group-hover:block text-red-400 hover:text-red-600 mt-0.5">
                              <Trash2 size={10} />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>

          {faltaBase.length > 0 && (
            <p className="text-center text-sm text-gray-400 mt-6">
              Para criar horários livres (slots), selecione {faltaBase.join(" e ")} na barra lateral. As reuniões marcadas aparecem sempre.
            </p>
          )}
        </div>
      )}

      {/* Detalhe da reunião clicada na agenda */}
      {reuniaoAberta && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onMouseDown={() => setReuniaoAberta(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-5 text-sm space-y-2" onMouseDown={e => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold text-gray-800">{reuniaoAberta.contato?.nome ?? reuniaoAberta.deal?.titulo ?? reuniaoAberta.titulo}</p>
                <p className="text-xs text-gray-500">
                  {reuniaoAberta.agendadaPara ? dataHoraTxt(reuniaoAberta.agendadaPara) : "sem data"} · {reuniaoAberta.duracaoMin} min · {ROTULO_MODALIDADE[reuniaoAberta.modalidade] ?? reuniaoAberta.modalidade}
                </p>
              </div>
              <span className={`text-xs px-1.5 py-0.5 rounded-full ${(STATUS_REUNIAO[reuniaoAberta.status] ?? { cor: "bg-gray-100" }).cor}`}>
                {(STATUS_REUNIAO[reuniaoAberta.status] ?? { rotulo: reuniaoAberta.status }).rotulo}
              </span>
            </div>
            <p className="text-xs text-gray-600">
              Conduz: <b>{reuniaoAberta.responsavelNome ?? "—"}</b>
              {reuniaoAberta.marcadaPorNome && <> · marcada por {reuniaoAberta.marcadaPorNome}</>}
            </p>
            {reuniaoAberta.deal?.pipeline && (
              <p className="text-xs text-gray-500">{reuniaoAberta.deal.pipeline.nome}{reuniaoAberta.deal.stage ? ` · ${reuniaoAberta.deal.stage.nome}` : ""}</p>
            )}
            <div className="text-xs">
              <p className="text-gray-400">Pauta</p>
              <p className="text-gray-800 whitespace-pre-wrap">{reuniaoAberta.pauta || "—"}</p>
            </div>
            <div className="text-xs">
              <p className="text-gray-400">Anotações</p>
              <p className="text-gray-800 whitespace-pre-wrap">{reuniaoAberta.notas || "—"}</p>
            </div>
            <div className="flex flex-wrap gap-2 pt-2 border-t">
              {reuniaoAberta.deal?.id && (
                <button onClick={() => navigate(`/whatsapp?dealId=${reuniaoAberta.deal.id}`)}
                  className="text-xs px-2.5 py-1 rounded-md border hover:bg-gray-50">Abrir conversa</button>
              )}
              {reuniaoAberta.deal?.id && (
                <button onClick={() => { setEditandoReuniao(reuniaoAberta); setReuniaoAberta(null); }}
                  className="text-xs px-2.5 py-1 rounded-md border hover:bg-gray-50">Editar / remarcar</button>
              )}
              {reuniaoAberta.modalidade === "video" && ["agendada", "em_andamento"].includes(reuniaoAberta.status) && (
                <button onClick={() => { setSelectedId(reuniaoAberta.id); setTab("reunioes"); setReuniaoAberta(null); }}
                  className="text-xs px-2.5 py-1 rounded-md bg-indigo-600 text-white hover:bg-indigo-700">Ir para a sala</button>
              )}
              <button onClick={() => setReuniaoAberta(null)} className="text-xs px-2.5 py-1 rounded-md border ml-auto">Fechar</button>
            </div>
          </div>
        </div>
      )}
      {editandoReuniao?.deal?.id && (
        <AgendarReuniaoModal dealId={editandoReuniao.deal.id} reuniao={editandoReuniao}
          onClose={() => setEditandoReuniao(null)} onSalvo={() => reunioesSemanaQ.refetch()} />
      )}

      {/* Modal criar */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl p-6 w-96 shadow-xl">
            <h3 className="font-semibold text-gray-800 mb-4">Nova Reunião</h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 block mb-1">Título *</label>
                <input value={novaForm.titulo} onChange={e => setNovaForm(f => ({ ...f, titulo: e.target.value }))}
                  placeholder="Ex: Reunião com João Silva"
                  className="w-full border rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-300" />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Data/Hora (opcional)</label>
                <input type="datetime-local" value={novaForm.agendadaPara}
                  onChange={e => setNovaForm(f => ({ ...f, agendadaPara: e.target.value }))}
                  className="w-full border rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-300" />
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={() => setShowModal(false)} className="flex-1 border rounded-lg py-2 text-sm text-gray-600">Cancelar</button>
              <button
                onClick={() => criar.mutate({ titulo: novaForm.titulo, agendadaPara: novaForm.agendadaPara || undefined })}
                disabled={!novaForm.titulo.trim() || criar.isLoading}
                className="flex-1 bg-indigo-600 text-white rounded-lg py-2 text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
                Criar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
