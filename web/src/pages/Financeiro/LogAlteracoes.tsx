import { useMemo, useState } from "react";
import { trpc } from "../../lib/trpc";
import { exportarExcel } from "../../lib/exportar";
import {
  BotoesExportar, Cabecalho, ErroBox, ExigeEmitente, Pill, TabelaWrap, Vazio, btnSec, fmtDataHora, td, th, useEmitenteFin, type RO,
} from "./fin-ui";

type Item = RO["fin"]["auditoria"]["listar"]["itens"][number];

const ROTULO_ENTIDADE: Record<string, string> = {
  Lancamento: "Lançamento", FinFonte: "Fonte", FinOrcamento: "Orçamento", FinIndiceMensal: "Índice Selic/CDI",
  FinEmprestimo: "Empréstimo", FinEmprestimoMov: "Movimento de empréstimo", FinAplicacao: "Aplicação",
  FinAplicacaoMov: "Movimento de aplicação", Acordo: "Acordo", AcordoRodada: "Rodada de acordo",
  AcordoAvaliacao: "Avaliação de acordo", FinRecebimento: "Recebimento",
};
const ROTULO_ACAO: Record<string, string> = { criar: "Criação", atualizar: "Alteração", excluir: "Exclusão" };
const COR_ACAO: Record<string, "green" | "blue" | "red"> = { criar: "green", atualizar: "blue", excluir: "red" };

/** Campos técnicos que não interessam no diff. */
const IGNORAR = new Set(["atualizadoEm", "criadoEm", "id"]);

function legivel(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "sim" : "não";
  if (typeof v === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})T/.exec(v);
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
    return v;
  }
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) {
    // rateio de fontes: [{fonteId, valor, fonte:{nome}}]
    return v.map((x) => {
      if (x && typeof x === "object") {
        const o = x as Record<string, unknown>;
        const nome = (o.fonte as { nome?: string } | undefined)?.nome ?? o.nome ?? o.fonteId ?? "";
        return o.valor !== undefined ? `${nome}: ${o.valor}` : String(nome || JSON.stringify(o));
      }
      return String(x);
    }).join("; ") || "—";
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("nome" in o) return String(o.nome);
    return JSON.stringify(v);
  }
  return String(v);
}

type Diff = { campo: string; antes: string; depois: string };

function calcularDiff(it: Item): Diff[] {
  const a = (it.antes ?? {}) as Record<string, unknown>;
  const d = (it.depois ?? {}) as Record<string, unknown>;
  const ehObj = (x: unknown) => x && typeof x === "object" && !Array.isArray(x);
  if (!ehObj(a) && !ehObj(d)) return [{ campo: "valor", antes: legivel(it.antes), depois: legivel(it.depois) }];
  const campos = [...new Set([...Object.keys(a), ...Object.keys(d)])].filter((k) => !IGNORAR.has(k));
  const out: Diff[] = [];
  for (const k of campos) {
    const va = legivel(a[k]);
    const vd = legivel(d[k]);
    if (it.acao === "atualizar" && va === vd) continue;
    if (it.acao === "criar" && vd === "—") continue;
    if (it.acao === "excluir" && va === "—") continue;
    out.push({ campo: k, antes: va, depois: vd });
  }
  return out;
}

function resumo(it: Item): string {
  const o = ((it.depois ?? it.antes) ?? {}) as Record<string, unknown>;
  if (typeof o !== "object" || Array.isArray(o)) return "";
  const partes = [o.descricao, o.nome, o.categoria, o.tipo].filter((x) => typeof x === "string" && x) as string[];
  if (typeof o.ano === "number" && typeof o.mes === "number") partes.push(`${String(o.mes).padStart(2, "0")}/${o.ano}`);
  if (o.valor !== undefined && o.valor !== null) partes.push(`R$ ${o.valor}`);
  if (o.taxa !== undefined) partes.push(`${o.taxa}%`);
  return partes.slice(0, 4).join(" · ");
}

