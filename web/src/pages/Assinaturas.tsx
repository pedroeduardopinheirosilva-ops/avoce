import { useEffect, useMemo, useRef, useState } from "react";
import {
  PenLine, Plus, RefreshCw, Download, Send, Trash2, X, Sparkles, Upload,
  CheckCircle2, Clock, XCircle, FileSignature, MessageSquare, Mail, Building2,
  ArrowLeft, Users, Inbox,
} from "lucide-react";
import { trpc } from "../lib/trpc";

// ── Tipos ─────────────────────────────────────────────────────────────────────

type Papel = "SIGNER" | "WITNESS" | "APPROVER";

type SignatarioForm = {
  uid: number;
  nome: string;
  email: string;
  cpf: string;
  telefone: string;
  papel: Papel;
};

// ── Constantes de apresentação ────────────────────────────────────────────────

const STATUS_META: Record<string, { label: string; cls: string; icon: JSX.Element }> = {
  DRAFT:     { label: "Rascunho",  cls: "bg-gray-100 text-gray-600",     icon: <FileSignature size={13} /> },
  PENDING:   { label: "Aguardando", cls: "bg-amber-100 text-amber-700",  icon: <Clock size={13} /> },
  COMPLETED: { label: "Concluído", cls: "bg-green-100 text-green-700",   icon: <CheckCircle2 size={13} /> },
  EXPIRED:   { label: "Expirado",  cls: "bg-red-100 text-red-600",       icon: <XCircle size={13} /> },
  CANCELLED: { label: "Cancelado", cls: "bg-red-100 text-red-600",       icon: <XCircle size={13} /> },
};

const SIGNER_STATUS: Record<string, string> = {
  PENDING_VIEW:      "Aguardando visualização",
  PENDING_SELFIE:    "Aguardando selfie",
  PENDING_PAYMENT:   "Aguardando validação bancária",
  PENDING_SIGNATURE: "Aguardando assinatura",
  SIGNED:            "Assinado",
  REJECTED:          "Rejeitado",
};

const PAPEL_META: Record<Papel, { label: string; desc: string; cls: string }> = {
  SIGNER:   { label: "Signatário", desc: "assina o documento",       cls: "border-l-sky-500" },
  WITNESS:  { label: "Testemunha", desc: "assina como testemunha",   cls: "border-l-amber-500" },
  APPROVER: { label: "Aprovador",  desc: "aprova sem assinar",       cls: "border-l-emerald-500" },
};

function fmtData(iso: string | Date | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function Badge({ status }: { status: string }) {
  const m = STATUS_META[status] ?? { label: status, cls: "bg-gray-100 text-gray-600", icon: <></> };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${m.cls}`}>
      {m.icon}{m.label}
    </span>
  );
}

function baixar(id: string, tipo: "original" | "assinado", nome: string) {
  const token = localStorage.getItem("avoce_token");
  fetch(`/api/assinatura/${id}/download?tipo=${tipo}`, { headers: { Authorization: `Bearer ${token}` } })
    .then(async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Erro ${r.status}`);
      return r.blob();
    })
    .then((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${nome.replace(/[^a-zA-Z0-9]+/g, "-")}${tipo === "assinado" ? "-assinado" : ""}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
    })
    .catch((e) => alert("Não foi possível baixar: " + e.message));
}

// ── Página ────────────────────────────────────────────────────────────────────

