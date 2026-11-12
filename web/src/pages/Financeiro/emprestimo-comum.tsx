/** Partes comuns das telas de Empréstimo PSA e Empréstimo bancário. */
import { useState } from "react";
import { trpc } from "../../lib/trpc";
import {
  Campo, ErroBox, Modal, Pill, TabelaWrap, btnLink, btnLinkRed, btnPri, btnSec, dataInput, fmtBrl, fmtData,
  hojeStr, inputCls, msgErro, parseValor, td, th, valorInput, type RO,
} from "./fin-ui";

export type EmprestimoLista = RO["fin"]["emprestimos"]["listar"][number];
export type EmprestimoDet = RO["fin"]["emprestimos"]["obter"];
export type MovEmp = EmprestimoDet["movs"][number];
export type TipoMovEmp = "saldo_inicial" | "aporte" | "amortizacao" | "devolucao" | "pagamento_juros" | "pagamento_parcela";

export const ROTULO_MOV_EMP: Record<string, string> = {
  saldo_inicial: "Saldo inicial", aporte: "Aporte", amortizacao: "Amortização", devolucao: "Devolução",
  pagamento_juros: "Pagamento de juros", pagamento_parcela: "Pagamento de parcela",
};
export const ENTRADA_EMP = new Set(["saldo_inicial", "aporte"]);

/** Seleção do empréstimo da lista (o primeiro ativo por padrão). */
export function useEmprestimoSelecionado(lista: EmprestimoLista[] | undefined) {
  const [sel, setSel] = useState<string>("");
  const atual = lista?.find((e) => e.id === sel) ?? lista?.find((e) => e.ativo) ?? lista?.[0] ?? null;
  return { atual, setSel };
}

export function SeletorEmprestimo({ lista, atual, onChange }: { lista: EmprestimoLista[]; atual: EmprestimoLista | null; onChange: (id: string) => void }) {
  if (lista.length <= 1) return null;
  return (
    <select value={atual?.id ?? ""} onChange={(e) => onChange(e.target.value)} className="border rounded-lg px-3 py-2 text-sm bg-white">
      {lista.map((e) => <option key={e.id} value={e.id}>{e.nome}{!e.ativo ? " (inativo)" : ""}</option>)}
    </select>
  );
}

// ── Cadastro do empréstimo ──────────────────────────────────────────────────