function Lista({ emitenteId }: { emitenteId: string }) {
  const [entidade, setEntidade] = useState("");
  const [acao, setAcao] = useState<"" | "criar" | "atualizar" | "excluir">("");
  const [de, setDe] = useState("");
  const [ate, setAte] = useState("");
  const [incluirGlobais, setIncluirGlobais] = useState(true);
  const [pagina, setPagina] = useState(1);
  const [aberto, setAberto] = useState<string | null>(null);
  const porPagina = 50;
  const entidades = trpc.fin.auditoria.entidades.useQuery({ emitenteId });
  const filtros = {
    emitenteId,
    entidade: entidade || undefined,
    acao: acao || undefined,
    de: de || undefined,
    ate: ate || undefined,
    incluirGlobais,
    porPagina,
  };
  const q = trpc.fin.auditoria.listar.useQuery({ ...filtros, pagina }, { keepPreviousData: true });
  const utils = trpc.useUtils();

  const listaEntidades = useMemo(() => {
    const s = new Set([...(entidades.data ?? []), ...(incluirGlobais ? ["FinIndiceMensal"] : [])]);
    return [...s].sort();
  }, [entidades.data, incluirGlobais]);

  function mudar<T>(fn: (v: T) => void) {
    return (v: T) => { fn(v); setPagina(1); };
  }

  async function exportar() {
    // exporta todas as páginas do filtro atual (máx. 2.000 registros)
    const linhas: Array<Record<string, unknown>> = [];
    let p = 1;
    for (;;) {
      const r = await utils.fin.auditoria.listar.fetch({ ...filtros, porPagina: 200, pagina: p });
      for (const it of r.itens) {
        const diffs = calcularDiff(it);
        if (!diffs.length) diffs.push({ campo: "", antes: "", depois: "" });
        for (const df of diffs) {
          linhas.push({
            quando: fmtDataHora(it.criadoEm as unknown as string), usuario: it.usuario?.nome ?? it.usuarioId ?? "",
            entidade: ROTULO_ENTIDADE[it.entidade] ?? it.entidade, entidadeId: it.entidadeId, acao: ROTULO_ACAO[it.acao] ?? it.acao,
            campo: df.campo, antes: df.antes, depois: df.depois,
          });
        }
      }
      if (p >= r.totalPaginas || p >= 10) break;
      p++;
    }
    await exportarExcel({
      nomeArquivo: "log-alteracoes-financeiro",
      abas: [{
        nome: "Log de alterações",
        colunas: [
          { chave: "quando", titulo: "Data/hora", largura: 18 }, { chave: "usuario", titulo: "Usuário", largura: 22 },
          { chave: "entidade", titulo: "Registro", largura: 22 }, { chave: "entidadeId", titulo: "ID", largura: 28 },
          { chave: "acao", titulo: "Ação" }, { chave: "campo", titulo: "Campo", largura: 20 },
          { chave: "antes", titulo: "Antes", largura: 40 }, { chave: "depois", titulo: "Depois", largura: 40 },
        ],
        linhas,
      }],
    });
  }

  const d = q.data;
  return (
    <div className="space-y-4">
      <div className="flex items-end gap-2 flex-wrap no-print">
        <label className="text-xs text-gray-600">Registro<br />
          <select value={entidade} onChange={(e) => mudar(setEntidade)(e.target.value)} className="border rounded-lg px-2 py-1.5 text-sm bg-white">
            <option value="">Todos</option>
            {listaEntidades.map((e) => <option key={e} value={e}>{ROTULO_ENTIDADE[e] ?? e}</option>)}
          </select>
        </label>
        <label className="text-xs text-gray-600">Ação<br />
          <select value={acao} onChange={(e) => mudar(setAcao)(e.target.value as "" | "criar" | "atualizar" | "excluir")} className="border rounded-lg px-2 py-1.5 text-sm bg-white">
            <option value="">Todas</option><option value="criar">Criação</option><option value="atualizar">Alteração</option><option value="excluir">Exclusão</option>
          </select>
        </label>
        <label className="text-xs text-gray-600">De<br /><input type="date" value={de} onChange={(e) => mudar(setDe)(e.target.value)} className="border rounded-lg px-2 py-1.5 text-sm bg-white" /></label>
        <label className="text-xs text-gray-600">Até<br /><input type="date" value={ate} onChange={(e) => mudar(setAte)(e.target.value)} className="border rounded-lg px-2 py-1.5 text-sm bg-white" /></label>
        <label className="flex items-center gap-1.5 text-sm text-gray-600 pb-1.5">
          <input type="checkbox" checked={incluirGlobais} onChange={(e) => mudar(setIncluirGlobais)(e.target.checked)} /> incluir índices Selic/CDI
        </label>
        <span className="ml-auto"><BotoesExportar onExcel={exportar} tituloPdf="Log de alterações do financeiro" desabilitado={!d?.total} /></span>
      </div>

      {q.error ? <ErroBox erro={q.error} /> : !d ? <div className="bg-white border rounded-xl p-8 text-center text-sm text-gray-400 animate-pulse">Carregando…</div> : !d.itens.length ? (
        <Vazio texto="Nenhuma alteração registrada com esses filtros." />
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl">
          <TabelaWrap>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b"><tr>
                <th className={`${th} text-left`}>Data/hora</th><th className={`${th} text-left`}>Usuário</th><th className={`${th} text-left`}>Registro</th>
                <th className={`${th} text-left`}>Ação</th><th className={`${th} text-left`}>Resumo / alterações</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-100">
                {d.itens.map((it) => {
                  const diffs = calcularDiff(it);
                  const abrir = aberto === it.id;
                  return (
                    <tr key={it.id} className="align-top">
                      <td className={`${td} text-gray-600`}>{fmtDataHora(it.criadoEm as unknown as string)}</td>
                      <td className={td}>{it.usuario?.nome ?? <span className="text-gray-400">{it.usuarioId ? it.usuarioId.slice(0, 8) : "sistema"}</span>}</td>
                      <td className={td}>{ROTULO_ENTIDADE[it.entidade] ?? it.entidade}<div className="text-[10px] text-gray-400 font-mono">{it.entidadeId.slice(0, 12)}</div></td>
                      <td className={td}><Pill cor={COR_ACAO[it.acao] ?? "gray"}>{ROTULO_ACAO[it.acao] ?? it.acao}</Pill></td>
                      <td className="px-3 py-2 min-w-[320px]">
                        <div className="text-xs text-gray-700">{resumo(it) || "—"}</div>
                        {it.acao === "atualizar" && !abrir && diffs.length > 0 && (
                          <div className="text-xs text-gray-500 mt-0.5">
                            {diffs.slice(0, 3).map((df) => <span key={df.campo} className="mr-3"><b>{df.campo}</b>: <s className="text-red-500">{df.antes}</s> → <span className="text-green-700">{df.depois}</span></span>)}
                            {diffs.length > 3 && <span>+{diffs.length - 3}</span>}
                          </div>
                        )}
                        <button className="text-[11px] text-indigo-600 hover:underline no-print" onClick={() => setAberto(abrir ? null : it.id)}>
                          {abrir ? "ocultar detalhes" : "ver antes/depois"}
                        </button>
                        {abrir && (
                          <table className="mt-2 text-xs w-full border">
                            <thead className="bg-gray-50"><tr><th className="px-2 py-1 text-left">Campo</th><th className="px-2 py-1 text-left">Antes</th><th className="px-2 py-1 text-left">Depois</th></tr></thead>
                            <tbody className="divide-y">
                              {!diffs.length && <tr><td colSpan={3} className="px-2 py-1 text-gray-400">sem diferenças nos campos</td></tr>}
                              {diffs.map((df) => (
                                <tr key={df.campo}>
                                  <td className="px-2 py-1 font-medium whitespace-nowrap">{df.campo}</td>
                                  <td className="px-2 py-1 text-red-700 break-all">{df.antes}</td>
                                  <td className="px-2 py-1 text-green-700 break-all">{df.depois}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TabelaWrap>
          <div className="flex items-center justify-between px-4 py-3 border-t text-sm no-print">
            <span className="text-gray-500">{d.total} registro(s) · página {d.pagina} de {d.totalPaginas}</span>
            <span className="flex gap-2">
              <button className={btnSec} disabled={pagina <= 1} onClick={() => setPagina(pagina - 1)}>← Anterior</button>
              <button className={btnSec} disabled={pagina >= d.totalPaginas} onClick={() => setPagina(pagina + 1)}>Próxima →</button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function LogAlteracoes() {
  const emit = useEmitenteFin();
  return (
    <div className="p-4 md:p-6 space-y-6">
      <Cabecalho titulo="Log de alterações" subtitulo="Toda criação, alteração e exclusão no financeiro gerencial, com o antes e o depois." emitente={emit} />
      <ExigeEmitente ctl={emit}><Lista emitenteId={emit.emitenteId} /></ExigeEmitente>
    </div>
  );
}
