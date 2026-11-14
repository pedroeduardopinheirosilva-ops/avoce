import { useState } from "react";
import { Check, X, Copy, Pencil } from "lucide-react";
import { trpc } from "../../lib/trpc";
import { card, btn, btnPrimario, estiloPrimario, input, DIAS_SEMANA } from "./util";

type Exp = { dias: number[]; inicio: string; fim: string };
const EXP_PADRAO: Exp = { dias: [1, 2, 3, 4, 5], inicio: "08:00", fim: "18:00" };

/** Comandos de uma linha dos instaladores (Task 8), com a origem atual no lugar da URL de produção. */
function comandoInstalacao(so: "mac" | "windows", codigo: string): string {
  const o = window.location.origin;
  return so === "mac"
    ? `curl -fsSL ${o}/api/produtividade/coletor/instalar-mac.sh | bash -s -- ${o} ${codigo}`
    : `irm ${o}/api/produtividade/coletor/instalar-windows.ps1 -OutFile $env:TEMP\\i.ps1; powershell -ExecutionPolicy Bypass -File $env:TEMP\\i.ps1 ${o} ${codigo}`;
}

const DICAS = {
  enviando: "Coletor sem enviar há mais de 2 h: verifique se o ActivityWatch e o coletor estão abertos e se o computador está ligado.",
  sites: "Sem dados de sites: instalar extensão no Chrome (ActivityWatch Web Watcher).",
  titulos: "Sem títulos de janela recentes: liberar Acessibilidade no Mac (Ajustes > Privacidade e Segurança > Acessibilidade).",
} as const;
const ROTULO_CHECK = { enviando: "Enviando", sites: "Sites", titulos: "Títulos" } as const;

function fmtDataHora(v: Date | string | null | undefined) {
  return v ? new Date(v).toLocaleString("pt-BR") : "—";
}

