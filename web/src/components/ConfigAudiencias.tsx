/**
 * Config IA → Audiências.
 *
 * Textos das mensagens e cadência do lembrete vivem no banco
 * (IaMensagemTemplate + IaProjetoConfig categoria "audiencia"). Esta tela é o
 * único lugar onde eles se editam — não há texto de mensagem no código.
 */

import { useEffect, useState } from "react";
import { trpc } from "../lib/trpc";

export default function ConfigAudiencias({ projetoId }: { projetoId: string }) {
  const utils = trpc.useUtils();
  const { data: opcoes } = trpc.audiencia.opcoes.useQuery({ projetoId });
  const templates = trpc.ia.listMensagemTemplates.useQuery({ projetoId, prefixo: "audiencia_" });
  const configs = trpc.ia.listConfigs.useQuery({ projetoId });

  const [rascunho, setRascunho] = useState<Record<string, string>>({});
  const [salvo, setSalvo] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  // Só semeia o rascunho com o que veio do banco; edição em curso não é sobrescrita.
  useEffect(() => {
    if (!templates.data) return;
    setRascunho((atual) => {
      const novo = { ...atual };
      for (const t of templates.data as any[]) if (novo[t.chave] === undefined) novo[t.chave] = t.template;
      return novo;
    });
  }, [templates.data]);

  const upsertTpl = trpc.ia.upsertMensagemTemplate.useMutation({
    onSuccess: (_d, v) => { setErro(null); setSalvo(v.chave); templates.refetch(); setTimeout(() => setSalvo(null), 2500); },
    onError: (e) => setErro(e.message),
  });
  const upsertCfg = trpc.ia.upsertConfig.useMutation({
    onSuccess: () => { setErro(null); configs.refetch(); utils.audiencia.opcoes.invalidate(); },
    onError: (e) => setErro(e.message),
  });

  const cfgChaves = opcoes?.configChaves;
  const valorCfg = (chave?: string) =>
    (configs.data as any[] | undefined)?.find((c) => c.chave === chave)?.valor ?? "";

  function salvarCfg(chave: string, valor: string, tipo: string, descricao: string) {
    upsertCfg.mutate({ projetoId, chave, valor, tipo, categoria: cfgChaves?.categoria ?? "audiencia", descricao });
  }

  /** Rótulo humano da chave, vindo dos tipos ou da descrição gravada. */
  function rotulo(chave: string): string {
    const tipo = opcoes?.tipos.find((t) => t.chaveTemplate === chave);
    if (tipo) return tipo.rotulo;
    const t = (templates.data as any[] | undefined)?.find((x) => x.chave === chave);
    return t?.descricao || chave;
  }

  const faltando = new Set(opcoes?.faltando ?? []);
  const chaves = opcoes?.chavesEsperadas ?? [];
  const inputCls = "border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500";

  return (
    <div className="space-y-6">
      {erro && <p className="text-sm text-red-600">{erro}</p>}

      {/* Cadência */}
      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <p className="text-xs font-semibold text-gray-500 uppercase mb-1">Cadência do lembrete</p>
        <p className="text-xs text-gray-500 mb-3">
          O lembrete só vai para lead cuja designação já foi enviada, no máximo uma vez por dia.
        </p>
        <div className="grid grid-cols-3 gap-3">
          <label className="text-xs text-gray-600">
            Diário faltando até (dias)
            <input
              type="number" min={0} max={60} className={`${inputCls} w-full mt-1`}
              defaultValue={valorCfg(cfgChaves?.diarioDias) || "7"}
              onBlur={(e) => salvarCfg(cfgChaves!.diarioDias, e.target.value, "numero",
                "Faltando esse número de dias ou menos, o lembrete vai todo dia")}
            />
          </label>
          <label className="text-xs text-gray-600">
            Antes disso, semanal
            <select
              className={`${inputCls} w-full mt-1`}
              value={valorCfg(cfgChaves?.semanal) === "false" ? "false" : "true"}
              onChange={(e) => salvarCfg(cfgChaves!.semanal, e.target.value, "boolean",
                "Antes disso, manda o lembrete de 7 em 7 dias")}
            >
              <option value="true">Sim, de 7 em 7 dias</option>
              <option value="false">Não, só na última semana</option>
            </select>
          </label>
          <label className="text-xs text-gray-600">
            Hora do disparo
            <input
              type="number" min={0} max={23} className={`${inputCls} w-full mt-1`}
              defaultValue={valorCfg(cfgChaves?.hora) || "9"}
              onBlur={(e) => salvarCfg(cfgChaves!.hora, e.target.value, "numero",
                "Hora do dia (0-23) em que os lembretes saem")}
            />
          </label>
        </div>
      </div>

      {/* Variáveis */}
      <div className="bg-gray-50 border border-gray-200 rounded-xl p-4">
        <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Variáveis disponíveis</p>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1">
          {opcoes?.variaveis.map((v) => (
            <p key={v.chave} className="text-xs text-gray-600">
              <code className="bg-white border border-gray-200 rounded px-1">{v.chave}</code> — {v.descricao}
            </p>
          ))}
        </div>
      </div>

      {/* Modelos */}
      {chaves.map((chave) => (
        <div key={chave} className="bg-white border border-gray-200 rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <div>
              <p className="text-sm font-medium text-gray-800">{rotulo(chave)}</p>
              <code className="text-[11px] text-gray-400">{chave}</code>
            </div>
            {faltando.has(chave) && (
              <span className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
                não cadastrado
              </span>
            )}
          </div>
          <textarea
            rows={chave === "audiencia_bloco_virtual" ? 4 : 12}
            value={rascunho[chave] ?? ""}
            onChange={(e) => setRascunho((r) => ({ ...r, [chave]: e.target.value }))}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-brand-500"
            placeholder="Escreva o texto usando as variáveis acima…"
          />
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={() => upsertTpl.mutate({
                projetoId, chave,
                template: rascunho[chave] ?? "",
                descricao: rotulo(chave),
              })}
              disabled={upsertTpl.isPending || !(rascunho[chave] ?? "").trim()}
              className="px-3 py-1.5 text-xs bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50"
            >
              Salvar modelo
            </button>
            {salvo === chave && <span className="text-xs text-green-700">Salvo ✓</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
