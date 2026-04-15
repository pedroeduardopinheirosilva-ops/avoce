import { useState } from "react";
import { trpc } from "../lib/trpc";

type Usuario = {
  id: string;
  nome: string;
  email: string;
  ativo: boolean;
  criadoEm: string;
};

type MembroProjeto = {
  usuarioId: string;
  funcao: string;
  nomeWhatsapp: string | null;
  usuario: { id: string; nome: string; email: string; ativo: boolean };
};

const FUNCAO_LABELS: Record<string, string> = {
  admin:     "Admin",
  atendente: "Atendente",
  closer:    "Closer",
};

function UserForm({
  inicial,
  onSave,
  onCancel,
  isLoading,
}: {
  inicial?: Partial<Usuario & { senha?: string }>;
  onSave: (data: { nome: string; email: string; senha?: string; ativo?: boolean }) => void;
  onCancel: () => void;
  isLoading?: boolean;
}) {
  const [form, setForm] = useState({
    nome:  inicial?.nome  ?? "",
    email: inicial?.email ?? "",
    senha: "",
    ativo: inicial?.ativo ?? true,
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ nome: form.nome, email: form.email, senha: form.senha || undefined, ativo: form.ativo });
      }}
      className="border rounded-xl p-5 bg-gray-50 space-y-3"
    >
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Nome</label>
          <input value={form.nome} onChange={(e) => setForm(f => ({ ...f, nome: e.target.value }))}
            className="w-full border rounded-lg px-3 py-2 text-sm" required />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">E-mail</label>
          <input type="email" value={form.email} onChange={(e) => setForm(f => ({ ...f, email: e.target.value }))}
            className="w-full border rounded-lg px-3 py-2 text-sm" required />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Senha {inicial?.id ? <span className="text-gray-400 font-normal">(deixe vazio para manter)</span> : ""}
          </label>
          <input type="password" value={form.senha} onChange={(e) => setForm(f => ({ ...f, senha: e.target.value }))}
            minLength={inicial?.id ? 0 : 6} placeholder="••••••"
            className="w-full border rounded-lg px-3 py-2 text-sm" />
        </div>
        {inicial?.id && (
          <div className="flex items-center gap-2 pt-5">
            <input type="checkbox" id="u-ativo" checked={form.ativo} onChange={(e) => setForm(f => ({ ...f, ativo: e.target.checked }))} className="rounded" />
            <label htmlFor="u-ativo" className="text-sm text-gray-700">Ativo</label>
          </div>
        )}
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={isLoading} className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
          {isLoading ? "Salvando..." : "Salvar"}
        </button>
        <button type="button" onClick={onCancel} className="border px-4 py-2 rounded-lg text-sm text-gray-600 hover:bg-gray-50">Cancelar</button>
      </div>
    </form>
  );
}

function ProjetoAssignment({ usuarioId, projetoId, nomeUsuario }: { usuarioId: string; projetoId: string; nomeUsuario: string }) {
  const [editando, setEditando] = useState(false);
  const [funcao, setFuncao]           = useState("atendente");
  const [nomeWhatsapp, setNomeWhatsapp] = useState("");

  const membros = trpc.ia.listUsuarios.useQuery({ projetoId });
  const upsert  = trpc.ia.upsertProjetoUsuario.useMutation({
    onSuccess: () => { membros.refetch(); setEditando(false); },
  });
  const remove  = trpc.ia.removeProjetoUsuario.useMutation({
    onSuccess: () => membros.refetch(),
  });

  const membro = (membros.data as unknown as MembroProjeto[] | undefined)?.find(m => m.usuarioId === usuarioId);

  function abrirForm(m?: MembroProjeto) {
    setFuncao(m?.funcao ?? "atendente");
    setNomeWhatsapp(m?.nomeWhatsapp ?? nomeUsuario);
    setEditando(true);
  }

  if (editando) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          upsert.mutate({ projetoId, usuarioId, funcao, nomeWhatsapp: nomeWhatsapp.trim() || null });
        }}
        className="mt-1 flex flex-wrap gap-2 items-end bg-indigo-50 border border-indigo-100 rounded-lg p-3"
      >
        <div>
          <label className="block text-xs text-gray-500 mb-0.5">Função</label>
          <select value={funcao} onChange={(e) => setFuncao(e.target.value)}
            className="border rounded px-2 py-1.5 text-sm bg-white">
            <option value="atendente">Atendente</option>
            <option value="closer">Closer</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-0.5">
            Como aparece ao intervir no WhatsApp
          </label>
          <input
            value={nomeWhatsapp}
            onChange={(e) => setNomeWhatsapp(e.target.value)}
            placeholder={nomeUsuario}
            className="border rounded px-2 py-1.5 text-sm w-52 bg-white"
            required
          />
        </div>
        <button type="submit" disabled={upsert.isLoading}
          className="bg-indigo-600 text-white px-3 py-1.5 rounded text-sm hover:bg-indigo-700 disabled:opacity-50">
          {upsert.isLoading ? "..." : "Salvar"}
        </button>
        <button type="button" onClick={() => setEditando(false)}
          className="border px-3 py-1.5 rounded text-sm text-gray-600 hover:bg-gray-50">
          Cancelar
        </button>
      </form>
    );
  }

  if (membro) {
    return (
      <div className="flex items-center gap-3 text-sm">
        <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded">{FUNCAO_LABELS[membro.funcao] ?? membro.funcao}</span>
        <span className="text-xs text-gray-600">
          aparece como: <strong>{membro.nomeWhatsapp ?? nomeUsuario}</strong>
        </span>
        <button onClick={() => abrirForm(membro)} className="text-xs text-indigo-600 hover:underline">Editar</button>
        <button onClick={() => { if (confirm("Remover acesso?")) remove.mutate({ projetoId, usuarioId }); }}
          className="text-xs text-red-500 hover:underline">Remover</button>
      </div>
    );
  }

  return (
    <button onClick={() => abrirForm()} className="text-xs text-indigo-600 hover:underline">
      + Dar acesso
    </button>
  );
}

