/**
 * Peças comuns das telas do Financeiro gerencial (Fase 3A): tipos inferidos do tRPC, formatação
 * BRL/datas sem fuso, seletor de empresa emissora (emitente), permissões, estados de tela,
 * botões de exportação, modal e abas.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../server/src/routers/index";
import { trpc } from "../../lib/trpc";
import { useAuth, hasModulo } from "../../lib/usePermission";
import { imprimirPdf } from "../../lib/exportar";

export type RO = inferRouterOutputs<AppRouter>;
export type RI = inferRouterInputs<AppRouter>;

// ── Formatação ──────────────────────────────────────────────────────────────

export const MESES_CURTOS = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
export const MESES_LONGOS = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];

/** number | string (Decimal do Prisma) | null → number (null/inválido → 0). */
export function num(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "number" ? v : Number(String(v));
  return Number.isFinite(n) ? n : 0;
}

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
export function fmtBrl(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  return BRL.format(num(v));
}

export function fmtNum(v: unknown, casas = 2): string {
  if (v === null || v === undefined || v === "") return "—";
  return num(v).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
}

/** Percentual que JÁ vem em % (45,2 → "45,20%"). */
export function fmtPct(v: unknown, casas = 2): string {
  if (v === null || v === undefined || v === "") return "—";
  return `${fmtNum(v, casas)}%`;
}

