import { useState } from "react";
import { trpc } from "../../lib/trpc";
import { exportarExcel } from "../../lib/exportar";
import {
  BotoesExportar, Cabecalho, Campo, ErroBox, ExigeEmitente, Modal, Pill, ROTULO_TIPO_FONTE, TabelaWrap,
  btnLink, btnLinkRed, btnPri, btnSec, inputCls, msgErro, td, th, useEmitenteFin, useFinPermissoes, type RO,
} from "./fin-ui";

type Fonte = RO["fin"]["fontes"]["listar"][number];
type TipoFonte = "emprestimo_psa" | "emprestimo_bancario" | "receita_propria" | "outra";
const TIPOS: TipoFonte[] = ["emprestimo_psa", "emprestimo_bancario", "receita_propria", "outra"];

function ModalFonte({ emitenteId, fonte, onClose }: { emitenteId: string; fonte?: Fonte; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [nome, setNome] = useState(fonte?.nome ?? "");
  const [tipo, setTipo] = useState<TipoFonte>((fonte?.tipo as TipoFonte) ?? "outra");
  const [ordem, setOrdem] = useState(String(fonte?.ordem ?? ""));
  const [erro, setErro] = useState<string | null>(null);
  const done = () => { utils.fin.fontes.listar.invalidate(); onClose(); };
  const criar = trpc.fin.fontes.criar.useMutation({ onSuccess: done, onError: (e) => setErro(msgErro(e)) });
  const atualizar = trpc.fin.fontes.atualizar.useMutation({ onSuccess: done, onError: (e) => setErro(msgErro(e)) });
  function salvar() {
    setErro(null);
    const o = ordem.trim() ? Number(ordem) : undefined;
    if (o !== undefined && !Number.isInteger(o)) { setErro("Ordem deve ser um número inteiro"); return; }
    if (fonte) atualizar.mutate({ id: fonte.id, nome: nome.trim(), tipo, ordem: o });
    else criar.mutate({ emitenteId, nome: nome.trim(), tipo, ordem: o });
  }
  return (
    <Modal titulo={fonte ? "Editar fonte" : "Nova fonte de recursos"} onClose={onClose}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Campo rotulo="Nome *" className="sm:col-span-2"><input value={nome} onChange={(e) => setNome(e.target.value)} className={inputCls} /></Campo>
        <Campo rotulo="Tipo">
          <select value={tipo} onChange={(e) => setTipo(e.target.value as TipoFonte)} className={inputCls}>
            {TIPOS.map((t) => <option key={t} value={t}>{ROTULO_TIPO_FONTE[t]}</option>)}
          </select>
        </Campo>
        <Campo rotulo="Ordem na lista" dica="Menor aparece primeiro"><input value={ordem} onChange={(e) => setOrdem(e.target.value)} inputMode="numeric" className={inputCls} /></Campo>
      </div>
      {erro && <ErroBox erro={erro} />}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={btnSec}>Cancelar</button>
        <button onClick={salvar} disabled={!nome.trim() || criar.isLoading || atualizar.isLoading} className={btnPri}>Salvar</button>
      </div>
    </Modal>
  );
}

function Lista({ emitenteId }: { emitenteId: string }) {
  const { podeEditar } = useFinPermissoes();
  const utils = trpc.useUtils();
  const q = trpc.fin.fontes.listar.useQuery({ emitenteId, incluirInativas: true });
  const [modal, setModal] = useState<{ fonte?: Fonte } | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const onErr = (e: unknown) => setErro(msgErro(e));
  const atualizar = trpc.fin.fontes.atualizar.useMutation({ onSuccess: () => utils.fin.fontes.listar.invalidate(), onError: onErr });
  const excluir = trpc.fin.fontes.excluir.useMutation({ onSuccess: () => utils.fin.fontes.listar.invalidate(), onError: onErr });

  if (q.error) return <ErroBox erro={q.error} />;
  if (!q.data) return <div className="bg-white border rounded-xl p-8 text-center text-sm text-gray-400 animate-pulse">Carregando…</div>;
  const fontes = q.data;

  async function exportar() {
    await exportarExcel({
      nomeArquivo: "fontes-de-recursos",
      abas: [{
        nome: "Fontes",
        colunas: [
          { chave: "nome", titulo: "Fonte", largura: 34 }, { chave: "tipo", titulo: "Tipo" }, { chave: "ativo", titulo: "Ativa" },
          { chave: "ordem", titulo: "Ordem", tipo: "numero" }, { chave: "lanc", titulo: "Lançamentos", tipo: "numero" },
          { chave: "emp", titulo: "Empréstimos", tipo: "numero" }, { chave: "resg", titulo: "Resgates", tipo: "numero" },
        ],
        linhas: fontes.map((f) => ({
          nome: f.nome, tipo: ROTULO_TIPO_FONTE[f.tipo] ?? f.tipo, ativo: f.ativo, ordem: f.ordem,
          lanc: f._count.lancamentos, emp: f._count.emprestimos, resg: f._count.aplicacaoMovs,
        })),
      }],
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center gap-2 flex-wrap no-print">
        <p className="text-xs text-gray-500">Fontes usadas no rateio das despesas e no destino dos resgates. Fonte em uso não pode ser excluída — desative.</p>
        <div className="flex gap-2">
          <BotoesExportar onExcel={exportar} tituloPdf="Fontes de recursos" />
          {podeEditar && <button className={btnPri} onClick={() => setModal({})}>+ Nova fonte</button>}
        </div>
      </div>
      {erro && <ErroBox erro={erro} />}
      <div className="bg-white border border-gray-200 rounded-xl">
        <TabelaWrap>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b"><tr>
              <th className={`${th} text-left`}>Fonte</th><th className={`${th} text-left`}>Tipo</th><th className={`${th} text-center`}>Situação</th>
              <th className={`${th} text-right`}>Lançamentos</th><th className={`${th} text-right`}>Empréstimos</th><th className={`${th} text-right`}>Resgates</th>
              <th className={`${th} no-print`} />
            </tr></thead>
            <tbody className="divide-y divide-gray-100">
              {!fontes.length && <tr><td colSpan={7} className="p-6 text-center text-gray-400">Nenhuma fonte.</td></tr>}
              {fontes.map((f) => {
                const emUso = f._count.lancamentos + f._count.emprestimos + f._count.aplicacaoMovs > 0;
                return (
                  <tr key={f.id} className={f.ativo ? "" : "opacity-60"}>
                    <td className={`${td} font-medium`}>{f.nome}</td>
                    <td className={td}>{ROTULO_TIPO_FONTE[f.tipo] ?? f.tipo}</td>
                    <td className={`${td} text-center`}>{f.ativo ? <Pill cor="green">ativa</Pill> : <Pill>inativa</Pill>}</td>
                    <td className={`${td} text-right`}>{f._count.lancamentos}</td>
                    <td className={`${td} text-right`}>{f._count.emprestimos}</td>
                    <td className={`${td} text-right`}>{f._count.aplicacaoMovs}</td>
                    <td className={`${td} text-right no-print`}>
                      {podeEditar && (
                        <span className="inline-flex gap-3">
                          <button className={btnLink} onClick={() => setModal({ fonte: f })}>Editar</button>
                          <button className={btnLink} disabled={atualizar.isLoading} onClick={() => { setErro(null); atualizar.mutate({ id: f.id, ativo: !f.ativo }); }}>
                            {f.ativo ? "Desativar" : "Reativar"}
                          </button>
                          {!emUso && (
                            <button className={btnLinkRed} disabled={excluir.isLoading}
                              onClick={() => { if (confirm(`Excluir a fonte "${f.nome}"?`)) { setErro(null); excluir.mutate({ id: f.id }); } }}>Excluir</button>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TabelaWrap>
      </div>
      {modal && <ModalFonte emitenteId={emitenteId} fonte={modal.fonte} onClose={() => setModal(null)} />}
    </div>
  );
}

export default function Fontes() {
  const emit = useEmitenteFin();
  return (
    <div className="p-4 md:p-6 space-y-6">
      <Cabecalho titulo="Fontes de recursos" subtitulo="De onde sai o dinheiro de cada despesa." emitente={emit} />
      <ExigeEmitente ctl={emit}><Lista emitenteId={emit.emitenteId} /></ExigeEmitente>
    </div>
  );
}