export default function UsuariosPage() {
  const [criando, setCriando]   = useState(false);
  const [editando, setEditando] = useState<Usuario | null>(null);

  const usuarios   = trpc.auth.listUsuarios.useQuery();
  const projetos   = trpc.ia.listProjetos.useQuery();
  const criar      = trpc.auth.createUsuario.useMutation({ onSuccess: () => { usuarios.refetch(); setCriando(false); } });
  const atualizar  = trpc.auth.updateUsuario.useMutation({ onSuccess: () => { usuarios.refetch(); setEditando(null); } });

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Usuários</h1>
          <p className="text-gray-500 text-sm mt-1">Gerencie quem acessa o sistema e como cada um aparece no WhatsApp</p>
        </div>
        {!criando && !editando && (
          <button onClick={() => setCriando(true)} className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700">
            + Novo usuário
          </button>
        )}
      </div>

      {criando && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Novo usuário</h3>
          <UserForm
            onSave={(d) => criar.mutate({ nome: d.nome, email: d.email, senha: d.senha! })}
            onCancel={() => setCriando(false)}
            isLoading={criar.isLoading}
          />
        </div>
      )}

      <div className="space-y-4">
        {usuarios.isLoading && <p className="text-sm text-gray-400 py-8 text-center">Carregando...</p>}
        {(usuarios.data as unknown as Usuario[] | undefined)?.map((u) => (
          <div key={u.id} className="bg-white border rounded-xl p-5">
            {editando?.id === u.id ? (
              <UserForm
                inicial={u}
                onSave={(d) => atualizar.mutate({ id: u.id, ...d })}
                onCancel={() => setEditando(null)}
                isLoading={atualizar.isLoading}
              />
            ) : (
              <>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold flex-shrink-0">
                      {u.nome[0].toUpperCase()}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-gray-800">{u.nome}</p>
                        {!u.ativo && <span className="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full">Inativo</span>}
                      </div>
                      <p className="text-sm text-gray-500">{u.email}</p>
                    </div>
                  </div>
                  <button onClick={() => setEditando(u)} className="text-sm text-indigo-600 hover:underline flex-shrink-0">Editar</button>
                </div>

                {/* Project assignments */}
                {(projetos.data as { id: string; nome: string }[] | undefined)?.length ? (
                  <div className="mt-4 pt-4 border-t space-y-2">
                    <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Acesso por projeto</p>
                    {(projetos.data as { id: string; nome: string }[]).map((p) => (
                      <div key={p.id} className="flex items-start gap-3">
                        <span className="text-sm text-gray-600 w-40 flex-shrink-0">{p.nome}</span>
                        <ProjetoAssignment usuarioId={u.id} projetoId={p.id} nomeUsuario={u.nome} />
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </div>
        ))}
      </div>

      {/* Metrics section */}
      {(projetos.data as { id: string; nome: string }[] | undefined)?.map((p) => (
        <MetricasProjeto key={p.id} projetoId={p.id} nomeProjeto={p.nome} />
      ))}
    </div>
  );
}

function MetricasProjeto({ projetoId, nomeProjeto }: { projetoId: string; nomeProjeto: string }) {
  const metricas = trpc.ia.metricsUsuarios.useQuery({ projetoId });

  if (!metricas.data?.length) return null;

  return (
    <div className="mt-8 bg-white border rounded-xl p-5">
      <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4">
        Produtividade — {nomeProjeto} (últimos 30 dias)
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-gray-400 border-b">
              <th className="text-left py-2 pr-4">Usuário</th>
              <th className="text-left py-2 pr-4">Função</th>
              <th className="text-right py-2 pr-4">Msgs enviadas</th>
              <th className="text-right py-2 pr-4">Conversas assumidas</th>
              <th className="text-right py-2">Mudanças de stage</th>
            </tr>
          </thead>
          <tbody>
            {metricas.data.map((m) => (
              <tr key={m.usuarioId} className="border-b last:border-0 hover:bg-gray-50">
                <td className="py-2 pr-4 font-medium text-gray-800">{m.nome}</td>
                <td className="py-2 pr-4 text-gray-500">{FUNCAO_LABELS[m.funcao] ?? m.funcao}</td>
                <td className="py-2 pr-4 text-right tabular-nums font-medium">{m.mensagensEnviadas}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{m.conversasTomadas}</td>
                <td className="py-2 text-right tabular-nums">{m.mudancasStage}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