/** "YYYY-MM-DD" ou ISO → "dd/mm/aaaa", lendo só a parte da data (não desloca o dia por fuso). */
export function fmtData(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const s = typeof v === "string" ? v : v.toISOString();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

/** "YYYY-MM-DD..." → "YYYY-MM-DD" (para <input type="date">). */
export function dataInput(v: string | Date | null | undefined): string {
  if (!v) return "";
  const s = typeof v === "string" ? v : v.toISOString();
  return s.slice(0, 10);
}

/** "YYYY-MM-DD..." → "YYYY-MM" (para <input type="month">). */
export function mesInput(v: string | Date | null | undefined): string {
  return dataInput(v).slice(0, 7);
}

/** Timestamp (criadoEm) → "dd/mm/aaaa hh:mm" no fuso da Bahia. */
export function fmtDataHora(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const d = typeof v === "string" ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString("pt-BR", { timeZone: "America/Bahia", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function fmtMes(ano: number, mes: number, longo = false): string {
  return longo ? `${MESES_LONGOS[mes - 1]} ${ano}` : `${MESES_CURTOS[mes - 1]}/${String(ano).slice(2)}`;
}

/** "YYYY-MM" → "Nov/26". */
export function fmtMesStr(s: string | null | undefined): string {
  if (!s) return "—";
  const [a, m] = s.split("-").map(Number);
  return a && m ? fmtMes(a, m) : s;
}

function partesHoje(): { ano: number; mes: number; dia: number } {
  // data-calendário de hoje na Bahia (UTC−3), independente do fuso do navegador
  const s = new Date().toLocaleDateString("en-CA", { timeZone: "America/Bahia" }); // YYYY-MM-DD
  const [ano, mes, dia] = s.split("-").map(Number);
  return { ano, mes, dia };
}
export function hojeStr(): string {
  const { ano, mes, dia } = partesHoje();
  return `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}
export function mesAtualStr(): string {
  return hojeStr().slice(0, 7);
}
export function anoAtual(): number {
  return partesHoje().ano;
}
export function addMesStr(s: string, n: number): string {
  const [a, m] = s.split("-").map(Number);
  const idx = a * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

/** Aceita "1.234,56", "1234,56", "1234.56" → número; vazio/ inválido → null. */
export function parseValor(s: string | number | null | undefined): number | null {
  if (s === null || s === undefined) return null;
  if (typeof s === "number") return Number.isFinite(s) ? s : null;
  let t = s.trim().replace(/[R$\s]/g, "");
  if (!t) return null;
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Valor do Decimal (string) para o campo de texto do formulário ("1234,56"). */
export function valorInput(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  return num(v).toFixed(2).replace(".", ",");
}

export function centavos(v: number): number {
  return Math.round(v * 100);
}

/** Mensagem legível de erro do tRPC (inclui erros de validação zod, que chegam como JSON). */
export function msgErro(e: unknown): string {
  if (!e) return "";
  const m = (e as { message?: string }).message ?? String(e);
  try {
    const j = JSON.parse(m);
    if (Array.isArray(j)) {
      return j.map((i: { message?: string; path?: unknown[] }) => `${(i.path ?? []).join(".")}${i.path?.length ? ": " : ""}${i.message ?? ""}`).join("; ");
    }
  } catch { /* não é JSON */ }
  return m;
}

// ── Permissões ──────────────────────────────────────────────────────────────

/** Mesma regra do server (lib/fin/perm.ts): admin, permissões null ou sem lista = acesso total. */
export function useFinPermissoes(): { podeEditar: boolean; podeLancar: boolean } {
  const { user } = useAuth();
  if (!user) return { podeEditar: false, podeLancar: false };
  const admin = user.role === "admin";
  const podeEditar = admin || hasModulo(user, "financeiro_editar");
  // lançamentos (financeiro.criar/atualizar/deletar) aceitam também o módulo legado "financeiro"
  const podeLancar = podeEditar || hasModulo(user, "financeiro");
  return { podeEditar, podeLancar };
}

// ── Empresa emissora ────────────────────────────────────────────────────────

const CHAVE_EMITENTE = "avoce_emitenteId"; // mesma chave das telas de contas/extrato/fluxo

function lerEmitente(): string {
  try { return localStorage.getItem(CHAVE_EMITENTE) ?? ""; } catch { return ""; }
}

/** Emitente selecionado (persistido entre telas). Seleciona o primeiro se o salvo não for acessível. */
export function useEmitenteFin() {
  const empresas = trpc.empresa.listar.useQuery();
  const [emitenteId, setEmitenteIdState] = useState<string>(lerEmitente);
  const lista = empresas.data ?? [];

  useEffect(() => {
    if (!empresas.data) return;
    if (!empresas.data.length) return;
    if (!emitenteId || !empresas.data.some((e) => e.id === emitenteId)) {
      setEmitenteIdState(empresas.data[0].id);
    }
  }, [empresas.data, emitenteId]);

  function setEmitenteId(id: string) {
    setEmitenteIdState(id);
    try { localStorage.setItem(CHAVE_EMITENTE, id); } catch { /* ignore */ }
  }

  const valido = !!emitenteId && lista.some((e) => e.id === emitenteId);
  const emitente = lista.find((e) => e.id === emitenteId) ?? null;
  return {
    emitenteId: valido ? emitenteId : "",
    setEmitenteId,
    empresas: lista,
    emitente,
    carregando: empresas.isLoading,
    erro: empresas.error,
  };
}

export function nomeEmpresa(e: { nome: string; nomeFantasia?: string | null } | null | undefined): string {
  if (!e) return "";
  return e.nomeFantasia || e.nome;
}

export function SeletorEmitente({ ctl }: { ctl: ReturnType<typeof useEmitenteFin> }) {
  if (ctl.empresas.length <= 1) {
    return ctl.emitente ? <span className="text-sm text-gray-600">{nomeEmpresa(ctl.emitente)}</span> : null;
  }
  return (
    <select
      value={ctl.emitenteId}
      onChange={(e) => ctl.setEmitenteId(e.target.value)}
      className="border rounded-lg px-3 py-2 text-sm bg-white max-w-[260px]"
      title="Empresa emissora"
    >
      {ctl.empresas.map((e) => <option key={e.id} value={e.id}>{nomeEmpresa(e)}</option>)}
    </select>
  );
}

// ── Layout de tela ──────────────────────────────────────────────────────────

export function Cabecalho({ titulo, subtitulo, children, emitente }: {
  titulo: string; subtitulo?: string; children?: ReactNode; emitente?: ReturnType<typeof useEmitenteFin>;
}) {
  return (
    <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold text-gray-900">{titulo}</h1>
        {subtitulo && <p className="text-sm text-gray-500 mt-1">{subtitulo}</p>}
        {emitente?.emitente && <p className="print-only text-sm text-gray-700">{nomeEmpresa(emitente.emitente)}</p>}
      </div>
      <div className="flex items-center gap-2 flex-wrap no-print">
        {emitente && <SeletorEmitente ctl={emitente} />}
        {children}
      </div>
    </div>
  );
}

/** Sem emitente → mensagem; senão renderiza filhos. */
export function ExigeEmitente({ ctl, children }: { ctl: ReturnType<typeof useEmitenteFin>; children: ReactNode }) {
  if (ctl.carregando) return <Carregando />;
  if (ctl.erro) return <ErroBox erro={ctl.erro} />;
  if (!ctl.empresas.length) return <Vazio texto="Nenhuma empresa emissora acessível para o seu usuário." />;
  if (!ctl.emitenteId) return <Carregando />;
  return <>{children}</>;
}

export function Carregando({ texto = "Carregando…" }: { texto?: string }) {
  return <div className="bg-white border border-gray-200 rounded-xl p-8 text-center text-sm text-gray-400 animate-pulse">{texto}</div>;
}

export function Vazio({ texto }: { texto: string }) {
  return <div className="bg-white border border-gray-200 rounded-xl p-8 text-center text-sm text-gray-400">{texto}</div>;
}

export function ErroBox({ erro, titulo = "Erro" }: { erro: unknown; titulo?: string }) {
  if (!erro) return null;
  return (
    <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
      <span className="font-semibold">{titulo}: </span>{msgErro(erro)}
    </div>
  );
}

export function Avisos({ avisos }: { avisos?: string[] | null }) {
  if (!avisos?.length) return null;
  return (
    <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-xl px-4 py-3 text-sm space-y-1">
      {avisos.map((a, i) => <p key={i}>⚠ {a}</p>)}
    </div>
  );
}

/** Estado padrão de uma query: carregando / erro / vazio / conteúdo. */
export function EstadoQuery<T>({ q, vazio, textoVazio = "Nada para mostrar.", children }: {
  q: { data: T | undefined; isLoading: boolean; error: unknown; fetchStatus?: string };
  vazio?: (d: T) => boolean;
  textoVazio?: string;
  children: (d: T) => ReactNode;
}) {
  if (q.error) return <ErroBox erro={q.error} />;
  if (q.data === undefined) return <Carregando />;
  if (vazio && vazio(q.data)) return <Vazio texto={textoVazio} />;
  return <>{children(q.data)}</>;
}

export function Card({ titulo, children, acoes, className = "" }: { titulo?: ReactNode; children: ReactNode; acoes?: ReactNode; className?: string }) {
  return (
    <div className={`bg-white border border-gray-200 rounded-xl ${className}`}>
      {(titulo || acoes) && (
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-gray-100 flex-wrap">
          <h2 className="text-sm font-semibold text-gray-700">{titulo}</h2>
          {acoes && <div className="flex items-center gap-2 flex-wrap no-print">{acoes}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

export function Kpi({ rotulo, valor, detalhe, cor = "gray" }: {
  rotulo: string; valor: ReactNode; detalhe?: ReactNode; cor?: "gray" | "green" | "red" | "indigo" | "amber" | "blue";
}) {
  const cores: Record<string, string> = {
    gray: "bg-white border-gray-200 text-gray-900",
    green: "bg-green-50 border-green-200 text-green-900",
    red: "bg-red-50 border-red-200 text-red-900",
    indigo: "bg-indigo-50 border-indigo-200 text-indigo-900",
    amber: "bg-amber-50 border-amber-200 text-amber-900",
    blue: "bg-blue-50 border-blue-200 text-blue-900",
  };
  return (
    <div className={`border rounded-xl p-4 ${cores[cor]}`}>
      <p className="text-xs font-medium uppercase tracking-wide opacity-70">{rotulo}</p>
      <p className="text-xl md:text-2xl font-bold mt-1 break-words">{valor}</p>
      {detalhe && <div className="text-xs mt-1 opacity-80">{detalhe}</div>}
    </div>
  );
}

/** Container de tabela com rolagem horizontal. */
export function TabelaWrap({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto">{children}</div>;
}

export const th = "px-3 py-2 text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap";
export const td = "px-3 py-2 whitespace-nowrap";
export const inputCls = "w-full border rounded-lg px-3 py-2 text-sm bg-white disabled:bg-gray-100";
export const btnPri = "px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50";
export const btnSec = "px-3 py-2 border border-gray-300 bg-white text-gray-700 text-sm rounded-lg hover:bg-gray-50 disabled:opacity-50";
export const btnLink = "text-xs text-indigo-600 hover:underline disabled:opacity-40";
export const btnLinkRed = "text-xs text-red-500 hover:underline disabled:opacity-40";

export function BotoesExportar({ onExcel, tituloPdf, desabilitado }: { onExcel: () => Promise<void> | void; tituloPdf: string; desabilitado?: boolean }) {
  const [gerando, setGerando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  async function excel() {
    setGerando(true);
    setErro(null);
    try { await onExcel(); } catch (e) { setErro(msgErro(e)); } finally { setGerando(false); }
  }
  return (
    <span className="inline-flex items-center gap-2 no-print">
      <button type="button" onClick={excel} disabled={desabilitado || gerando} className={btnSec} title="Exportar para Excel (.xlsx)">
        {gerando ? "Gerando…" : "Excel"}
      </button>
      <button type="button" onClick={() => imprimirPdf(tituloPdf)} disabled={desabilitado} className={btnSec} title="Imprimir / salvar como PDF">
        PDF
      </button>
      {erro && <span className="text-xs text-red-600">{erro}</span>}
    </span>
  );
}

export function Modal({ titulo, onClose, children, largura = "max-w-lg" }: { titulo: string; onClose: () => void; children: ReactNode; largura?: string }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 bg-black/40 flex items-start md:items-center justify-center z-50 p-2 md:p-4 overflow-y-auto no-print">
      <div className={`bg-white rounded-xl shadow-xl w-full ${largura} p-4 md:p-6 space-y-4 my-4`}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">{titulo}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none px-1" aria-label="Fechar">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Campo({ rotulo, children, className = "", dica }: { rotulo: string; children: ReactNode; className?: string; dica?: ReactNode }) {
  return (
    <div className={className}>
      <label className="block text-xs font-medium text-gray-600 mb-1">{rotulo}</label>
      {children}
      {dica && <p className="text-[11px] text-gray-400 mt-0.5">{dica}</p>}
    </div>
  );
}

/** Abas de navegação entre telas irmãs (ex.: Empréstimo PSA | Empréstimo bancário). */
export function Abas({ itens }: { itens: Array<{ to: string; label: string }> }) {
  return (
    <div className="flex gap-1 border-b border-gray-200 overflow-x-auto no-print">
      {itens.map((i) => (
        <NavLink
          key={i.to}
          to={i.to}
          end
          className={({ isActive }) =>
            `px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px ${isActive ? "border-indigo-600 text-indigo-700 font-medium" : "border-transparent text-gray-500 hover:text-gray-800"}`}
        >
          {i.label}
        </NavLink>
      ))}
    </div>
  );
}

export const ABAS_EMPRESTIMOS = [
  { to: "/financeiro/emprestimos/psa", label: "Empréstimo PSA" },
  { to: "/financeiro/emprestimos/bancario", label: "Empréstimo bancário" },
];

export const ABAS_RELATORIOS = [
  { to: "/financeiro/relatorios/fluxo", label: "Fluxo de caixa projetado" },
  { to: "/financeiro/relatorios/dre", label: "DRE gerencial" },
  { to: "/financeiro/relatorios/consumo", label: "Consumo por fonte" },
];

/** Seletor de ano simples (ano atual −3 … +2). */
export function SeletorAno({ ano, onChange }: { ano: number; onChange: (a: number) => void }) {
  const anos = useMemo(() => {
    const a = anoAtual();
    const out: number[] = [];
    for (let i = a - 3; i <= a + 2; i++) out.push(i);
    if (!out.includes(ano)) out.push(ano);
    return out.sort();
  }, [ano]);
  return (
    <select value={ano} onChange={(e) => onChange(Number(e.target.value))} className="border rounded-lg px-3 py-2 text-sm bg-white">
      {anos.map((a) => <option key={a} value={a}>{a}</option>)}
    </select>
  );
}

export const ROTULO_FORMA_PAGAMENTO: Record<string, string> = {
  pix: "PIX", boleto: "Boleto", cartao: "Cartão", transferencia: "Transferência",
  dinheiro: "Dinheiro", debito_automatico: "Débito automático", outro: "Outro",
};

export const ROTULO_TIPO_FONTE: Record<string, string> = {
  emprestimo_psa: "Empréstimo PSA", emprestimo_bancario: "Empréstimo bancário",
  receita_propria: "Receita própria", outra: "Outra",
};

export function Pill({ children, cor = "gray", title }: { children: ReactNode; cor?: "gray" | "green" | "amber" | "red" | "indigo" | "blue"; title?: string }) {
  const c: Record<string, string> = {
    gray: "bg-gray-100 text-gray-600", green: "bg-green-100 text-green-700", amber: "bg-amber-100 text-amber-700",
    red: "bg-red-100 text-red-700", indigo: "bg-indigo-100 text-indigo-700", blue: "bg-blue-100 text-blue-700",
  };
  return <span title={title} className={`inline-block text-[11px] px-2 py-0.5 rounded-full whitespace-nowrap ${c[cor]}`}>{children}</span>;
}