export default function Assinaturas() {
  const utils = trpc.useUtils();
  const [tela, setTela] = useState<"lista" | "novo">("lista");
  const [detalheId, setDetalheId] = useState<string | null>(null);
  const [filtroStatus, setFiltroStatus] = useState<string>("");
  const [filtroEmitente, setFiltroEmitente] = useState<string>("");

  const emitentesQ = trpc.empresa.listar.useQuery();
  const listaQ = trpc.assinatura.listar.useQuery({
    status: filtroStatus || undefined,
    emitenteId: filtroEmitente || undefined,
    limite: 100,
  });

  const sincronizarMut = trpc.assinatura.sincronizar.useMutation({
    onSuccess: (r) => { utils.assinatura.invalidate(); if (r.erros) alert(`${r.sincronizados} atualizados, ${r.erros} com erro.`); },
    onError: (e) => alert("Erro ao sincronizar: " + e.message),
  });

  const importarMut = trpc.assinatura.importarDoPakt.useMutation({
    onSuccess: (r) => {
      utils.assinatura.invalidate();
      alert(r.importados > 0
        ? `${r.importados} documento(s) resgatado(s) do PAKT.`
        : "Nenhum documento novo — tudo já estava sincronizado.");
    },
    onError: (e) => alert("Erro ao importar: " + e.message),
  });

  const emitentes = emitentesQ.data ?? [];

  function importarDoPakt() {
    const alvo = filtroEmitente || emitentes[0]?.id;
    if (!alvo) return alert("Cadastre um escritório emissor antes de importar.");
    const nome = emitentes.find((e) => e.id === alvo)?.nomeFantasia ?? "";
    if (!confirm(
      `A conta PAKT é compartilhada com o PSA DOCS: a importação também trará documentos criados por lá.\n\n` +
      `Os documentos resgatados serão vinculados ao escritório ${nome}. Continuar?`
    )) return;
    importarMut.mutate({ emitenteId: alvo });
  }

  if (tela === "novo") {
    return (
      <NovoDocumento
        emitentes={emitentes}
        onCancelar={() => setTela("lista")}
        onCriado={(id) => { utils.assinatura.invalidate(); setTela("lista"); setDetalheId(id); }}
      />
    );
  }

  const docs = listaQ.data ?? [];

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-5 gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2">
            <PenLine size={20} className="text-sky-700" /> Assinaturas
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Documentos enviados para assinatura eletrônica com verificação de identidade (PAKT)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => sincronizarMut.mutate()}
            disabled={sincronizarMut.isPending}
            className="inline-flex items-center gap-1.5 px-3 py-2 border rounded-lg text-sm bg-white hover:bg-gray-50 text-gray-700 disabled:opacity-50"
          >
            <RefreshCw size={14} className={sincronizarMut.isPending ? "animate-spin" : ""} /> Atualizar
          </button>
          <button
            onClick={importarDoPakt}
            disabled={importarMut.isPending}
            title="Resgata documentos que estão no PAKT mas não aparecem nesta lista"
            className="inline-flex items-center gap-1.5 px-3 py-2 border rounded-lg text-sm bg-white hover:bg-gray-50 text-gray-700 disabled:opacity-50"
          >
            <Inbox size={14} /> Importar do PAKT
          </button>
          <button
            onClick={() => setTela("novo")}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-sky-700 text-white hover:bg-sky-800"
          >
            <Plus size={15} /> Novo documento
          </button>
        </div>
      </div>

      {/* Filtros */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {["", "DRAFT", "PENDING", "COMPLETED", "CANCELLED"].map((s) => (
          <button
            key={s || "todos"}
            onClick={() => setFiltroStatus(s)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              filtroStatus === s ? "bg-sky-700 text-white border-sky-700" : "bg-white text-gray-600 hover:bg-gray-50"
            }`}
          >
            {s ? STATUS_META[s]?.label ?? s : "Todos"}
          </button>
        ))}
        <span className="w-px h-5 bg-gray-200 mx-1" />
        <select
          value={filtroEmitente}
          onChange={(e) => setFiltroEmitente(e.target.value)}
          className="px-3 py-1.5 border rounded-lg text-xs bg-white text-gray-700"
        >
          <option value="">Todos os escritórios</option>
          {emitentes.map((e) => (
            <option key={e.id} value={e.id}>{e.nomeFantasia || e.nome}</option>
          ))}
        </select>
      </div>

      {/* Lista */}
      <div className="bg-white rounded-xl border overflow-hidden">
        {listaQ.isLoading ? (
          <p className="p-10 text-center text-gray-400 text-sm">Carregando…</p>
        ) : docs.length === 0 ? (
          <div className="p-12 text-center text-gray-400">
            <FileSignature size={44} className="mx-auto mb-3 opacity-30" />
            <p className="font-medium">Nenhum documento para assinatura</p>
            <p className="text-sm mt-1">Clique em “Novo documento” para enviar o primeiro.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
                <th className="px-4 py-2.5 font-semibold">Documento</th>
                <th className="px-4 py-2.5 font-semibold">Escritório</th>
                <th className="px-4 py-2.5 font-semibold">Status</th>
                <th className="px-4 py-2.5 font-semibold">Signatários</th>
                <th className="px-4 py-2.5 font-semibold">Solicitado por</th>
                <th className="px-4 py-2.5 font-semibold">Data</th>
                <th className="px-4 py-2.5 font-semibold text-right">Ações</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id} className="border-b last:border-b-0 hover:bg-gray-50/70">
                  <td className="px-4 py-3">
                    <button onClick={() => setDetalheId(d.id)} className="font-medium text-gray-800 hover:text-sky-700 text-left">
                      {d.nome}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-gray-600">
                      <Building2 size={12} className="text-gray-400" /> {d.escritorio}
                    </span>
                  </td>
                  <td className="px-4 py-3"><Badge status={d.status} /></td>
                  <td className="px-4 py-3 text-xs text-gray-600">
                    {d.signatarios.map((s, i) => (
                      <div key={i} className="truncate max-w-[240px]">
                        {s.nome}
                        <span className={`ml-1 ${s.status === "SIGNED" ? "text-green-600" : "text-gray-400"}`}>
                          · {SIGNER_STATUS[s.status] ?? s.status ?? "—"}
                        </span>
                      </div>
                    ))}
                    <div className="flex gap-2 mt-1">
                      {d.emailEnviado && <span className="text-[11px] text-sky-600 inline-flex items-center gap-0.5"><Mail size={10} /> e-mail</span>}
                      {d.whatsappEnviado && <span className="text-[11px] text-green-600 inline-flex items-center gap-0.5"><MessageSquare size={10} /> WhatsApp</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600">{d.criadoPorNome ?? "—"}</td>
                  <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtData(d.criadoEm)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1.5">
                      {d.status === "COMPLETED" && (
                        <button
                          onClick={() => baixar(d.id, "assinado", d.nome)}
                          title="Baixar PDF assinado"
                          className="p-1.5 rounded-lg border bg-green-50 border-green-200 text-green-700 hover:bg-green-100"
                        >
                          <Download size={14} />
                        </button>
                      )}
                      <button onClick={() => setDetalheId(d.id)} className="px-2.5 py-1.5 rounded-lg border bg-white hover:bg-gray-50 text-xs text-gray-700">
                        Ver
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {detalheId && <PainelDetalhe id={detalheId} onFechar={() => setDetalheId(null)} />}
    </div>
  );
}

// ── Detalhe ───────────────────────────────────────────────────────────────────

function PainelDetalhe({ id, onFechar }: { id: string; onFechar: () => void }) {
  const utils = trpc.useUtils();
  const docQ = trpc.assinatura.obter.useQuery({ id });

  const enviarMut = trpc.assinatura.enviar.useMutation({
    onSuccess: (r) => {
      utils.assinatura.invalidate();
      alert(
        `Documento enviado para assinatura.\n\n` +
        `• Convite do PAKT: enviado por e-mail a todos os signatários\n` +
        `• WhatsApp em nome do escritório: ${r.whatsappsEnviados}\n` +
        `• E-mail em nome do escritório: ${r.emailsEnviados}` +
        (r.erros.length ? `\n\nAvisos:\n- ${r.erros.join("\n- ")}` : ""),
      );
    },
    onError: (e) => alert("Erro ao enviar: " + e.message),
  });
  const reenviarMut = trpc.assinatura.reenviarConvites.useMutation({
    onSuccess: (r) => {
      utils.assinatura.invalidate();
      alert(r.whatsappsEnviados > 0
        ? `Link reenviado por WhatsApp para ${r.whatsappsEnviados} signatário(s).`
        : "Nenhum signatário com WhatsApp cadastrado — nada foi reenviado.");
    },
    onError: (e) => alert("Erro: " + e.message),
  });
  const reenviarAssinadoMut = trpc.assinatura.reenviarAssinado.useMutation({
    onSuccess: (r) => { utils.assinatura.invalidate(); alert(`PDF assinado enviado para ${r.enviados} número(s).`); },
    onError: (e) => alert("Erro: " + e.message),
  });
  const cancelarMut = trpc.assinatura.cancelar.useMutation({
    onSuccess: () => { utils.assinatura.invalidate(); },
    onError: (e) => alert("Erro ao cancelar: " + e.message),
  });
  const excluirMut = trpc.assinatura.excluir.useMutation({
    onSuccess: () => { utils.assinatura.invalidate(); onFechar(); },
    onError: (e) => alert("Erro ao excluir: " + e.message),
  });

  const d = docQ.data;
  const ocupado = enviarMut.isPending || reenviarMut.isPending || cancelarMut.isPending;

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onFechar}>
      <div
        className="w-full max-w-2xl bg-gray-50 h-full overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b px-5 py-3.5 flex items-center justify-between z-10">
          <div className="min-w-0">
            <h2 className="font-bold text-gray-800 truncate">{d?.nome ?? "Carregando…"}</h2>
            {d && <p className="text-xs text-gray-500 mt-0.5">Escritório remetente: <strong>{d.escritorio}</strong></p>}
          </div>
          <button onClick={onFechar} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500"><X size={18} /></button>
        </div>

        {!d ? (
          <p className="p-10 text-center text-gray-400 text-sm">Carregando…</p>
        ) : (
          <div className="p-5 space-y-4">
            {/* Info + ações */}
            <div className="bg-white rounded-xl border p-4">
              <div className="flex items-center justify-between mb-3">
                <Badge status={d.status} />
                <span className="text-xs text-gray-500">{fmtData(d.criadoEm)}</span>
              </div>
              <dl className="text-sm space-y-1.5 mb-4">
                <div className="flex justify-between"><dt className="text-gray-500">Solicitado por</dt><dd className="text-gray-800">{d.criadoPorNome ?? "—"}</dd></div>
                <div className="flex justify-between"><dt className="text-gray-500">Arquivo</dt><dd className="text-gray-800 truncate max-w-[60%]">{d.arquivoNome ?? "—"}</dd></div>
                {d.mensagem && (
                  <div className="pt-2">
                    <dt className="text-gray-500 mb-1">Mensagem enviada</dt>
                    <dd className="text-gray-700 text-[13px] bg-gray-50 border-l-2 border-sky-600 px-3 py-2 rounded-r whitespace-pre-wrap">{d.mensagem}</dd>
                  </div>
                )}
              </dl>

              <div className="flex flex-wrap gap-2">
                {d.status === "DRAFT" && (
                  <button
                    onClick={() => enviarMut.mutate({ id })}
                    disabled={ocupado}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold bg-sky-700 text-white hover:bg-sky-800 disabled:opacity-50"
                  >
                    <Send size={14} /> Enviar para assinatura
                  </button>
                )}
                {d.status === "PENDING" && (
                  <button
                    onClick={() => reenviarMut.mutate({ id, email: false, whatsapp: true })}
                    disabled={ocupado}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm border bg-white hover:bg-gray-50 text-gray-700 disabled:opacity-50"
                  >
                    <MessageSquare size={14} /> Reenviar link por WhatsApp
                  </button>
                )}
                <button
                  onClick={() => baixar(id, "original", d.nome)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm border bg-white hover:bg-gray-50 text-gray-700"
                >
                  <Download size={14} /> Original
                </button>
                {d.status === "COMPLETED" && (
                  <>
                    <button
                      onClick={() => baixar(id, "assinado", d.nome)}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold bg-green-600 text-white hover:bg-green-700"
                    >
                      <Download size={14} /> PDF assinado
                    </button>
                    <button
                      onClick={() => reenviarAssinadoMut.mutate({ id })}
                      disabled={reenviarAssinadoMut.isPending}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm border bg-white hover:bg-gray-50 text-gray-700 disabled:opacity-50"
                    >
                      <MessageSquare size={14} /> Reenviar assinado
                    </button>
                  </>
                )}
                {["DRAFT", "PENDING"].includes(d.status) && (
                  <button
                    onClick={() => confirm("Cancelar este documento no PAKT? A ação é irreversível.") && cancelarMut.mutate({ id })}
                    disabled={ocupado}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm border border-red-200 bg-red-50 text-red-600 hover:bg-red-100 disabled:opacity-50"
                  >
                    <XCircle size={14} /> Cancelar
                  </button>
                )}
                {d.status !== "PENDING" && (
                  <button
                    onClick={() => confirm("Remover este documento da lista do Avoce? O registro no PAKT é mantido.") && excluirMut.mutate({ id })}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm border bg-white hover:bg-gray-50 text-gray-500"
                  >
                    <Trash2 size={14} /> Remover
                  </button>
                )}
              </div>
            </div>

            {/* Signatários */}
            <div className="bg-white rounded-xl border p-4">
              <h3 className="font-semibold text-sm text-gray-800 mb-3 flex items-center gap-1.5">
                <Users size={15} className="text-gray-400" /> Signatários
              </h3>
              <div className="divide-y">
                {d.signatarios.map((s, i) => (
                  <div key={i} className="py-2.5 first:pt-0 last:pb-0">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium text-sm text-gray-800">{s.nome}</span>
                      <span className={`text-xs font-semibold ${s.status === "SIGNED" ? "text-green-600" : "text-gray-500"}`}>
                        {SIGNER_STATUS[s.status] ?? s.status ?? "—"}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {s.email}{s.telefone ? ` · ${s.telefone}` : ""}{s.cpf ? ` · ${s.cpf}` : ""}
                    </p>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 font-medium">
                        {PAPEL_META[s.papel as Papel]?.label ?? s.papel}
                      </span>
                      {s.signUrl && s.status !== "SIGNED" && (
                        <a href={s.signUrl} target="_blank" rel="noreferrer" className="text-[11px] text-sky-700 hover:underline">
                          link de assinatura
                        </a>
                      )}
                      {s.signedAt && <span className="text-[11px] text-gray-400">assinado em {fmtData(s.signedAt)}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Trilha */}
            {d.auditoria.length > 0 && (
              <div className="bg-white rounded-xl border p-4">
                <h3 className="font-semibold text-sm text-gray-800 mb-3">Trilha de auditoria</h3>
                <div className="space-y-1.5 text-xs">
                  {d.auditoria.map((e, i) => (
                    <div key={i} className="flex gap-3">
                      <span className="text-gray-400 whitespace-nowrap tabular-nums">{fmtData(e.createdAt)}</span>
                      <span className="text-gray-700">{e.evento}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Criação ───────────────────────────────────────────────────────────────────

function NovoDocumento({
  emitentes,
  onCancelar,
  onCriado,
}: {
  emitentes: Array<{ id: string; nome: string; nomeFantasia: string | null }>;
  onCancelar: () => void;
  onCriado: (id: string) => void;
}) {
  const [emitenteId, setEmitenteId] = useState("");
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [nomeDoc, setNomeDoc] = useState("");
  const [mensagem, setMensagem] = useState("");
  const [signatarios, setSignatarios] = useState<SignatarioForm[]>([]);
  const [analisando, setAnalisando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState("");
  const [enviarAgora, setEnviarAgora] = useState(true);
  const [enviarEmail, setEnviarEmail] = useState(false);
  const [enviarWhatsapp, setEnviarWhatsapp] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const utils = trpc.useUtils();

  const enviarMut = trpc.assinatura.enviar.useMutation();

  useEffect(() => {
    if (!emitenteId && emitentes.length === 1) setEmitenteId(emitentes[0].id);
  }, [emitentes, emitenteId]);

  const escritorio = useMemo(() => {
    const e = emitentes.find((x) => x.id === emitenteId);
    return e ? (e.nomeFantasia || e.nome) : "";
  }, [emitentes, emitenteId]);

  // A mensagem padrão cita o escritório escolhido; trocar de escritório atualiza
  // o texto enquanto o usuário não tiver escrito o dele.
  const mensagemPadrao = escritorio
    ? `Segue documento do escritório ${escritorio} para sua assinatura eletrônica. Por favor, leia com atenção antes de assinar.`
    : "";
  const [mensagemTocada, setMensagemTocada] = useState(false);
  useEffect(() => {
    if (!mensagemTocada) setMensagem(mensagemPadrao);
  }, [mensagemPadrao, mensagemTocada]);

  function selecionarArquivo(f: File | null | undefined) {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".pdf")) { setErro("Somente arquivos PDF são aceitos."); return; }
    setErro("");
    setArquivo(f);
    if (!nomeDoc) setNomeDoc(f.name.replace(/\.pdf$/i, ""));
    if (signatarios.length === 0) adicionarSignatario();
  }

  function adicionarSignatario() {
    setSignatarios((s) => [
      ...s,
      { uid: Date.now() + Math.random(), nome: "", email: "", cpf: "", telefone: "", papel: "SIGNER" },
    ]);
  }

  function atualizar(uid: number, campo: keyof SignatarioForm, valor: string) {
    setSignatarios((s) => s.map((x) => (x.uid === uid ? { ...x, [campo]: valor } : x)));
  }

  async function analisarComIa() {
    if (!arquivo) return;
    setAnalisando(true);
    setErro("");
    try {
      const fd = new FormData();
      fd.append("file", arquivo);
      const token = localStorage.getItem("avoce_token");
      const res = await fetch("/api/assinatura/analisar", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Erro ${res.status}`);
      const data = await res.json() as { nomeDocumento: string; signatarios: Array<Omit<SignatarioForm, "uid">> };
      if (data.nomeDocumento) setNomeDoc(data.nomeDocumento);
      if (data.signatarios?.length) {
        setSignatarios(data.signatarios.map((s, i) => ({ ...s, uid: Date.now() + i })));
      } else {
        setErro("A IA não identificou signatários neste PDF — preencha manualmente.");
      }
    } catch (e) {
      setErro("Falha na análise: " + (e as Error).message);
    } finally {
      setAnalisando(false);
    }
  }

  async function criar() {
    setErro("");
    if (!emitenteId) return setErro("Escolha o escritório remetente.");
    if (!arquivo) return setErro("Selecione o PDF do documento.");
    const validos = signatarios.filter((s) => s.nome.trim() && s.email.trim());
    if (validos.length === 0) return setErro("Informe ao menos um signatário com nome e e-mail.");
    if (signatarios.some((s) => (s.nome.trim() || s.email.trim()) && !(s.nome.trim() && s.email.trim())))
      return setErro("Todo signatário precisa de nome e e-mail.");

    setEnviando(true);
    try {
      const fd = new FormData();
      fd.append("file", arquivo);
      fd.append("metadata", JSON.stringify({
        emitenteId,
        nome: nomeDoc.trim() || arquivo.name.replace(/\.pdf$/i, ""),
        mensagem: mensagem.trim(),
        signatarios: validos.map(({ uid: _uid, ...s }) => s),
      }));
      const token = localStorage.getItem("avoce_token");
      const res = await fetch("/api/assinatura/criar", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Erro ${res.status}`);
      const data = await res.json() as { id: string };

      if (enviarAgora) {
        const r = await enviarMut.mutateAsync({ id: data.id, email: enviarEmail, whatsapp: enviarWhatsapp });
        if (r.erros.length) alert(`Documento enviado com avisos:\n- ${r.erros.join("\n- ")}`);
      }
      utils.assinatura.invalidate();
      onCriado(data.id);
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-3 mb-5">
        <button onClick={onCancelar} className="p-1.5 rounded-lg border bg-white hover:bg-gray-50 text-gray-600">
          <ArrowLeft size={16} />
        </button>
        <h1 className="text-lg font-bold text-gray-800">Novo documento para assinatura</h1>
      </div>

      {/* Passo 1 — escritório remetente */}
      <section className="bg-white rounded-xl border p-5 mb-4">
        <p className="text-[11px] font-bold uppercase tracking-wider text-gray-400 mb-1">Passo 1</p>
        <h2 className="font-semibold text-gray-800 mb-1">Escritório remetente</h2>
        <p className="text-xs text-gray-500 mb-3">
          É este nome que aparece no texto do e-mail e do WhatsApp enviados ao signatário.
        </p>
        <div className="grid sm:grid-cols-2 gap-3">
          {emitentes.map((e) => {
            const ativo = emitenteId === e.id;
            return (
              <button
                key={e.id}
                onClick={() => setEmitenteId(e.id)}
                className={`text-left border rounded-xl px-4 py-3 transition-all ${
                  ativo ? "border-sky-600 bg-sky-50 ring-1 ring-sky-600" : "bg-white hover:border-gray-300"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Building2 size={15} className={ativo ? "text-sky-700" : "text-gray-400"} />
                  <span className={`font-bold text-sm ${ativo ? "text-sky-800" : "text-gray-700"}`}>
                    {e.nomeFantasia || e.nome}
                  </span>
                </div>
                <p className="text-xs text-gray-500 mt-1 leading-snug">{e.nome}</p>
              </button>
            );
          })}
        </div>
      </section>

      {/* Passo 2 — arquivo */}
      <section className="bg-white rounded-xl border p-5 mb-4">
        <p className="text-[11px] font-bold uppercase tracking-wider text-gray-400 mb-1">Passo 2</p>
        <h2 className="font-semibold text-gray-800 mb-3">Documento (PDF)</h2>
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); selecionarArquivo(e.dataTransfer.files?.[0]); }}
          className={`border-2 border-dashed rounded-xl px-6 py-8 text-center cursor-pointer transition-colors ${
            arquivo ? "border-green-400 bg-green-50" : "border-gray-300 bg-gray-50 hover:border-gray-400"
          }`}
        >
          <Upload size={28} className={`mx-auto mb-2 ${arquivo ? "text-green-600" : "text-gray-400"}`} />
          {arquivo ? (
            <>
              <p className="text-sm font-semibold text-green-800">{arquivo.name}</p>
              <p className="text-xs text-green-700 mt-0.5">{(arquivo.size / 1024).toFixed(0)} KB — clique para trocar</p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-gray-600">Clique ou arraste o PDF aqui</p>
              <p className="text-xs text-gray-400 mt-0.5">Somente .pdf, até 20 MB</p>
            </>
          )}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => selecionarArquivo(e.target.files?.[0])}
        />
      </section>

      {/* Passo 3 — signatários */}
      {arquivo && (
        <section className="bg-white rounded-xl border p-5 mb-4">
          <div className="flex items-start justify-between mb-3 gap-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-gray-400 mb-1">Passo 3</p>
              <h2 className="font-semibold text-gray-800">Signatários</h2>
            </div>
            <div className="flex gap-2">
              <button
                onClick={analisarComIa}
                disabled={analisando}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border bg-white hover:bg-gray-50 text-gray-700 disabled:opacity-50"
              >
                <Sparkles size={13} /> {analisando ? "Analisando…" : "Preencher com IA"}
              </button>
              <button
                onClick={adicionarSignatario}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-sky-700 text-white hover:bg-sky-800"
              >
                <Plus size={13} /> Adicionar
              </button>
            </div>
          </div>

          {signatarios.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-6 border-2 border-dashed rounded-xl">
              Nenhum signatário. Use a IA ou adicione manualmente.
            </p>
          ) : (
            <div className="space-y-3">
              {signatarios.map((s, idx) => (
                <div key={s.uid} className={`border rounded-xl border-l-4 ${PAPEL_META[s.papel].cls} p-4`}>
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-bold text-gray-700">
                      {idx + 1}. {s.nome.trim() || "Novo signatário"}
                      <span className="ml-2 font-medium text-gray-400">{PAPEL_META[s.papel].label}</span>
                    </span>
                    <button
                      onClick={() => setSignatarios((l) => l.filter((x) => x.uid !== s.uid))}
                      className="p-1 rounded text-red-500 hover:bg-red-50"
                      title="Remover"
                    >
                      <X size={14} />
                    </button>
                  </div>
                  <div className="grid sm:grid-cols-2 gap-3">
                    <Campo label="Nome completo" obrigatorio value={s.nome} onChange={(v) => atualizar(s.uid, "nome", v)} placeholder="João da Silva" />
                    <Campo label="E-mail" obrigatorio type="email" value={s.email} onChange={(v) => atualizar(s.uid, "email", v)} placeholder="joao@exemplo.com.br" />
                    <Campo label="CPF" value={s.cpf} onChange={(v) => atualizar(s.uid, "cpf", v)} placeholder="000.000.000-00" />
                    <Campo label="WhatsApp" value={s.telefone} onChange={(v) => atualizar(s.uid, "telefone", v)} placeholder="(77) 99999-9999" />
                    <div className="sm:col-span-2">
                      <label className="block text-xs font-semibold text-gray-600 mb-1">Papel no documento</label>
                      <select
                        value={s.papel}
                        onChange={(e) => atualizar(s.uid, "papel", e.target.value)}
                        className="w-full border rounded-lg px-3 py-2 text-sm"
                      >
                        {(Object.keys(PAPEL_META) as Papel[]).map((p) => (
                          <option key={p} value={p}>{PAPEL_META[p].label} — {PAPEL_META[p].desc}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {signatarios.some((s) => s.nome.trim() && !s.telefone.trim()) ? (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-3">
              ⚠ Sem WhatsApp preenchido, {signatarios.filter((s) => s.nome.trim() && !s.telefone.trim()).length === 1
                ? "esse signatário receberá"
                : "esses signatários receberão"} apenas o e-mail automático do PAKT.
            </p>
          ) : (
            <p className="text-xs text-gray-400 mt-3">
              O link de assinatura vai por WhatsApp, em nome do escritório escolhido. O e-mail continua
              obrigatório porque é o identificador do signatário no PAKT.
            </p>
          )}
        </section>
      )}

      {/* Passo 4 — detalhes */}
      {arquivo && (
        <section className="bg-white rounded-xl border p-5 mb-4">
          <p className="text-[11px] font-bold uppercase tracking-wider text-gray-400 mb-1">Passo 4</p>
          <h2 className="font-semibold text-gray-800 mb-3">Detalhes do envio</h2>
          <div className="space-y-3">
            <Campo label="Nome do documento" value={nomeDoc} onChange={setNomeDoc} placeholder="Ex.: Contrato de Prestação de Serviços" />
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Mensagem para os signatários</label>
              <textarea
                value={mensagem}
                onChange={(e) => { setMensagemTocada(true); setMensagem(e.target.value); }}
                rows={3}
                className="w-full border rounded-lg px-3 py-2 text-sm resize-y"
                placeholder="Texto exibido no e-mail e na página de assinatura"
              />
              {escritorio && (
                <p className="text-xs text-gray-400 mt-1">
                  O convite será assinado como <strong className="text-gray-600">{escritorio}</strong>.
                </p>
              )}
            </div>
            <div className="border-t pt-3 space-y-2">
              <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
                <input type="checkbox" checked={enviarAgora} onChange={(e) => setEnviarAgora(e.target.checked)} />
                Enviar para assinatura imediatamente
              </label>
              {enviarAgora && (
                <div className="pl-6 space-y-1.5">
                  <label className="flex items-center gap-2 text-sm text-gray-600">
                    <input type="checkbox" checked={enviarWhatsapp} onChange={(e) => setEnviarWhatsapp(e.target.checked)} />
                    WhatsApp com o link, citando {escritorio || "o escritório"}
                  </label>
                  <label className="flex items-center gap-2 text-sm text-gray-600">
                    <input type="checkbox" checked={enviarEmail} onChange={(e) => setEnviarEmail(e.target.checked)} />
                    E-mail em nome de {escritorio || "o escritório"}
                    <span className="text-xs text-gray-400">(exige SMTP do escritório configurado)</span>
                  </label>
                  <p className="text-xs text-gray-400 pt-1">
                    O PAKT envia o e-mail de convite dele em qualquer caso — é por isso que o e-mail do
                    signatário continua obrigatório.
                  </p>
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {erro && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">{erro}</p>}

      <div className="flex justify-end gap-2 pb-8">
        <button onClick={onCancelar} className="px-4 py-2 rounded-lg border bg-white hover:bg-gray-50 text-sm text-gray-700">
          Cancelar
        </button>
        <button
          onClick={criar}
          disabled={enviando || !arquivo || !emitenteId}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold bg-sky-700 text-white hover:bg-sky-800 disabled:opacity-50"
        >
          <Send size={15} /> {enviando ? "Enviando…" : enviarAgora ? "Criar e enviar" : "Criar rascunho"}
        </button>
      </div>
    </div>
  );
}

function Campo({
  label, value, onChange, placeholder, type = "text", obrigatorio = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  obrigatorio?: boolean;
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-gray-600 mb-1">
        {label}{obrigatorio ? <span className="text-red-500"> *</span> : <span className="font-normal text-gray-400"> (opcional)</span>}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full border rounded-lg px-3 py-2 text-sm"
      />
    </div>
  );
}
