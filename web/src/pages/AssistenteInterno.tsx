import { useState } from "react";
import { trpc } from "../lib/trpc";

// ─── Types ────────────────────────────────────────────────────────────────────

type Sessao = {
  id: string;
  phone: string;
  step: string;
  updatedAt: string;
  totalMensagens: number;
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AssistenteInterno() {
  const projetos  = trpc.ia.listProjetos.useQuery();
  const [projetoId, setProjetoId] = useState<string>("");

  const pid = projetoId || (projetos.data as any)?.[0]?.id || "";

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-800">Assistente Interno</h1>
        <p className="text-sm text-gray-500 mt-1">
          Equipe do escritório gera propostas, contratos e procurações via WhatsApp
        </p>
      </div>

      {/* Seletor de projeto */}
      {(projetos.data as any[])?.length > 1 && (
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Projeto IA</label>
          <select
            value={pid}
            onChange={(e) => setProjetoId(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm"
          >
            {(projetos.data as any[]).map((p: any) => (
              <option key={p.id} value={p.id}>{p.nome}</option>
            ))}
          </select>
        </div>
      )}

      {pid && (
        <>
          <ConfigSection projetoId={pid} />
          <WhitelistSection />
          <SessoesSection />
        </>
      )}
    </div>
  );
}

// ─── Config Section ───────────────────────────────────────────────────────────

function ConfigSection({ projetoId }: { projetoId: string }) {
  const configs   = trpc.ia.listConfigs.useQuery({ projetoId });
  const upsert    = trpc.ia.upsertConfig.useMutation({ onSuccess: () => configs.refetch() });

  const getCfg = (k: string) =>
    (configs.data as any[])?.find((c: any) => c.categoria === "assistente_interno" && c.chave === k)?.valor ?? "";

  const [promptExtra, setPromptExtra] = useState<string | null>(null);
  const currentPrompt   = getCfg("prompt_extra");
  const currentAtivo    = getCfg("ativo") !== "false";
  const promptDraft = promptExtra ?? currentPrompt;

  function salvarConfig(chave: string, valor: string) {
    upsert.mutate({ projetoId, chave, valor, categoria: "assistente_interno" });
  }

  return (
    <div className="bg-white border rounded-xl p-5 space-y-5">
      <h2 className="font-semibold text-gray-800">Configurações</h2>

      {/* Toggle ativo */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-700">Assistente ativo</p>
          <p className="text-xs text-gray-400">Quando inativo, mensagens de usuários da whitelist são ignoradas</p>
        </div>
        <button
          onClick={() => salvarConfig("ativo", currentAtivo ? "false" : "true")}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            currentAtivo ? "bg-green-500" : "bg-gray-300"
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
              currentAtivo ? "translate-x-6" : "translate-x-1"
            }`}
          />
        </button>
      </div>

      {/* Prompt extra */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Prompt extra
        </label>
        <p className="text-xs text-gray-400 mb-2">
          Instruções adicionais injetadas no final do system prompt. Use para definir tom,
          restrições ou contexto específico do escritório.
        </p>
        <textarea
          value={promptDraft}
          onChange={(e) => setPromptExtra(e.target.value)}
          rows={5}
          className="w-full border rounded-lg px-3 py-2 text-sm font-mono resize-y"
          placeholder="Ex: Nosso escritório atua apenas em direito do trabalho no estado da Bahia. Sempre mencione que somos especializados em motoristas carreteiros."
        />
        <div className="flex gap-2 mt-2">
          <button
            onClick={() => { salvarConfig("prompt_extra", promptDraft); setPromptExtra(null); }}
            disabled={upsert.isLoading}
            className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
          >
            {upsert.isLoading ? "Salvando..." : "Salvar prompt"}
          </button>
          {promptExtra !== null && (
            <button onClick={() => setPromptExtra(null)} className="border px-4 py-2 rounded-lg text-sm text-gray-600">
              Cancelar
            </button>
          )}
        </div>
      </div>

      {/* Help text */}
      <div className="bg-blue-50 border border-blue-100 rounded-lg p-4 text-xs text-blue-700 space-y-1">
        <p className="font-semibold mb-2">Como usar via WhatsApp</p>
        <p>• Envie texto: <span className="font-mono bg-blue-100 px-1 rounded">Gerar proposta para João Silva, CPF 000.000.000-00, serviço X, valor R$ 2.000</span></p>
        <p>• Envie foto/PDF: o sistema faz OCR e extrai dados do cliente automaticamente</p>
        <p>• O assistente pergunta o que falta (emitente, template) e gera o PDF</p>
        <p>• Digite <span className="font-mono bg-blue-100 px-1 rounded">cancelar</span> para reiniciar a conversa</p>
      </div>
    </div>
  );
}

// ─── Whitelist Section ────────────────────────────────────────────────────────

function WhitelistSection() {
  const usuarios  = trpc.auth.listUsuarios.useQuery();
  const atualizar = trpc.auth.updateUsuario.useMutation({ onSuccess: () => usuarios.refetch() });
  const [editId, setEditId]     = useState<string | null>(null);
  const [phone, setPhone]       = useState("");

  const lista = (usuarios.data as any[] | undefined) ?? [];

  function salvarWhatsApp(id: string, valor: string | null) {
    atualizar.mutate({ id, whatsapp: valor ? valor.replace(/\D/g, "") || null : null } as any);
    setEditId(null);
  }

  return (
    <div className="bg-white border rounded-xl p-5">
      <h2 className="font-semibold text-gray-800 mb-1">Whitelist</h2>
      <p className="text-xs text-gray-400 mb-4">
        Usuários com WhatsApp cadastrado podem usar o Assistente. Somente dígitos (DDI+DDD+número).
      </p>

      <div className="space-y-2">
        {lista.map((u: any) => (
          <div key={u.id} className="flex items-center gap-3 py-2 border-b last:border-0">
            <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 text-sm font-bold flex-shrink-0">
              {u.nome[0].toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-800 truncate">{u.nome}</p>
              <p className="text-xs text-gray-400 truncate">{u.email}</p>
            </div>

            {editId === u.id ? (
              <div className="flex items-center gap-2">
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="5577999999999"
                  className="border rounded px-2 py-1 text-xs font-mono w-36"
                  autoFocus
                />
                <button
                  onClick={() => salvarWhatsApp(u.id, phone)}
                  className="bg-green-600 text-white px-3 py-1 rounded text-xs"
                >Salvar</button>
                <button onClick={() => setEditId(null)} className="text-gray-400 text-xs">✕</button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                {u.whatsapp ? (
                  <>
                    <span className="text-xs font-mono text-green-700 bg-green-50 px-2 py-0.5 rounded">
                      ✅ {u.whatsapp}
                    </span>
                    <button
                      onClick={() => { setEditId(u.id); setPhone(u.whatsapp ?? ""); }}
                      className="text-xs text-indigo-600 hover:underline"
                    >Editar</button>
                    <button
                      onClick={() => salvarWhatsApp(u.id, null)}
                      className="text-xs text-red-500 hover:underline"
                    >Remover</button>
                  </>
                ) : (
                  <button
                    onClick={() => { setEditId(u.id); setPhone(""); }}
                    className="text-xs text-indigo-600 border border-indigo-200 px-2 py-0.5 rounded hover:bg-indigo-50"
                  >+ Adicionar</button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Sessões recentes ─────────────────────────────────────────────────────────

function SessoesSection() {
  const sessoes = trpc.ia.listAssistenteSessoes.useQuery({ limit: 20 });
  const clear   = trpc.ia.clearAssistenteSessao.useMutation({ onSuccess: () => sessoes.refetch() });

  const lista: Sessao[] = (sessoes.data as Sessao[] | undefined) ?? [];

  function fmtDate(d: string) {
    return new Date(d).toLocaleString("pt-BR", {
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    });
  }

  return (
    <div className="bg-white border rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold text-gray-800">Sessões recentes</h2>
        <button
          onClick={() => sessoes.refetch()}
          className="text-xs text-indigo-600 hover:underline"
        >Atualizar</button>
      </div>

      {sessoes.isLoading && <p className="text-sm text-gray-400 text-center py-4">Carregando...</p>}
      {!sessoes.isLoading && lista.length === 0 && (
        <p className="text-sm text-gray-400 text-center py-4">Nenhuma sessão ainda</p>
      )}

      <div className="space-y-2">
        {lista.map((s) => (
          <div key={s.id} className="flex items-center gap-3 py-2 border-b last:border-0">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-mono text-gray-700">{s.phone}</p>
              <p className="text-xs text-gray-400">
                {s.totalMensagens} mensagens · Última atividade: {fmtDate(s.updatedAt)}
              </p>
            </div>
            <span className={`text-xs px-2 py-0.5 rounded-full ${
              s.step === "idle" ? "bg-gray-100 text-gray-500" : "bg-yellow-100 text-yellow-700"
            }`}>
              {s.step}
            </span>
            <button
              onClick={() => clear.mutate({ phone: s.phone })}
              className="text-xs text-red-500 hover:underline flex-shrink-0"
            >Limpar</button>
          </div>
        ))}
      </div>
    </div>
  );
}
