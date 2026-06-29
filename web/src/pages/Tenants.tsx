import { useState } from "react";
import { Navigate } from "react-router-dom";
import { ChevronDown, ChevronRight, UserPlus, UserCheck, UserX } from "lucide-react";
import { trpc } from "../lib/trpc";
import { useAuth } from "../lib/usePermission";

type Tenant = {
  id: string;
  nome: string;
  cnpj: string;
  ativo: boolean;
  criadoEm: string;
  _count: { usuarios: number; emitentes: number };
};

type TenantUsuario = {
  id: string;
  nome: string;
  email: string;
  role: string;
  ativo: boolean;
  criadoEm: string;
};

function formatCnpj(cnpj: string) {
  const d = cnpj.replace(/\D/g, "");
  if (d.length !== 14) return cnpj;
  return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
}

function TenantForm({
  inicial,
  onSave,
  onCancel,
  isLoading,
}: {
  inicial?: Partial<Tenant>;
  onSave: (data: { nome: string; cnpj: string }) => void;
  onCancel: () => void;
  isLoading?: boolean;
}) {
  const [form, setForm] = useState({ nome: inicial?.nome ?? "", cnpj: inicial?.cnpj ?? "" });

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSave(form); }}
      className="border rounded-xl p-5 bg-gray-50 space-y-3"
    >
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Nome</label>
          <input value={form.nome} onChange={(e) => setForm(f => ({ ...f, nome: e.target.value }))}
            className="w-full border rounded-lg px-3 py-2 text-sm" required />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">CNPJ</label>
          <input value={form.cnpj} onChange={(e) => setForm(f => ({ ...f, cnpj: e.target.value }))}
            placeholder="00.000.000/0000-00" className="w-full border rounded-lg px-3 py-2 text-sm font-mono" required />
        </div>
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={isLoading}
          className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
          {isLoading ? "Salvando..." : "Salvar"}
        </button>
        <button type="button" onClick={onCancel} className="border px-4 py-2 rounded-lg text-sm text-gray-600 hover:bg-gray-50">
          Cancelar
        </button>
      </div>
    </form>
  );
}

function UsuarioForm({
  tenantId,
  onSave,
  onCancel,
  isLoading,
}: {
  tenantId: string;
  onSave: (data: { tenantId: string; nome: string; email: string; senha: string; role: "user" | "admin" }) => void;
  onCancel: () => void;
  isLoading?: boolean;
}) {
  const [form, setForm] = useState({ nome: "", email: "", senha: "", role: "admin" as "user" | "admin" });

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSave({ tenantId, ...form }); }}
      className="border border-indigo-100 rounded-xl p-4 bg-indigo-50 space-y-3 mt-3"
    >
      <p className="text-xs font-semibold text-indigo-700 uppercase tracking-wider">Novo usuário do tenant</p>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Nome</label>
          <input value={form.nome} onChange={(e) => setForm(f => ({ ...f, nome: e.target.value }))}
            className="w-full border rounded-lg px-3 py-2 text-sm bg-white" required />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">E-mail</label>
          <input type="email" value={form.email} onChange={(e) => setForm(f => ({ ...f, email: e.target.value }))}
            className="w-full border rounded-lg px-3 py-2 text-sm bg-white" required />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Senha</label>
          <input type="password" value={form.senha} onChange={(e) => setForm(f => ({ ...f, senha: e.target.value }))}
            minLength={6} placeholder="••••••" className="w-full border rounded-lg px-3 py-2 text-sm bg-white" required />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Perfil</label>
          <select value={form.role} onChange={(e) => setForm(f => ({ ...f, role: e.target.value as "user" | "admin" }))}
            className="w-full border rounded-lg px-3 py-2 text-sm bg-white">
            <option value="admin">Admin (cadastra emitentes e usuários)</option>
            <option value="user">Usuário comum</option>
          </select>
        </div>
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={isLoading}
          className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
          {isLoading ? "Criando..." : "Criar usuário"}
        </button>
        <button type="button" onClick={onCancel} className="border px-4 py-2 rounded-lg text-sm text-gray-600 hover:bg-gray-50 bg-white">
          Cancelar
        </button>
      </div>
    </form>
  );
}

