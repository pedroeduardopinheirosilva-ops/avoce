import { useMemo, useState } from "react";
import { trpc } from "../../lib/trpc";
import { exportarExcel } from "../../lib/exportar";
import {
  BotoesExportar, Cabecalho, Campo, Card, ErroBox, Modal, Pill, TabelaWrap, Vazio, anoAtual, btnLink, btnLinkRed, btnPri, btnSec,
  fmtMes, fmtNum, inputCls, mesAtualStr, msgErro, num, parseValor, td, th, useFinPermissoes, type RO,
} from "./fin-ui";

type Linha = RO["fin"]["indices"]["listar"][number];
type Indice = "selic" | "cdi";
type Importacao = RO["fin"]["indices"]["importar"];

function ModalIndice({ inicial, onClose }: { inicial?: { indice: Indice; ano: number; mes: number; taxa?: string }; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [indice, setIndice] = useState<Indice>(inicial?.indice ?? "selic");
  const [mes, setMes] = useState(inicial ? `${inicial.ano}-${String(inicial.mes).padStart(2, "0")}` : mesAtualStr());
  const [taxa, setTaxa] = useState(inicial?.taxa ?? "");
  const [erro, setErro] = useState<string | null>(null);
  const salvar = trpc.fin.indices.salvar.useMutation({
    onSuccess: () => { utils.fin.indices.listar.invalidate(); utils.fin.invalidate(); onClose(); },
    onError: (e) => setErro(msgErro(e)),
  });
  function ok() {
    setErro(null);
    const t = parseValor(taxa);
    if (t === null) { setErro("Informe a taxa (% a.m.)"); return; }
    const [a, m] = mes.split("-").map(Number);
    if (!a || !m) { setErro("Informe o mês"); return; }
    salvar.mutate({ indice, ano: a, mes: m, taxa: t });
  }
  return (
    <Modal titulo={inicial?.taxa !== undefined ? "Editar taxa (manual)" : "Incluir taxa manual"} onClose={onClose}>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Campo rotulo="Índice">
          <select value={indice} onChange={(e) => setIndice(e.target.value as Indice)} className={inputCls} disabled={!!inicial}>
            <option value="selic">Selic</option><option value="cdi">CDI</option>
          </select>
        </Campo>
        <Campo rotulo="Mês"><input type="month" value={mes} onChange={(e) => setMes(e.target.value)} className={inputCls} disabled={!!inicial} /></Campo>
        <Campo rotulo="Taxa (% a.m.)" dica="Ex.: 1,0700"><input value={taxa} onChange={(e) => setTaxa(e.target.value)} inputMode="decimal" className={inputCls} autoFocus /></Campo>
      </div>
      <p className="text-xs text-gray-500">A taxa fica marcada como <b>manual</b> e a importação do BCB não a sobrescreve até você clicar em “liberar para BCB”.</p>
      {erro && <ErroBox erro={erro} />}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={btnSec}>Cancelar</button>
        <button onClick={ok} disabled={salvar.isLoading} className={btnPri}>Salvar</button>
      </div>
    </Modal>
  );
}

function CelulaIndice({ l, indice, ano, mes, podeEditar, onEditar }: { l?: Linha; indice: Indice; ano: number; mes: number; podeEditar: boolean; onEditar: (i: { indice: Indice; ano: number; mes: number; taxa?: string }) => void }) {
  const utils = trpc.useUtils();
  const [erro, setErro] = useState<string | null>(null);
  const liberar = trpc.fin.indices.liberarParaBcb.useMutation({ onSuccess: () => utils.fin.indices.listar.invalidate(), onError: (e) => setErro(msgErro(e)) });
  const excluir = trpc.fin.indices.excluir.useMutation({ onSuccess: () => { utils.fin.indices.listar.invalidate(); utils.fin.invalidate(); }, onError: (e) => setErro(msgErro(e)) });
  if (!l) {
    return (
      <td className={`${td} text-right text-gray-300`}>
        — {podeEditar && <button className={`${btnLink} ml-1 no-print`} onClick={() => onEditar({ indice, ano, mes })}>incluir</button>}
      </td>
    );
  }
  return (
    <td className={`${td} text-right`}>
      <span className="font-mono">{fmtNum(l.taxa, 4)}%</span>{" "}
      {l.origem === "manual" ? <Pill cor="amber" title="Editada manualmente: a importação do BCB não sobrescreve">manual</Pill> : <Pill cor="gray">BCB</Pill>}
      {podeEditar && (
        <span className="ml-2 inline-flex gap-2 no-print">
          <button className={btnLink} onClick={() => onEditar({ indice, ano, mes, taxa: fmtNum(l.taxa, 4) })}>editar</button>
          {l.origem === "manual" && <button className={btnLink} disabled={liberar.isLoading} onClick={() => liberar.mutate({ id: l.id })} title="A próxima importação do BCB volta a atualizar esta taxa">liberar p/ BCB</button>}
          <button className={btnLinkRed} disabled={excluir.isLoading} onClick={() => { if (confirm(`Excluir ${indice.toUpperCase()} de ${fmtMes(ano, mes)}?`)) excluir.mutate({ id: l.id }); }}>×</button>
        </span>
      )}
      {erro && <div className="text-[11px] text-red-600">{erro}</div>}
    </td>
  );
}

export default function Indices() {
  const { podeEditar } = useFinPermissoes();
  const utils = trpc.useUtils();
  const [anoDe, setAnoDe] = useState(anoAtual() - 2);
  const q = trpc.fin.indices.listar.useQuery({ anoDe, anoAte: anoAtual() + 1 });
  const [modal, setModal] = useState<{ indice: Indice; ano: number; mes: number; taxa?: string } | null>(null);
  const [res, setRes] = useState<Importacao | null>(null);
  const importar = trpc.fin.indices.importar.useMutation({
    onSuccess: (r) => { setRes(r); utils.fin.indices.listar.invalidate(); utils.fin.invalidate(); },
  });

  const meses = useMemo(() => {
    const mapa = new Map<string, { ano: number; mes: number; selic?: Linha; cdi?: Linha }>();
    for (const l of q.data ?? []) {
      const k = `${l.ano}-${String(l.mes).padStart(2, "0")}`;
      const e = mapa.get(k) ?? { ano: l.ano, mes: l.mes };
      if (l.indice === "selic") e.selic = l; else if (l.indice === "cdi") e.cdi = l;
      mapa.set(k, e);
    }
    // garante o mês atual na lista (para lançar manualmente se o BCB ainda não publicou)
    const atual = mesAtualStr();
    if (!mapa.has(atual)) { const [a, m] = atual.split("-").map(Number); mapa.set(atual, { ano: a, mes: m }); }
    return [...mapa.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([, v]) => v);
  }, [q.data]);

  async function exportar() {
    await exportarExcel({
      nomeArquivo: "indices-selic-cdi",
      abas: [{
        nome: "Selic e CDI",
        colunas: [
          { chave: "mes", titulo: "Mês" }, { chave: "selic", titulo: "Selic (% a.m.)", tipo: "numero", largura: 14 }, { chave: "os", titulo: "Origem Selic" },
          { chave: "cdi", titulo: "CDI (% a.m.)", tipo: "numero", largura: 14 }, { chave: "oc", titulo: "Origem CDI" },
        ],
        linhas: meses.map((m) => ({
          mes: fmtMes(m.ano, m.mes), selic: m.selic ? num(m.selic.taxa) : null, os: m.selic?.origem ?? "",
          cdi: m.cdi ? num(m.cdi.taxa) : null, oc: m.cdi?.origem ?? "",
        })),
      }],
    });
  }

  return (
    <div className="p-4 md:p-6 space-y-6">
      <Cabecalho titulo="Índices (Selic / CDI)" subtitulo="Taxas mensais (% a.m.) usadas na correção do empréstimo PSA, nos juros do bancário e no rendimento das aplicações. Fonte: BCB/SGS 4390 e 4391.">
        <select value={anoDe} onChange={(e) => setAnoDe(Number(e.target.value))} className="border rounded-lg px-3 py-2 text-sm bg-white" title="Mostrar desde">
          {Array.from({ length: 8 }, (_, i) => anoAtual() - i).map((a) => <option key={a} value={a}>desde {a}</option>)}
        </select>
        <BotoesExportar onExcel={exportar} tituloPdf="Índices Selic e CDI" desabilitado={!q.data?.length} />
        {podeEditar && (
          <>
            <button className={btnSec} onClick={() => setModal({ indice: "selic", ano: Number(mesAtualStr().slice(0, 4)), mes: Number(mesAtualStr().slice(5)) })}>Incluir manual</button>
            <button className={btnPri} disabled={importar.isLoading} onClick={() => { setRes(null); importar.mutate({}); }}>
              {importar.isLoading ? "Importando…" : "Importar do BCB"}
            </button>
          </>
        )}
      </Cabecalho>

      {importar.error && <ErroBox erro={importar.error} titulo="Falha na importação" />}
      {res && (
        <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm text-green-800 space-y-1">
          {res.map((r) => (
            <p key={r.indice}>
              <b>{r.indice.toUpperCase()}</b>: {r.erro ? <span className="text-red-700">erro — {r.erro}</span> : `${r.recebidos} recebidos, ${r.criados} novos, ${r.atualizados} atualizados, ${r.manuaisPreservados} manuais preservados`}
            </p>
          ))}
        </div>
      )}

      <Card>
        {q.error ? <div className="p-4"><ErroBox erro={q.error} /></div> : !q.data ? <p className="p-6 text-sm text-gray-400 animate-pulse">Carregando…</p> : !q.data.length && meses.length <= 1 ? (
          <Vazio texto={podeEditar ? "Nenhuma taxa cadastrada. Clique em “Importar do BCB”." : "Nenhuma taxa cadastrada."} />
        ) : (
          <TabelaWrap>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b"><tr>
                <th className={`${th} text-left`}>Mês</th><th className={`${th} text-right`}>Selic (% a.m.)</th><th className={`${th} text-right`}>CDI (% a.m.)</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-100">
                {meses.map((m) => (
                  <tr key={`${m.ano}-${m.mes}`}>
                    <td className={td}>{fmtMes(m.ano, m.mes, true)}</td>
                    <CelulaIndice l={m.selic} indice="selic" ano={m.ano} mes={m.mes} podeEditar={podeEditar} onEditar={setModal} />
                    <CelulaIndice l={m.cdi} indice="cdi" ano={m.ano} mes={m.mes} podeEditar={podeEditar} onEditar={setModal} />
                  </tr>
                ))}
              </tbody>
            </table>
          </TabelaWrap>
        )}
      </Card>
      <p className="text-xs text-gray-500">Mês sem taxa publicada: os cálculos usam a última taxa conhecida e marcam o valor como “projetado”.</p>
      {modal && <ModalIndice inicial={modal} onClose={() => setModal(null)} />}
    </div>
  );
}
