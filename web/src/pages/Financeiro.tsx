import { useState } from "react";
import { trpc } from "../lib/trpc";

const MESES = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];

function fmtBrl(v: number) {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function fmtDate(d: string | Date) {
  return new Date(d).toLocaleDateString("pt-BR");
}

type LancamentoInput = {
  tipo: "receita" | "despesa";
  descricao: string;
  categoria?: string;
  valor: number;
  data: string;
  emitenteId?: string;
  pago: boolean;
  obs?: string;
};

function ModalLancamento({
  initial,
  onClose,
  onSaved,
}: {
  initial?: { id: string } & LancamentoInput;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { data: empresas } = trpc.empresa.listar.useQuery();
  const { data: cats } = trpc.financeiro.categorias.useQuery();
  const [tipo, setTipo] = useState<"receita" | "despesa">(initial?.tipo ?? "receita");
  const [descricao, setDescricao] = useState(initial?.descricao ?? "");
  const [categoria, setCategoria] = useState(initial?.categoria ?? "");
  const [valor, setValor] = useState(initial?.valor?.toString() ?? "");
  const [data, setData] = useState(initial?.data ? initial.data.slice(0, 10) : new Date().toISOString().slice(0, 10));
  const [emitenteId, setEmitenteId] = useState(initial?.emitenteId ?? "");
  const [pago, setPago] = useState(initial?.pago ?? true);
  const [obs, setObs] = useState(initial?.obs ?? "");

  const criar = trpc.financeiro.criar.useMutation({ onSuccess: () => { onSaved(); onClose(); } });
  const atualizar = trpc.financeiro.atualizar.useMutation({ onSuccess: () => { onSaved(); onClose(); } });

  const categorias = tipo === "receita" ? (cats?.receita ?? []) : (cats?.despesa ?? []);

  function save() {
    const payload = {
      tipo,
      descricao,
      categoria: categoria || undefined,
      valor: parseFloat(valor),
      data,
      emitenteId: emitenteId || undefined,
      pago,
      obs: obs || undefined,
    };
    if (initial?.id) atualizar.mutate({ id: initial.id, ...payload });
    else criar.mutate(payload);
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4">
        <h2 className="text-lg font-semibold text-gray-900">{initial ? "Editar lançamento" : "Novo lançamento"}</h2>

        <div className="flex rounded-lg border overflow-hidden">
          {(["receita", "despesa"] as const).map(t => (
            <button
              key={t}
              onClick={() => { setTipo(t); setCategoria(""); }}
              className={`flex-1 py-2 text-sm font-medium transition-colors ${tipo === t ? (t === "receita" ? "bg-green-600 text-white" : "bg-red-600 text-white") : "text-gray-600 hover:bg-gray-50"}`}
            >
              {t === "receita" ? "Receita" : "Despesa"}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="block text-xs font-medium text-gray-600 mb-1">Descrição</label>
            <input value={descricao} onChange={e => setDescricao(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Categoria</label>
            <select value={categoria} onChange={e => setCategoria(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm">
              <option value="">—</option>
              {categorias.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Valor (R$)</label>
            <input type="number" step="0.01" min="0" value={valor} onChange={e => setValor(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Data</label>
            <input type="date" value={data} onChange={e => setData(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Empresa</label>
            <select value={emitenteId} onChange={e => setEmitenteId(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm">
              <option value="">—</option>
              {empresas?.map(e => <option key={e.id} value={e.id}>{e.nome}</option>)}
            </select>
          </div>
          <div className="col-span-2">
            <label className="block text-xs font-medium text-gray-600 mb-1">Observação</label>
            <input value={obs} onChange={e => setObs(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" />
          </div>
          <div className="col-span-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={pago} onChange={e => setPago(e.target.checked)} className="rounded" />
              <span className="text-sm text-gray-700">Já pago / recebido</span>
            </label>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Cancelar</button>
          <button
            onClick={save}
            disabled={!descricao || !valor || criar.isPending || atualizar.isPending}
            className="px-4 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 disabled:opacity-50"
          >
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Financeiro() {
  const now = new Date();
  const [mes, setMes] = useState(now.getMonth() + 1);
  const [ano, setAno] = useState(now.getFullYear());
  const [tipoFiltro, setTipoFiltro] = useState<"receita" | "despesa" | "">("");
  const [modal, setModal] = useState<{ lancamento?: any } | null>(null);

  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.financeiro.listar.useQuery({
    mes,
    ano,
    tipo: tipoFiltro || undefined,
  });
  const { data: resumoAnual } = trpc.financeiro.resumoAnual.useQuery({ ano });

  const deletar = trpc.financeiro.deletar.useMutation({
    onSuccess: () => utils.financeiro.listar.invalidate(),
  });

  function invalidate() {
    utils.financeiro.listar.invalidate();
    utils.financeiro.resumoAnual.invalidate();
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Financeiro</h1>
          <p className="text-sm text-gray-500 mt-1">Controle de receitas e despesas do escritório.</p>
        </div>
        <button
          onClick={() => setModal({})}
          className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700"
        >
          + Lançamento
        </button>
      </div>

      {/* KPIs */}
      {data && (
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-green-50 border border-green-200 rounded-xl p-4">
            <p className="text-xs font-medium text-green-700 uppercase tracking-wide">Receitas</p>
            <p className="text-2xl font-bold text-green-800 mt-1">{fmtBrl(data.totalReceita)}</p>
          </div>
          <div className="bg-red-50 border border-red-200 rounded-xl p-4">
            <p className="text-xs font-medium text-red-700 uppercase tracking-wide">Despesas</p>
            <p className="text-2xl font-bold text-red-800 mt-1">{fmtBrl(data.totalDespesa)}</p>
          </div>
          <div className={`border rounded-xl p-4 ${data.saldo >= 0 ? "bg-indigo-50 border-indigo-200" : "bg-amber-50 border-amber-200"}`}>
            <p className={`text-xs font-medium uppercase tracking-wide ${data.saldo >= 0 ? "text-indigo-700" : "text-amber-700"}`}>Saldo</p>
            <p className={`text-2xl font-bold mt-1 ${data.saldo >= 0 ? "text-indigo-800" : "text-amber-800"}`}>{fmtBrl(data.saldo)}</p>
          </div>
        </div>
      )}

      {/* Gráfico anual simples */}
      {resumoAnual && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Evolução anual {ano}</h2>
          <div className="flex items-end gap-1 h-24">
            {resumoAnual.map((m) => {
              const maxVal = Math.max(...resumoAnual.map((r: {receita:number}) => r.receita), 1);
              const recH = Math.round((m.receita / maxVal) * 80);
              const despH = Math.round((m.despesa / maxVal) * 80);
              return (
                <div key={m.mes} className="flex-1 flex flex-col items-center gap-0.5">
                  <div className="flex items-end gap-0.5 h-20">
                    <div className="w-2 bg-green-400 rounded-t" style={{ height: recH || 2 }} title={`Receita: ${fmtBrl(m.receita)}`} />
                    <div className="w-2 bg-red-400 rounded-t" style={{ height: despH || 2 }} title={`Despesa: ${fmtBrl(m.despesa)}`} />
                  </div>
                  <span className="text-[9px] text-gray-400">{MESES[m.mes - 1]}</span>
                </div>
              );
            })}
          </div>
          <div className="flex gap-4 mt-2">
            <span className="flex items-center gap-1 text-xs text-gray-500"><span className="h-2 w-2 bg-green-400 rounded" />Receita</span>
            <span className="flex items-center gap-1 text-xs text-gray-500"><span className="h-2 w-2 bg-red-400 rounded" />Despesa</span>
          </div>
        </div>
      )}

      {/* Filtros */}
      <div className="flex items-center gap-3 flex-wrap">
        <select value={mes} onChange={e => setMes(Number(e.target.value))} className="border rounded-lg px-3 py-2 text-sm">
          {MESES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
        </select>
        <select value={ano} onChange={e => setAno(Number(e.target.value))} className="border rounded-lg px-3 py-2 text-sm">
          {[2024, 2025, 2026, 2027].map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <select value={tipoFiltro} onChange={e => setTipoFiltro(e.target.value as any)} className="border rounded-lg px-3 py-2 text-sm">
          <option value="">Todos</option>
          <option value="receita">Receitas</option>
          <option value="despesa">Despesas</option>
        </select>
      </div>

      {/* Tabela */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {isLoading ? (
          <p className="p-6 text-sm text-gray-400">Carregando...</p>
        ) : !data?.lancamentos.length ? (
          <p className="p-6 text-sm text-gray-400 text-center">Nenhum lançamento neste período.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Data</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Descrição</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Categoria</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Valor</th>
                <th className="text-center px-4 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.lancamentos.map(l => (
                <tr key={l.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{fmtDate(l.data)}</td>
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {l.descricao}
                    {l.emitente && <span className="text-xs text-gray-400 ml-1">({l.emitente.nome})</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-500">{l.categoria ?? "—"}</td>
                  <td className={`px-4 py-3 text-right font-semibold ${l.tipo === "receita" ? "text-green-700" : "text-red-700"}`}>
                    {l.tipo === "despesa" ? "−" : "+"}{fmtBrl(Number(l.valor))}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${l.pago ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>
                      {l.pago ? "Pago" : "Pendente"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => setModal({ lancamento: l })} className="text-xs text-indigo-600 hover:underline mr-2">Editar</button>
                    <button onClick={() => { if (confirm("Excluir?")) deletar.mutate({ id: l.id }); }} className="text-xs text-red-500 hover:underline">Excluir</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {modal !== null && (
        <ModalLancamento
          initial={modal.lancamento}
          onClose={() => setModal(null)}
          onSaved={invalidate}
        />
      )}
    </div>
  );
}