function TenantUsuarios({ tenant }: { tenant: Tenant }) {
  const [criando, setCriando] = useState(false);

  const utils = trpc.useContext();
  const usuarios = trpc.tenant.listarUsuarios.useQuery({ tenantId: tenant.id });
  const criar = trpc.tenant.criarUsuario.useMutation({
    onSuccess: () => { utils.tenant.listarUsuarios.invalidate({ tenantId: tenant.id }); utils.tenant.listar.invalidate(); setCriando(false); },
    onError: (e) => alert(e.message),
  });
  const toggle = trpc.tenant.toggleUsuario.useMutation({
    onSuccess: () => { utils.tenant.listarUsuarios.invalidate({ tenantId: tenant.id }); },
  });

  const lista = usuarios.data as unknown as TenantUsuario[] | undefined;

  return (
    <div className="mt-4 pt-4 border-t">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
          Usuários ({lista?.length ?? "…"})
        </p>
        {!criando && (
          <button onClick={() => setCriando(true)}
            className="flex items-center gap-1.5 text-xs text-indigo-600 hover:text-indigo-800 font-medium">
            <UserPlus size={13} />
            Novo usuário
          </button>
        )}
      </div>

      {usuarios.isLoading && <p className="text-xs text-gray-400">Carregando...</p>}

      {lista && lista.length === 0 && !criando && (
        <p className="text-xs text-gray-400 italic">Nenhum usuário — crie o primeiro admin abaixo.</p>
      )}

      <div className="space-y-2">
        {lista?.map((u) => (
          <div key={u.id} className={`flex items-center justify-between rounded-lg px-3 py-2 ${u.ativo ? "bg-gray-50" : "bg-red-50"}`}>
            <div className="flex items-center gap-3">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${u.role === "admin" ? "bg-indigo-100 text-indigo-700" : "bg-gray-200 text-gray-600"}`}>
                {u.nome[0].toUpperCase()}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-800">{u.nome}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${u.role === "admin" ? "bg-indigo-100 text-indigo-700" : "bg-gray-200 text-gray-500"}`}>
                    {u.role === "admin" ? "Admin" : "Usuário"}
                  </span>
                  {!u.ativo && <span className="text-xs bg-red-100 text-red-500 px-1.5 py-0.5 rounded">Inativo</span>}
                </div>
                <p className="text-xs text-gray-400">{u.email}</p>
              </div>
            </div>
            <button
              onClick={() => toggle.mutate({ id: u.id, ativo: !u.ativo })}
              className={`flex items-center gap-1 text-xs ${u.ativo ? "text-red-400 hover:text-red-600" : "text-green-500 hover:text-green-700"}`}
              title={u.ativo ? "Desativar" : "Ativar"}
            >
              {u.ativo ? <UserX size={13} /> : <UserCheck size={13} />}
              {u.ativo ? "Desativar" : "Ativar"}
            </button>
          </div>
        ))}
      </div>

      {criando && (
        <UsuarioForm
          tenantId={tenant.id}
          onSave={(d) => criar.mutate(d)}
          onCancel={() => setCriando(false)}
          isLoading={criar.isLoading}
        />
      )}
    </div>
  );
}

export default function TenantsPage() {
  const { user } = useAuth();
  const [criando, setCriando]   = useState(false);
  const [editando, setEditando] = useState<Tenant | null>(null);
  const [expandido, setExpandido] = useState<string | null>(null);

  const isGlobalAdmin = user?.role === "admin" && !user?.empresaId;
  if (user && !isGlobalAdmin) return <Navigate to="/crm" replace />;

  const utils    = trpc.useContext();
  const tenants  = trpc.tenant.listar.useQuery();
  const criar    = trpc.tenant.criar.useMutation({ onSuccess: () => { utils.tenant.listar.invalidate(); setCriando(false); } });
  const atualizar = trpc.tenant.atualizar.useMutation({ onSuccess: () => { utils.tenant.listar.invalidate(); setEditando(null); } });

  function toggleAtivo(t: Tenant) {
    if (!confirm(`${t.ativo ? "Desativar" : "Ativar"} o tenant "${t.nome}"?`)) return;
    atualizar.mutate({ id: t.id, ativo: !t.ativo });
  }

  function toggleExpandido(id: string) {
    setExpandido(prev => prev === id ? null : id);
  }

  const data = tenants.data as unknown as Tenant[] | undefined;

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Tenants</h1>
          <p className="text-gray-500 text-sm mt-1">Clientes SaaS — cada tenant tem seus próprios usuários e empresas emissoras</p>
        </div>
        {!criando && !editando && (
          <button onClick={() => setCriando(true)}
            className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700">
            + Novo tenant
          </button>
        )}
      </div>

      {criando && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Novo tenant</h3>
          <TenantForm onSave={(d) => criar.mutate(d)} onCancel={() => setCriando(false)} isLoading={criar.isLoading} />
        </div>
      )}

      <div className="space-y-3">
        {tenants.isLoading && <p className="text-sm text-gray-400 py-8 text-center">Carregando...</p>}
        {data?.map((t) => (
          <div key={t.id} className={`bg-white border rounded-xl p-5 ${!t.ativo ? "opacity-60" : ""}`}>
            {editando?.id === t.id ? (
              <TenantForm
                inicial={t}
                onSave={(d) => atualizar.mutate({ id: t.id, ...d })}
                onCancel={() => setEditando(null)}
                isLoading={atualizar.isLoading}
              />
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold flex-shrink-0 text-lg">
                      {t.nome[0].toUpperCase()}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-gray-800">{t.nome}</p>
                        {!t.ativo && <span className="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full">Inativo</span>}
                      </div>
                      <p className="text-xs text-gray-400 font-mono">{formatCnpj(t.cnpj)}</p>
                      <div className="flex gap-3 mt-1">
                        <span className="text-xs text-gray-500">{t._count.usuarios} usuário{t._count.usuarios !== 1 ? "s" : ""}</span>
                        <span className="text-xs text-gray-300">·</span>
                        <span className="text-xs text-gray-500">{t._count.emitentes} emitente{t._count.emitentes !== 1 ? "s" : ""}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <button
                      onClick={() => toggleExpandido(t.id)}
                      className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-indigo-600 font-medium"
                    >
                      {expandido === t.id ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                      Usuários
                    </button>
                    <button onClick={() => setEditando(t)} className="text-sm text-indigo-600 hover:underline">Editar</button>
                    <button onClick={() => toggleAtivo(t)} className={`text-sm hover:underline ${t.ativo ? "text-red-500" : "text-green-600"}`}>
                      {t.ativo ? "Desativar" : "Ativar"}
                    </button>
                  </div>
                </div>

                {expandido === t.id && <TenantUsuarios tenant={t} />}
              </>
            )}
          </div>
        ))}
        {data?.length === 0 && (
          <p className="text-sm text-gray-400 py-8 text-center">Nenhum tenant cadastrado</p>
        )}
      </div>
    </div>
  );
}