export function ModalEmprestimo({ emitenteId, tipo, emp, onClose, onSaved }: {
  emitenteId: string; tipo: "psa" | "bancario"; emp?: EmprestimoDet | null; onClose: () => void; onSaved: (id: string) => void;
}) {
  const fontes = trpc.fin.fontes.listar.useQuery({ emitenteId, incluirInativas: true });
  const [nome, setNome] = useState(emp?.nome ?? (tipo === "psa" ? "Empréstimo PSA" : "Empréstimo bancário"));
  const [dataContratacao, setDataContratacao] = useState(emp ? dataInput(emp.dataContratacao as unknown as string) : tipo === "psa" ? "2025-06-01" : hojeStr());
  const [valor, setValor] = useState(emp?.valor != null ? valorInput(emp.valor) : "");
  const [carenciaMeses, setCarenciaMeses] = useState(String(emp?.carenciaMeses ?? 0));
  const [spreadAnual, setSpreadAnual] = useState(emp?.spreadAnual != null ? valorInput(emp.spreadAnual) : "6,00");
  const [numParcelas, setNumParcelas] = useState(emp?.numParcelas != null ? String(emp.numParcelas) : "");
  const [sistema, setSistema] = useState<"sac" | "price">((emp?.sistema as "sac" | "price") ?? "sac");
  const [carenciaModo, setCarenciaModo] = useState<"juros_pagos" | "capitalizados">((emp?.carenciaModo as "juros_pagos" | "capitalizados") ?? "juros_pagos");
  const [iof, setIof] = useState(emp?.iof != null ? valorInput(emp.iof) : "");
  const [tarifas, setTarifas] = useState(emp?.tarifas != null ? valorInput(emp.tarifas) : "");
  const [fonteId, setFonteId] = useState(emp?.fonteId ?? "");
  const [ativo, setAtivo] = useState(emp?.ativo ?? true);
  const [obs, setObs] = useState(emp?.obs ?? "");
  const [erro, setErro] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const fim = (id: string) => { utils.fin.emprestimos.invalidate(); utils.fin.relatorios.invalidate(); utils.fin.aplicacoes.indicadores.invalidate(); onSaved(id); onClose(); };
  const criar = trpc.fin.emprestimos.criar.useMutation({ onSuccess: (e) => fim(e.id), onError: (e) => setErro(msgErro(e)) });
  const atualizar = trpc.fin.emprestimos.atualizar.useMutation({ onSuccess: (e) => fim(e.id), onError: (e) => setErro(msgErro(e)) });

  function salvar() {
    setErro(null);
    const banc = tipo === "bancario";
    const v = parseValor(valor);
    const n = numParcelas.trim() ? Number(numParcelas) : null;
    const car = Number(carenciaMeses || "0");
    const spr = parseValor(spreadAnual);
    if (banc) {
      if (!v || v <= 0) { setErro("Informe o valor contratado"); return; }
      if (!n || !Number.isInteger(n) || n < 1) { setErro("Informe o número de parcelas"); return; }
      if (!Number.isInteger(car) || car < 0) { setErro("Carência em meses inteiros"); return; }
      if (spr === null || spr < 0) { setErro("Spread inválido"); return; }
    }
    const campos = {
      nome: nome.trim(),
      dataContratacao,
      fonteId: fonteId || null,
      ativo,
      obs: obs.trim() || null,
      ...(banc ? {
        valor: v,
        carenciaMeses: car,
        spreadAnual: spr ?? 6,
        numParcelas: n,
        sistema,
        carenciaModo,
        iof: parseValor(iof),
        tarifas: parseValor(tarifas),
      } : {}),
    };
    if (emp) atualizar.mutate({ id: emp.id, ...campos });
    else criar.mutate({ emitenteId, tipo, ...campos });
  }

  const banc = tipo === "bancario";
  return (
    <Modal titulo={emp ? "Editar empréstimo" : banc ? "Novo empréstimo bancário" : "Novo empréstimo PSA"} onClose={onClose} largura="max-w-2xl">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Campo rotulo="Nome *" className="sm:col-span-2"><input value={nome} onChange={(e) => setNome(e.target.value)} className={inputCls} /></Campo>
        <Campo rotulo={banc ? "Data da contratação *" : "Data de início *"}>
          <input type="date" value={dataContratacao} onChange={(e) => setDataContratacao(e.target.value)} className={inputCls} />
        </Campo>
        <Campo rotulo="Fonte de recursos vinculada" dica="Vazio = fonte padrão do tipo">
          <select value={fonteId} onChange={(e) => setFonteId(e.target.value)} className={inputCls}>
            <option value="">(padrão)</option>
            {(fontes.data ?? []).map((f) => <option key={f.id} value={f.id}>{f.nome}{!f.ativo ? " (inativa)" : ""}</option>)}
          </select>
        </Campo>
        {banc && (
          <>
            <Campo rotulo="Valor contratado (R$) *"><input value={valor} onChange={(e) => setValor(e.target.value)} inputMode="decimal" className={inputCls} /></Campo>
            <Campo rotulo="Nº de parcelas (após a carência) *"><input value={numParcelas} onChange={(e) => setNumParcelas(e.target.value)} inputMode="numeric" className={inputCls} /></Campo>
            <Campo rotulo="Carência (meses)"><input value={carenciaMeses} onChange={(e) => setCarenciaMeses(e.target.value)} inputMode="numeric" className={inputCls} /></Campo>
            <Campo rotulo="Na carência, os juros são…">
              <select value={carenciaModo} onChange={(e) => setCarenciaModo(e.target.value as "juros_pagos" | "capitalizados")} className={inputCls}>
                <option value="juros_pagos">Pagos mês a mês</option>
                <option value="capitalizados">Capitalizados (somam ao saldo)</option>
              </select>
            </Campo>
            <Campo rotulo="Spread (% a.a., além da Selic)" dica="Juros do mês = (1+Selic do mês) × (1+spread)^(1/12) − 1">
              <input value={spreadAnual} onChange={(e) => setSpreadAnual(e.target.value)} inputMode="decimal" className={inputCls} />
            </Campo>
            <Campo rotulo="Sistema de amortização">
              <select value={sistema} onChange={(e) => setSistema(e.target.value as "sac" | "price")} className={inputCls}>
                <option value="sac">SAC (amortização constante)</option>
                <option value="price">Price (prestação recalculada a cada mês)</option>
              </select>
            </Campo>
            <Campo rotulo="IOF (R$)"><input value={iof} onChange={(e) => setIof(e.target.value)} inputMode="decimal" className={inputCls} /></Campo>
            <Campo rotulo="Tarifas (R$)"><input value={tarifas} onChange={(e) => setTarifas(e.target.value)} inputMode="decimal" className={inputCls} /></Campo>
          </>
        )}
        <Campo rotulo="Observação" className="sm:col-span-2"><input value={obs} onChange={(e) => setObs(e.target.value)} className={inputCls} /></Campo>
        <label className="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" checked={ativo} onChange={(e) => setAtivo(e.target.checked)} /> Ativo</label>
      </div>
      {!banc && !emp && <p className="text-xs text-gray-500">Depois de criar, lance o <b>saldo inicial</b> (data-base, ex.: jun/2025) e os aportes nos movimentos.</p>}
      {erro && <ErroBox erro={erro} />}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={btnSec}>Cancelar</button>
        <button onClick={salvar} disabled={!nome.trim() || !dataContratacao || criar.isLoading || atualizar.isLoading} className={btnPri}>Salvar</button>
      </div>
    </Modal>
  );
}