export default function Dispositivos() {
  const u = trpc.useUtils();
  const pessoasQ = trpc.produtividade.pessoas.listar.useQuery(undefined, { refetchInterval: 60_000 });
  const cargosQ = trpc.produtividade.cargos.listar.useQuery();
  const candidatosQ = trpc.produtividade.pessoas.candidatos.useQuery();
  const [erro, setErro] = useState("");
  const [editExp, setEditExp] = useState<{ id: string; exp: Exp } | null>(null);
  const [novoNome, setNovoNome] = useState("");
  const [marcar, setMarcar] = useState("");
  const [instalar, setInstalar] = useState<{ usuarioId: string; so: "mac" | "windows" } | null>(null);
  const [gerado, setGerado] = useState<{ usuarioId: string; comando: string; expiraEm: Date | string; copiado: boolean } | null>(null);

  const refrescar = () => { u.produtividade.pessoas.listar.invalidate(); u.produtividade.pessoas.candidatos.invalidate(); };
  const onError = (e: { message: string }) => setErro(e.message);
  const atualizar = trpc.produtividade.pessoas.atualizar.useMutation({ onSuccess: () => { refrescar(); setEditExp(null); setMarcar(""); setErro(""); }, onError });
  const criarPessoa = trpc.produtividade.pessoas.criarSoMonitorado.useMutation({ onSuccess: () => { refrescar(); setNovoNome(""); setErro(""); }, onError });
  const revogar = trpc.produtividade.dispositivos.revogar.useMutation({ onSuccess: refrescar, onError });
  const gerarCodigo = trpc.produtividade.dispositivos.gerarCodigo.useMutation({ onError });

  const pessoas = pessoasQ.data ?? [];
  const candidatos = candidatosQ.data ?? [];

  const instalarPara = async (usuarioId: string, nome: string, so: "mac" | "windows") => {
    setErro("");
    try {
      const r = await gerarCodigo.mutateAsync({ usuarioId, nome: `${nome} (${so === "mac" ? "Mac" : "Windows"})` });
      const comando = comandoInstalacao(so, r.codigo);
      let copiado = false;
      try { await navigator.clipboard.writeText(comando); copiado = true; } catch { /* mostra na tela para copiar manualmente */ }
      setGerado({ usuarioId, comando, expiraEm: r.expiraEm, copiado });
      setInstalar(null);
      refrescar();
    } catch { /* erro já exibido por onError */ }
  };

  return (
    <div className="space-y-4">
      {erro && <div className="text-sm rounded-md p-2 border" style={{ color: "var(--avoce-danger)", borderColor: "var(--avoce-danger)" }}>{erro}</div>}

      {pessoas.length === 0 && !pessoasQ.isLoading && <p className="text-sm text-gray-500">Nenhuma pessoa monitorada ainda.</p>}

      {pessoas.map((p) => {
        const exp = (p.expediente as Exp | null) ?? null;
        const e = editExp?.id === p.id ? editExp.exp : null;
        return (
          <div key={p.id} className={`${card} p-4 space-y-3`}>
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="font-semibold" style={{ color: "var(--avoce-navy)" }}>{p.nome}</h3>
              <select className={input} value={p.cargoId ?? ""} onChange={(ev) => atualizar.mutate({ usuarioId: p.id, cargoId: ev.target.value || null })}>
                <option value="">Sem cargo</option>
                {cargosQ.data?.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
              </select>
              <button className={`${btn} ml-auto`} onClick={() => { if (confirm(`Parar de monitorar ${p.nome}?`)) atualizar.mutate({ usuarioId: p.id, monitorado: false }); }}>Desmarcar monitorado</button>
            </div>

            <div className="text-sm">
              {e ? (
                <div className="flex flex-wrap items-center gap-2">
                  {DIAS_SEMANA.map((n, i) => (
                    <label key={i} className="flex items-center gap-1 text-xs">
                      <input type="checkbox" checked={e.dias.includes(i)} onChange={(ev) => setEditExp({ id: p.id, exp: { ...e, dias: ev.target.checked ? [...e.dias, i].sort() : e.dias.filter((d) => d !== i) } })} />{n}
                    </label>
                  ))}
                  <input type="time" className={input} value={e.inicio} onChange={(ev) => setEditExp({ id: p.id, exp: { ...e, inicio: ev.target.value } })} />
                  <span>às</span>
                  <input type="time" className={input} value={e.fim} onChange={(ev) => setEditExp({ id: p.id, exp: { ...e, fim: ev.target.value } })} />
                  <button className={btnPrimario} style={estiloPrimario} onClick={() => atualizar.mutate({ usuarioId: p.id, expediente: e })}>Salvar</button>
                  <button className={btn} onClick={() => atualizar.mutate({ usuarioId: p.id, expediente: null })}>Voltar ao padrão</button>
                  <button className={btn} onClick={() => setEditExp(null)}>Cancelar</button>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-gray-700">
                  <span className="text-xs text-gray-500">Expediente:</span>
                  {(exp ?? EXP_PADRAO).dias.map((d) => DIAS_SEMANA[d]).join(", ")} · {(exp ?? EXP_PADRAO).inicio}–{(exp ?? EXP_PADRAO).fim}{!exp && <span className="text-xs text-gray-400">(padrão)</span>}
                  <button className="p-1 text-gray-500 hover:text-gray-800" aria-label="Editar expediente" onClick={() => setEditExp({ id: p.id, exp: exp ?? EXP_PADRAO })}><Pencil size={13} /></button>
                </div>
              )}
            </div>

            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-gray-500" style={{ background: "var(--avoce-paper-deep)" }}>
                <th className="px-2 py-1">Dispositivo</th><th className="px-2 py-1">SO</th><th className="px-2 py-1">Último envio</th><th className="px-2 py-1">Versão</th><th className="px-2 py-1">Checks</th><th className="px-2 py-1" />
              </tr></thead>
              <tbody>
                {p.dispositivos.filter((d) => d.ativo).map((d) => {
                  const pendente = !d.pareadoEm;
                  return (
                    <tr key={d.id} className="border-t border-gray-100 align-top">
                      <td className="px-2 py-1.5">{d.nome}{pendente && <span className="ml-1 text-xs" style={{ color: "var(--avoce-warn)" }}>aguardando pareamento</span>}</td>
                      <td className="px-2 py-1.5">{d.so ?? "—"}</td>
                      <td className="px-2 py-1.5">{fmtDataHora(d.ultimoEnvioEm)}</td>
                      <td className="px-2 py-1.5">{d.versaoColetor ?? "—"}</td>
                      <td className="px-2 py-1.5">
                        {pendente ? "—" : (
                          <div className="space-y-0.5">
                            {(Object.keys(ROTULO_CHECK) as (keyof typeof ROTULO_CHECK)[]).map((k) => (
                              <div key={k} className="flex items-start gap-1 text-xs">
                                {d.checks[k] ? <Check size={13} style={{ color: "var(--avoce-success)" }} /> : <X size={13} style={{ color: "var(--avoce-danger)" }} />}
                                <span>{ROTULO_CHECK[k]}{!d.checks[k] && <span className="text-gray-500"> — {DICAS[k]}</span>}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right"><button className={btn} onClick={() => { if (confirm(`Revogar o dispositivo "${d.nome}"?`)) revogar.mutate({ id: d.id }); }}>Revogar</button></td>
                    </tr>
                  );
                })}
                {p.dispositivos.filter((d) => d.ativo).length === 0 && <tr><td colSpan={6} className="px-2 py-3 text-center text-xs text-gray-400">Nenhum dispositivo.</td></tr>}
              </tbody>
            </table>

            <div className="flex flex-wrap items-center gap-2">
              {instalar?.usuarioId === p.id ? (
                <>
                  <span className="text-xs text-gray-600">Sistema do computador:</span>
                  <button className={btnPrimario} style={estiloPrimario} disabled={gerarCodigo.isPending} onClick={() => instalarPara(p.id, p.nome, "windows")}>Windows</button>
                  <button className={btnPrimario} style={estiloPrimario} disabled={gerarCodigo.isPending} onClick={() => instalarPara(p.id, p.nome, "mac")}>Mac</button>
                  <button className={btn} onClick={() => setInstalar(null)}>Cancelar</button>
                </>
              ) : (
                <button className={btnPrimario} style={estiloPrimario} onClick={() => setInstalar({ usuarioId: p.id, so: "mac" })}>Instalar para {p.nome}</button>
              )}
            </div>

            {gerado?.usuarioId === p.id && (
              <div className="p-3 rounded-md border border-gray-200 space-y-1" style={{ background: "var(--avoce-paper)" }}>
                <p className="text-xs text-gray-600 flex items-center gap-1">
                  <Copy size={12} /> {gerado.copiado ? "Comando copiado." : "Não foi possível copiar automaticamente; copie abaixo."} Cole no terminal (Mac) ou PowerShell (Windows) do computador da pessoa. Válido até {fmtDataHora(gerado.expiraEm)} (24 h).
                </p>
                <code className="block text-xs font-mono break-all select-all">{gerado.comando}</code>
              </div>
            )}
          </div>
        );
      })}

      <div className={`${card} p-4 grid md:grid-cols-2 gap-4`}>
        <div className="space-y-1">
          <h3 className="text-sm font-semibold" style={{ color: "var(--avoce-navy)" }}>Nova pessoa só monitorada</h3>
          <p className="text-xs text-gray-500">Cria um registro sem acesso ao Avoce.</p>
          <div className="flex gap-1">
            <input className={`${input} flex-1`} placeholder="Nome" value={novoNome} onChange={(e) => setNovoNome(e.target.value)} />
            <button className={btnPrimario} style={estiloPrimario} disabled={!novoNome.trim() || criarPessoa.isPending} onClick={() => criarPessoa.mutate({ nome: novoNome })}>Criar</button>
          </div>
        </div>
        <div className="space-y-1">
          <h3 className="text-sm font-semibold" style={{ color: "var(--avoce-navy)" }}>Marcar usuário existente como monitorado</h3>
          <p className="text-xs text-gray-500">&nbsp;</p>
          <div className="flex gap-1">
            <select className={`${input} flex-1`} value={marcar} onChange={(e) => setMarcar(e.target.value)}>
              <option value="">Escolha um usuário...</option>
              {candidatos.map((x) => <option key={x.id} value={x.id}>{x.nome}</option>)}
            </select>
            <button className={btnPrimario} style={estiloPrimario} disabled={!marcar || atualizar.isPending} onClick={() => atualizar.mutate({ usuarioId: marcar, monitorado: true })}>Marcar</button>
          </div>
        </div>
      </div>
    </div>
  );
}
