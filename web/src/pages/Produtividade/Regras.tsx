import { useState } from "react";
import { Pencil, Trash2, Plus, Check, X } from "lucide-react";
import { trpc } from "../../lib/trpc";
import { card, btn, btnPrimario, estiloPrimario, input, COR_CAT, fmtDur, hojeStr, somarDias, type Cat } from "./util";

type Escopo = "geral" | "cargo" | "pessoa";
type Form = { id?: string; alvo: "app" | "dominio" | "titulo"; padrao: string; categoria: Cat; cargoId: string | null; usuarioId: string | null; prioridade: number };
const VAZIO: Form = { alvo: "dominio", padrao: "", categoria: "trabalho", cargoId: null, usuarioId: null, prioridade: 0 };

export default function Regras() {
  const u = trpc.useUtils();
  const regrasQ = trpc.produtividade.regras.listar.useQuery();
  const cargosQ = trpc.produtividade.cargos.listar.useQuery();
  const pessoasQ = trpc.produtividade.pessoas.listar.useQuery();
  const hoje = hojeStr();
  const neutrosQ = trpc.produtividade.neutrosMaisUsados.useQuery({ de: somarDias(hoje, -29), ate: hoje });

  const [escopo, setEscopo] = useState<Escopo>("geral");
  const [cargoSel, setCargoSel] = useState<string>("");
  const [pessoaSel, setPessoaSel] = useState<string>("");
  const [form, setForm] = useState<Form | null>(null);
  const [erro, setErro] = useState("");
  const [novoCargo, setNovoCargo] = useState("");
  const [editCargo, setEditCargo] = useState<{ id: string; nome: string } | null>(null);

  const refrescar = () => { u.produtividade.regras.listar.invalidate(); u.produtividade.cargos.listar.invalidate(); };
  const onError = (e: { message: string }) => setErro(e.message);
  const criar = trpc.produtividade.regras.criar.useMutation({ onSuccess: () => { refrescar(); setForm(null); setErro(""); }, onError });
  const editar = trpc.produtividade.regras.editar.useMutation({ onSuccess: () => { refrescar(); setForm(null); setErro(""); }, onError });
  const excluir = trpc.produtividade.regras.excluir.useMutation({ onSuccess: refrescar, onError });
  const semear = trpc.produtividade.regras.semear.useMutation({ onSuccess: refrescar, onError });
  const criarCargo = trpc.produtividade.cargos.criar.useMutation({ onSuccess: () => { refrescar(); setNovoCargo(""); setErro(""); }, onError });
  const renomearCargo = trpc.produtividade.cargos.renomear.useMutation({ onSuccess: () => { refrescar(); setEditCargo(null); setErro(""); }, onError });
  const excluirCargo = trpc.produtividade.cargos.excluir.useMutation({ onSuccess: () => { refrescar(); setErro(""); }, onError });

  const cargos = cargosQ.data ?? [];
  const pessoas = pessoasQ.data ?? [];
  const regras = (regrasQ.data ?? []).filter((r) => {
    if (escopo === "geral") return !r.cargoId && !r.usuarioId;
    if (escopo === "cargo") return !!r.cargoId && (!cargoSel || r.cargoId === cargoSel);
    return !!r.usuarioId && (!pessoaSel || r.usuarioId === pessoaSel);
  });
  const nomeEscopo = (r: { cargoId: string | null; usuarioId: string | null }) =>
    r.usuarioId ? `Pessoa: ${pessoas.find((p) => p.id === r.usuarioId)?.nome ?? "—"}`
      : r.cargoId ? `Cargo: ${cargos.find((c) => c.id === r.cargoId)?.nome ?? "—"}` : "Geral";

  const salvar = () => {
    if (!form || !form.padrao.trim()) return;
    const { id, ...resto } = form;
    if (id) editar.mutate({ id, ...resto }); else criar.mutate(resto);
  };
  const novaRegra = () => setForm({
    ...VAZIO,
    cargoId: escopo === "cargo" ? cargoSel || null : null,
    usuarioId: escopo === "pessoa" ? pessoaSel || null : null,
  });
  const neutroPara = (chave: string, tipo: "app" | "dominio", categoria: Cat) => {
    criar.mutate({ alvo: tipo, padrao: chave, categoria, cargoId: escopo === "cargo" && cargoSel ? cargoSel : null, usuarioId: null, prioridade: 0 });
  };

  return (
    <div className="space-y-4">
      {erro && <div className="text-sm rounded-md p-2 border" style={{ color: "var(--avoce-danger)", borderColor: "var(--avoce-danger)" }}>{erro}</div>}
      <div className="grid lg:grid-cols-3 gap-4">
        <div className={`${card} lg:col-span-2 p-4 space-y-3`}>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-md overflow-hidden border border-gray-300">
              {(["geral", "cargo", "pessoa"] as Escopo[]).map((e) => (
                <button key={e} onClick={() => setEscopo(e)} className="px-3 py-1 text-xs capitalize"
                  style={{ background: escopo === e ? "var(--avoce-navy)" : "white", color: escopo === e ? "white" : "var(--avoce-ink)" }}>{e}</button>
              ))}
            </div>
            {escopo === "cargo" && (
              <select className={input} value={cargoSel} onChange={(e) => setCargoSel(e.target.value)}>
                <option value="">Todos os cargos</option>{cargos.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
              </select>
            )}
            {escopo === "pessoa" && (
              <select className={input} value={pessoaSel} onChange={(e) => setPessoaSel(e.target.value)}>
                <option value="">Todas as pessoas</option>{pessoas.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
              </select>
            )}
            <button className={`${btnPrimario} ml-auto flex items-center gap-1`} style={estiloPrimario} onClick={novaRegra}><Plus size={13} /> Nova regra</button>
          </div>

          {form && (
            <div className="p-3 rounded-md border border-gray-200 grid grid-cols-2 md:grid-cols-6 gap-2 items-end" style={{ background: "var(--avoce-paper)" }}>
              <label className="text-xs">Alvo
                <select className={`${input} w-full`} value={form.alvo} onChange={(e) => setForm({ ...form, alvo: e.target.value as Form["alvo"] })}>
                  <option value="app">App</option><option value="dominio">Domínio</option><option value="titulo">Título</option>
                </select></label>
              <label className="text-xs md:col-span-2">Padrão
                <input className={`${input} w-full`} value={form.padrao} onChange={(e) => setForm({ ...form, padrao: e.target.value })} /></label>
              <label className="text-xs">Categoria
                <select className={`${input} w-full`} value={form.categoria} onChange={(e) => setForm({ ...form, categoria: e.target.value as Cat })}>
                  <option value="trabalho">Trabalho</option><option value="pessoal">Pessoal</option><option value="neutro">Neutro</option>
                </select></label>
              <label className="text-xs">Prioridade
                <input type="number" className={`${input} w-full`} value={form.prioridade} onChange={(e) => setForm({ ...form, prioridade: Number(e.target.value) || 0 })} /></label>
              <label className="text-xs">Vale para
                <select className={`${input} w-full`}
                  value={form.usuarioId ? `p:${form.usuarioId}` : form.cargoId ? `c:${form.cargoId}` : ""}
                  onChange={(e) => { const v = e.target.value; setForm({ ...form, cargoId: v.startsWith("c:") ? v.slice(2) : null, usuarioId: v.startsWith("p:") ? v.slice(2) : null }); }}>
                  <option value="">Geral</option>
                  {cargos.map((c) => <option key={c.id} value={`c:${c.id}`}>Cargo: {c.nome}</option>)}
                  {pessoas.map((p) => <option key={p.id} value={`p:${p.id}`}>Pessoa: {p.nome}</option>)}
                </select></label>
              <div className="col-span-full flex gap-2">
                <button className={btnPrimario} style={estiloPrimario} onClick={salvar} disabled={criar.isPending || editar.isPending}>Salvar</button>
                <button className={btn} onClick={() => { setForm(null); setErro(""); }}>Cancelar</button>
              </div>
            </div>
          )}

          {regrasQ.data?.length === 0 ? (
            <div className="text-center py-8 space-y-2">
              <p className="text-sm text-gray-500">Nenhuma regra cadastrada.</p>
              <button className={btnPrimario} style={estiloPrimario} onClick={() => semear.mutate()} disabled={semear.isPending}>Semear regras iniciais</button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-gray-500" style={{ background: "var(--avoce-paper-deep)" }}>
                  <th className="px-2 py-1.5">Alvo</th><th className="px-2 py-1.5">Padrão</th><th className="px-2 py-1.5">Categoria</th><th className="px-2 py-1.5">Prioridade</th><th className="px-2 py-1.5">Escopo</th><th className="px-2 py-1.5" />
                </tr></thead>
                <tbody>
                  {regras.map((r) => (
                    <tr key={r.id} className="border-t border-gray-100">
                      <td className="px-2 py-1.5">{r.alvo}</td>
                      <td className="px-2 py-1.5 font-mono text-xs break-all">{r.padrao}</td>
                      <td className="px-2 py-1.5"><span className="inline-flex items-center gap-1"><i className="inline-block w-2 h-2 rounded-sm" style={{ background: COR_CAT[r.categoria as Cat] }} />{r.categoria}</span></td>
                      <td className="px-2 py-1.5">{r.prioridade}</td>
                      <td className="px-2 py-1.5 text-xs text-gray-600">{nomeEscopo(r)}</td>
                      <td className="px-2 py-1.5 text-right whitespace-nowrap">
                        <button className="p-1 text-gray-500 hover:text-gray-800" aria-label="Editar" onClick={() => setForm({ id: r.id, alvo: r.alvo as Form["alvo"], padrao: r.padrao, categoria: r.categoria as Cat, cargoId: r.cargoId, usuarioId: r.usuarioId, prioridade: r.prioridade })}><Pencil size={14} /></button>
                        <button className="p-1 text-gray-500 hover:text-red-600" aria-label="Excluir" onClick={() => { if (confirm(`Excluir a regra "${r.padrao}"?`)) excluir.mutate({ id: r.id }); }}><Trash2 size={14} /></button>
                      </td>
                    </tr>
                  ))}
                  {regras.length === 0 && <tr><td colSpan={6} className="px-2 py-4 text-center text-gray-400 text-xs">Nenhuma regra neste filtro.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className={`${card} p-4`}>
            <h3 className="text-sm font-semibold mb-1" style={{ color: "var(--avoce-navy)" }}>Neutros mais usados</h3>
            <p className="text-xs text-gray-500 mb-2">Últimos 30 dias. Cria regra {escopo === "cargo" && cargoSel ? "do cargo selecionado" : "geral"}.</p>
            <ul className="space-y-1">
              {neutrosQ.data?.slice(0, 15).map((n) => (
                <li key={`${n.tipo}:${n.chave}`} className="flex items-center gap-2 text-sm">
                  <span className="truncate flex-1" title={n.chave}>{n.chave}</span>
                  <span className="text-xs text-gray-500">{fmtDur(n.seg)}</span>
                  <button className={btn} onClick={() => neutroPara(n.chave, n.tipo, "trabalho")} disabled={criar.isPending}>→ trabalho</button>
                  <button className={btn} onClick={() => neutroPara(n.chave, n.tipo, "pessoal")} disabled={criar.isPending}>→ pessoal</button>
                </li>
              ))}
              {neutrosQ.data?.length === 0 && <li className="text-xs text-gray-400">Nada neutro registrado.</li>}
            </ul>
          </div>

          <div className={`${card} p-4`}>
            <h3 className="text-sm font-semibold mb-2" style={{ color: "var(--avoce-navy)" }}>Cargos</h3>
            <ul className="space-y-1 mb-2">
              {cargos.map((c) => (
                <li key={c.id} className="flex items-center gap-1 text-sm">
                  {editCargo?.id === c.id ? (
                    <>
                      <input className={`${input} flex-1`} value={editCargo.nome} onChange={(e) => setEditCargo({ id: c.id, nome: e.target.value })} />
                      <button className="p-1" aria-label="Salvar" onClick={() => renomearCargo.mutate({ id: c.id, nome: editCargo.nome })}><Check size={14} /></button>
                      <button className="p-1" aria-label="Cancelar" onClick={() => setEditCargo(null)}><X size={14} /></button>
                    </>
                  ) : (
                    <>
                      <span className="flex-1">{c.nome}</span>
                      <button className="p-1 text-gray-500 hover:text-gray-800" aria-label="Renomear" onClick={() => setEditCargo({ id: c.id, nome: c.nome })}><Pencil size={13} /></button>
                      <button className="p-1 text-gray-500 hover:text-red-600" aria-label="Excluir cargo" onClick={() => { if (confirm(`Excluir o cargo "${c.nome}"?`)) excluirCargo.mutate({ id: c.id }); }}><Trash2 size={13} /></button>
                    </>
                  )}
                </li>
              ))}
              {cargos.length === 0 && <li className="text-xs text-gray-400">Nenhum cargo.</li>}
            </ul>
            <div className="flex gap-1">
              <input className={`${input} flex-1`} placeholder="Novo cargo" value={novoCargo} onChange={(e) => setNovoCargo(e.target.value)} />
              <button className={btnPrimario} style={estiloPrimario} disabled={!novoCargo.trim() || criarCargo.isPending} onClick={() => criarCargo.mutate({ nome: novoCargo })}>Adicionar</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