// ── Movimentos ──────────────────────────────────────────────────────────────

export function ModalMov({ emprestimoId, tiposPermitidos, permitePrevisto, mov, tipoPadrao, onClose }: {
  emprestimoId: string; tiposPermitidos: TipoMovEmp[]; permitePrevisto: boolean; mov?: MovEmp; tipoPadrao?: TipoMovEmp; onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [tipo, setTipo] = useState<TipoMovEmp>((mov?.tipo as TipoMovEmp) ?? tipoPadrao ?? tiposPermitidos[0]);
  const [data, setData] = useState(mov ? dataInput(mov.data as unknown as string) : tipoPadrao === "saldo_inicial" ? "" : hojeStr());
  const [valor, setValor] = useState(mov ? valorInput(mov.valor) : "");
  const [previsto, setPrevisto] = useState(mov?.previsto ?? false);
  const [obs, setObs] = useState(mov?.obs ?? "");
  const [erro, setErro] = useState<string | null>(null);
  const fim = () => { utils.fin.emprestimos.invalidate(); utils.fin.relatorios.invalidate(); utils.fin.aplicacoes.indicadores.invalidate(); onClose(); };
  const criar = trpc.fin.emprestimos.criarMov.useMutation({ onSuccess: fim, onError: (e) => setErro(msgErro(e)) });
  const atualizar = trpc.fin.emprestimos.atualizarMov.useMutation({ onSuccess: fim, onError: (e) => setErro(msgErro(e)) });
  function salvar() {
    setErro(null);
    const v = parseValor(valor);
    if (!v || v <= 0) { setErro("Informe um valor positivo"); return; }
    if (!data) { setErro("Informe a data"); return; }
    const campos = { tipo, data, valor: v, previsto: permitePrevisto ? previsto : undefined, obs: obs.trim() || null };
    if (mov) atualizar.mutate({ id: mov.id, ...campos });
    else criar.mutate({ emprestimoId, ...campos });
  }
  return (
    <Modal titulo={mov ? "Editar movimento" : "Novo movimento"} onClose={onClose}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Campo rotulo="Tipo">
          <select value={tipo} onChange={(e) => setTipo(e.target.value as TipoMovEmp)} className={inputCls}>
            {tiposPermitidos.map((t) => <option key={t} value={t}>{ROTULO_MOV_EMP[t]}</option>)}
          </select>
        </Campo>
        <Campo rotulo="Data *" dica={tipo === "saldo_inicial" ? "Data-base do saldo migrado (ex.: jun/2025)" : undefined}>
          <input type="date" value={data} onChange={(e) => setData(e.target.value)} className={inputCls} />
        </Campo>
        <Campo rotulo="Valor (R$) *"><input value={valor} onChange={(e) => setValor(e.target.value)} inputMode="decimal" className={inputCls} /></Campo>
        {permitePrevisto && (
          <label className="flex items-center gap-2 text-sm text-gray-700 self-end pb-2">
            <input type="checkbox" checked={previsto} onChange={(e) => setPrevisto(e.target.checked)} />
            Previsto (só entra na projeção)
          </label>
        )}
        <Campo rotulo="Observação" className="sm:col-span-2"><input value={obs} onChange={(e) => setObs(e.target.value)} className={inputCls} /></Campo>
      </div>
      {erro && <ErroBox erro={erro} />}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={btnSec}>Cancelar</button>
        <button onClick={salvar} disabled={criar.isLoading || atualizar.isLoading} className={btnPri}>Salvar</button>
      </div>
    </Modal>
  );
}

export function TabelaMovs({ movs, podeEditar, onEditar, filtro }: {
  movs: MovEmp[]; podeEditar: boolean; onEditar: (m: MovEmp) => void; filtro?: (m: MovEmp) => boolean;
}) {
  const utils = trpc.useUtils();
  const [erro, setErro] = useState<string | null>(null);
  const excluir = trpc.fin.emprestimos.excluirMov.useMutation({
    onSuccess: () => { utils.fin.emprestimos.invalidate(); utils.fin.relatorios.invalidate(); },
    onError: (e) => setErro(msgErro(e)),
  });
  const lista = filtro ? movs.filter(filtro) : movs;
  return (
    <>
      {erro && <div className="p-3"><ErroBox erro={erro} /></div>}
      <TabelaWrap>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b"><tr>
            <th className={`${th} text-left`}>Data</th><th className={`${th} text-left`}>Tipo</th><th className={`${th} text-right`}>Valor</th>
            <th className={`${th} text-left`}>Observação</th><th className={`${th} no-print`} />
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {!lista.length && <tr><td colSpan={5} className="p-6 text-center text-gray-400">Nenhum movimento.</td></tr>}
            {lista.map((m) => (
              <tr key={m.id} className={m.previsto ? "bg-amber-50/50" : ""}>
                <td className={td}>{fmtData(m.data as unknown as string)}</td>
                <td className={td}>
                  {ROTULO_MOV_EMP[m.tipo] ?? m.tipo} {m.previsto && <Pill cor="amber">previsto</Pill>}
                </td>
                <td className={`${td} text-right font-medium ${ENTRADA_EMP.has(m.tipo) ? "text-gray-900" : "text-green-700"}`}>
                  {ENTRADA_EMP.has(m.tipo) ? "" : "−"}{fmtBrl(m.valor)}
                </td>
                <td className="px-3 py-2 text-gray-500 text-xs">{m.obs ?? ""}</td>
                <td className={`${td} text-right no-print`}>
                  {podeEditar && (
                    <span className="inline-flex gap-3">
                      <button className={btnLink} onClick={() => onEditar(m)}>Editar</button>
                      <button className={btnLinkRed} disabled={excluir.isLoading}
                        onClick={() => { if (confirm("Excluir este movimento?")) { setErro(null); excluir.mutate({ id: m.id }); } }}>Excluir</button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TabelaWrap>
    </>
  );
}

/** Botão "Excluir empréstimo" com confirmação. */
export function BotaoExcluirEmprestimo({ emp, onExcluido }: { emp: { id: string; nome: string }; onExcluido: () => void }) {
  const utils = trpc.useUtils();
  const [erro, setErro] = useState<string | null>(null);
  const excluir = trpc.fin.emprestimos.excluir.useMutation({
    onSuccess: () => { utils.fin.emprestimos.invalidate(); utils.fin.relatorios.invalidate(); onExcluido(); },
    onError: (e) => setErro(msgErro(e)),
  });
  return (
    <span className="inline-flex items-center gap-2">
      <button className={btnLinkRed} disabled={excluir.isLoading}
        onClick={() => { if (confirm(`Excluir "${emp.nome}" e TODOS os movimentos? Esta ação não pode ser desfeita.`)) excluir.mutate({ id: emp.id }); }}>
        Excluir empréstimo
      </button>
      {erro && <span className="text-xs text-red-600">{erro}</span>}
    </span>
  );
}
