import { useState } from "react";
import { trpc } from "../lib/trpc";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDoc(v: string) {
  const d = v.replace(/\D/g, "");
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
}

function isPJ(cpfCnpj: string) {
  return cpfCnpj.replace(/\D/g, "").length > 11;
}

const ESTADOS_CIVIS = [
  { value: "solteiro",      label: "Solteiro(a)" },
  { value: "casada",        label: "Casado(a)" },
  { value: "divorciado",    label: "Divorciado(a)" },
  { value: "viuvo",         label: "Viúvo(a)" },
  { value: "uniao_estavel", label: "União Estável" },
];

const CARGOS_ADM = ["Administrador", "Sócio-Administrador", "Diretor", "Presidente", "Vice-Presidente", "Procurador"];

// ── Tipos ─────────────────────────────────────────────────────────────────────

type AdminForm = {
  id?: string;
  nome: string; cpf: string; cargo: string;
  nacionalidade: string; estadoCivil: string; regimeCasamento: string; profissao: string;
  rg: string; rgOrgaoEmissor: string; dataNascimento: string; naturalidade: string;
  endereco: string; numero: string; complemento: string;
  bairro: string; cidade: string; uf: string; cep: string;
};

function emptyAdmin(): AdminForm {
  return {
    nome: "", cpf: "", cargo: "Administrador",
    nacionalidade: "Brasileiro(a)", estadoCivil: "", regimeCasamento: "", profissao: "",
    rg: "", rgOrgaoEmissor: "", dataNascimento: "", naturalidade: "",
    endereco: "", numero: "", complemento: "",
    bairro: "", cidade: "Vitória da Conquista", uf: "BA", cep: "",
  };
}

const TIPOS_SOCIETARIOS = [
  "LTDA", "S.A.", "MEI", "Empresário Individual", "EIRELI",
  "Sociedade Simples", "Sociedade em Nome Coletivo", "Associação", "Fundação", "Cooperativa",
];

const REGIMES_CASAMENTO = [
  { value: "comunhao_parcial",    label: "Comunhão Parcial de Bens" },
  { value: "comunhao_universal",  label: "Comunhão Universal de Bens" },
  { value: "separacao_bens",      label: "Separação Total de Bens" },
  { value: "part_final_aquestos", label: "Participação Final nos Aquestos" },
];


type TomadorForm = {
  id?: string;
  tipo: "PF" | "PJ";
  empresaId: string;
  nome: string; nomeFantasia: string; cpfCnpj: string;
  email: string; emailFinanceiro: string; emailGeral: string; emailDiretoria: string; telefone: string;
  inscricaoEstadual: string; inscMunicipal: string;
  issRetido: boolean;
  // Endereço
  endereco: string; numero: string; complemento: string;
  bairro: string; cidade: string; codigoMunicipio: string; uf: string; cep: string;
  // PF
  dataNascimento: string; nacionalidade: string; estadoCivil: string;
  regimeCasamento: string;
  profissao: string; rg: string; rgOrgaoEmissor: string; naturalidade: string;
  // PJ
  tipoSocietario: string;
};

function emptyForm(): TomadorForm {
  return {
    tipo: "PF",
    empresaId: "",
    nome: "", nomeFantasia: "", cpfCnpj: "",
    email: "", emailFinanceiro: "", emailGeral: "", emailDiretoria: "", telefone: "",
    inscricaoEstadual: "", inscMunicipal: "", issRetido: false,
    endereco: "", numero: "", complemento: "",
    bairro: "", cidade: "Vitória da Conquista", codigoMunicipio: "2933307", uf: "BA", cep: "",
    dataNascimento: "", nacionalidade: "Brasileiro(a)", estadoCivil: "", regimeCasamento: "",
    profissao: "", rg: "", rgOrgaoEmissor: "", naturalidade: "",
    tipoSocietario: "",
  };
}

// ── Componente de campo ────────────────────────────────────────────────────────

function Field({ label, children, col2 = false }: { label: string; children: React.ReactNode; col2?: boolean }) {
  return (
    <div className={col2 ? "col-span-2" : ""}>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      {children}
    </div>
  );
}

const inp = "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-400 focus:outline-none";
const sel = inp + " bg-white";

// ── Formulário de Administrador ───────────────────────────────────────────────

function AdminModal({
  admin, tomadorId, onClose,
  onSave, onDelete,
}: {
  admin: AdminForm | null;
  tomadorId: string;
  onClose: () => void;
  onSave: (a: AdminForm) => void;
  onDelete?: (id: string) => void;
}) {
  const [f, setF] = useState<AdminForm>(admin ?? emptyAdmin());
  const s = (k: keyof AdminForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF(p => ({ ...p, [k]: e.target.value }));

  return (
    <div className="fixed inset-0 bg-black/60 z-[60] flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl my-6">
        <div className="px-6 py-4 border-b flex items-center justify-between">
          <h3 className="font-semibold text-gray-900">{f.id ? "Editar Administrador" : "Novo Administrador"}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">×</button>
        </div>
        <div className="px-6 py-5 grid grid-cols-2 gap-3 max-h-[75vh] overflow-y-auto">
          <Field label="Nome completo *" col2>
            <input value={f.nome} onChange={s("nome")} className={inp} placeholder="Nome do administrador" />
          </Field>
          <Field label="CPF">
            <input value={f.cpf} onChange={s("cpf")} className={inp} placeholder="000.000.000-00" />
          </Field>
          <Field label="Cargo / Qualidade">
            <select value={f.cargo} onChange={s("cargo")} className={sel}>
              {CARGOS_ADM.map(c => <option key={c} value={c}>{c}</option>)}
              <option value="outro">Outro</option>
            </select>
          </Field>
          <Field label="Nacionalidade">
            <input value={f.nacionalidade} onChange={s("nacionalidade")} className={inp} />
          </Field>
          <Field label="Estado Civil">
            <select value={f.estadoCivil} onChange={s("estadoCivil")} className={sel}>
              <option value="">Selecione...</option>
              {ESTADOS_CIVIS.map(e => <option key={e.value} value={e.value}>{e.label}</option>)}
            </select>
          </Field>
          {(f.estadoCivil === "casada" || f.estadoCivil === "uniao_estavel") && (
            <Field label="Regime de Bens">
              <select value={f.regimeCasamento} onChange={s("regimeCasamento")} className={sel}>
                <option value="">Selecione...</option>
                {REGIMES_CASAMENTO.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </Field>
          )}
          <Field label="Profissão">
            <input value={f.profissao} onChange={s("profissao")} className={inp} />
          </Field>
          <Field label="RG">
            <input value={f.rg} onChange={s("rg")} className={inp} placeholder="Nº do documento" />
          </Field>
          <Field label="Órgão Emissor / UF">
            <input value={f.rgOrgaoEmissor} onChange={s("rgOrgaoEmissor")} className={inp} placeholder="SSP/BA" />
          </Field>
          <Field label="Data de Nascimento">
            <input type="date" value={f.dataNascimento} onChange={s("dataNascimento")} className={inp} />
          </Field>
          <Field label="Naturalidade (cidade/UF)">
            <input value={f.naturalidade} onChange={s("naturalidade")} className={inp} placeholder="Salvador/BA" />
          </Field>

          <div className="col-span-2 border-t pt-3 mt-1">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Endereço do Administrador</p>
          </div>
          <Field label="Logradouro" col2>
            <input value={f.endereco} onChange={s("endereco")} className={inp} />
          </Field>
          <Field label="Número">
            <input value={f.numero} onChange={s("numero")} className={inp} />
          </Field>
          <Field label="Complemento">
            <input value={f.complemento} onChange={s("complemento")} className={inp} />
          </Field>
          <Field label="Bairro">
            <input value={f.bairro} onChange={s("bairro")} className={inp} />
          </Field>
          <Field label="Cidade">
            <input value={f.cidade} onChange={s("cidade")} className={inp} />
          </Field>
          <Field label="UF">
            <input value={f.uf} onChange={s("uf")} className={inp} maxLength={2} />
          </Field>
          <Field label="CEP">
            <input value={f.cep} onChange={s("cep")} className={inp} />
          </Field>
        </div>
        <div className="px-6 py-4 border-t flex items-center justify-between bg-gray-50 rounded-b-xl">
          {f.id && onDelete ? (
            <button onClick={() => { if (confirm("Excluir administrador?")) onDelete(f.id!); }} className="text-xs text-red-600 border border-red-200 rounded-lg px-3 py-1.5 hover:bg-red-50">Excluir</button>
          ) : <span />}
          <div className="flex gap-2">
            <button onClick={onClose} className="text-sm px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-100">Cancelar</button>
            <button onClick={() => onSave(f)} disabled={!f.nome} className="text-sm bg-brand-600 text-white px-5 py-2 rounded-lg hover:bg-brand-700 disabled:opacity-50">Salvar</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Página principal ──────────────────────────────────────────────────────────

export default function Tomadores() {
  const utils = trpc.useUtils();
  const [busca, setBusca] = useState("");
  const { data: tomadores, isLoading } = trpc.tomador.listar.useQuery({ busca: busca || undefined });
  const { data: empresas } = trpc.empresa.listar.useQuery();

  const [form, setForm] = useState<TomadorForm | null>(null);
  const [tomadorId, setTomadorId] = useState<string | null>(null);
  const [admins, setAdmins] = useState<any[]>([]);
  const [adminModal, setAdminModal] = useState<AdminForm | null | "new">(null);
  const [erroSalvar, setErroSalvar] = useState<string | null>(null);
  const [buscandoCnpj, setBuscandoCnpj] = useState(false);
  const [buscaCnpjMsg, setBuscaCnpjMsg] = useState<string | null>(null);

  const criar    = trpc.tomador.criar.useMutation({ onSuccess: (t: any) => { utils.tomador.listar.invalidate(); setTomadorId(t.id); setErroSalvar(null); }, onError: (e) => setErroSalvar(e.message) });
  const atualizar = trpc.tomador.atualizar.useMutation({ onSuccess: () => { utils.tomador.listar.invalidate(); setErroSalvar(null); }, onError: (e) => setErroSalvar(e.message) });
  const excluir  = trpc.tomador.excluir.useMutation({ onSuccess: () => { utils.tomador.listar.invalidate(); fechar(); } });
  const criarAdm = trpc.tomador.criarAdministrador.useMutation({ onSuccess: (a: any) => { setAdmins(p => [...p, a]); setAdminModal(null); } });
  const atuAdm   = trpc.tomador.atualizarAdministrador.useMutation({ onSuccess: (a: any) => { setAdmins(p => p.map(x => x.id === a.id ? a : x)); setAdminModal(null); } });
  const delAdm   = trpc.tomador.excluirAdministrador.useMutation({ onSuccess: (_, { id }) => { setAdmins(p => p.filter(x => x.id !== id)); setAdminModal(null); } });

  function abrirNovo() {
    setForm(emptyForm());
    setTomadorId(null);
    setAdmins([]);
    setErroSalvar(null);
  }

  function abrirEditar(t: any) {
    const pj = isPJ(t.cpfCnpj ?? "");
    setForm({
      id: t.id,
      tipo: pj ? "PJ" : "PF",
      empresaId: t.empresaId ?? "emp_psa",
      nome: t.nome ?? "", nomeFantasia: t.nomeFantasia ?? "", cpfCnpj: t.cpfCnpj ?? "",
      email: t.email ?? "", emailFinanceiro: t.emailFinanceiro ?? "", emailGeral: t.emailGeral ?? "", emailDiretoria: t.emailDiretoria ?? "", telefone: t.telefone ?? "",
      inscricaoEstadual: t.inscricaoEstadual ?? "", inscMunicipal: t.inscMunicipal ?? "", issRetido: t.issRetido ?? false,
      endereco: t.endereco ?? "", numero: t.numero ?? "", complemento: t.complemento ?? "",
      bairro: t.bairro ?? "", cidade: t.cidade ?? "", codigoMunicipio: t.codigoMunicipio ?? "", uf: t.uf ?? "BA", cep: t.cep ?? "",
      dataNascimento: t.dataNascimento ? t.dataNascimento.slice(0, 10) : "",
      nacionalidade: t.nacionalidade ?? "Brasileiro(a)",
      estadoCivil: t.estadoCivil ?? "",
      regimeCasamento: t.regimeCasamento ?? "",
      profissao: t.profissao ?? "", rg: t.rg ?? "", rgOrgaoEmissor: t.rgOrgaoEmissor ?? "",
      naturalidade: t.naturalidade ?? "",
      tipoSocietario: t.tipoSocietario ?? "",
    });
    setTomadorId(t.id);
    setAdmins(t.administradores ?? []);
    setErroSalvar(null);
  }

  function fechar() {
    setForm(null);
    setTomadorId(null);
    setAdmins([]);
    setErroSalvar(null);
    setAdminModal(null);
  }

  function salvar() {
    if (!form) return;
    setErroSalvar(null);
    const doc = form.cpfCnpj.replace(/\D/g, "");
    const payload = {
      nome: form.nome, nomeFantasia: form.nomeFantasia || null,
      cpfCnpj: doc,
      email: form.email || null,
      emailFinanceiro: form.emailFinanceiro || null,
      emailGeral: form.emailGeral || null,
      emailDiretoria: form.emailDiretoria || null,
      telefone: form.telefone || null,
      inscricaoEstadual: form.inscricaoEstadual || null,
      issRetido: form.issRetido,
      endereco: form.endereco || null, numero: form.numero || null,
      complemento: form.complemento || null, bairro: form.bairro || null,
      cidade: form.cidade || null, codigoMunicipio: form.codigoMunicipio || null,
      uf: (form.uf || null) as any, cep: form.cep?.replace(/\D/g, "") || null,
      inscMunicipal: form.inscMunicipal || null,
      // PF
      dataNascimento: form.dataNascimento || null,
      nacionalidade: form.nacionalidade || null,
      estadoCivil: (form.estadoCivil || null) as any,
      profissao: form.profissao || null,
      rg: form.rg || null, rgOrgaoEmissor: form.rgOrgaoEmissor || null,
      naturalidade: form.naturalidade || null,
      // PJ
      tipoSocietario: form.tipoSocietario || null,
      // PF adicional
      regimeCasamento: form.regimeCasamento || null,
      // Emitente
      empresaId: form.empresaId || null,
    };
    if (form.id) atualizar.mutate({ id: form.id, ...payload });
    else criar.mutate(payload);
  }

  function salvarAdmin(a: AdminForm) {
    const cpf = a.cpf.replace(/\D/g, "") || null;
    const payload = {
      ...a,
      cpf: cpf as any,
      estadoCivil: (a.estadoCivil || null) as any,
      regimeCasamento: a.regimeCasamento || null,
      cep: a.cep.replace(/\D/g, "") || null,
      dataNascimento: a.dataNascimento || null,
    };
    if (a.id) atuAdm.mutate({ id: a.id, ...payload });
    else criarAdm.mutate({ tomadorId: tomadorId!, ...payload });
  }

  const s = (k: keyof TomadorForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(f => f ? { ...f, [k]: e.target.value } : f);

  async function buscarCnpj() {
    if (!form) return;
    const cnpj = form.cpfCnpj.replace(/\D/g, "");
    if (cnpj.length !== 14) { setBuscaCnpjMsg("Digite o CNPJ completo (14 dígitos)"); return; }
    setBuscandoCnpj(true);
    setBuscaCnpjMsg(null);
    try {
      const r = await fetch(`/api/cnpj-lookup/${cnpj}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("avoce_token")}` },
      });
      const d = await r.json();
      if (!r.ok) { setBuscaCnpjMsg(`❌ ${d.error ?? "CNPJ não encontrado"}`); return; }
      setForm(f => f ? {
        ...f,
        nome:          d.nome          || f.nome,
        nomeFantasia:  d.nomeFantasia  || f.nomeFantasia,
        tipoSocietario: d.tipoSocietario || f.tipoSocietario,
        endereco:      d.endereco      || f.endereco,
        numero:        d.numero        || f.numero,
        complemento:   d.complemento   || f.complemento,
        bairro:        d.bairro        || f.bairro,
        cidade:        d.cidade        || f.cidade,
        uf:            d.uf            || f.uf,
        cep:           d.cep           || f.cep,
        email:         d.email         || f.email,
        telefone:      d.telefone      || f.telefone,
      } : f);
      const socios = d.socios ?? [];
      if (socios.length > 0 && tomadorId) {
        setBuscaCnpjMsg(`✅ Dados preenchidos! ${socios.length} sócio(s) encontrado(s) — adicione como Representante Legal manualmente.`);
      } else {
        setBuscaCnpjMsg("✅ Dados preenchidos com sucesso!");
      }
    } catch {
      setBuscaCnpjMsg("❌ Erro ao consultar CNPJ");
    } finally {
      setBuscandoCnpj(false);
    }
  }

  const tipoCadastro = form?.tipo ?? "PF";

  if (isLoading) return <div className="p-8 text-gray-500">Carregando...</div>;

  return (
    <div className="p-4 md:p-8">
      <div className="flex items-center justify-between mb-6 gap-3">
        <h1 className="text-2xl font-bold text-gray-900">Clientes / Tomadores</h1>
        <button onClick={abrirNovo} className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded-lg text-sm font-medium">
          + Novo Cliente
        </button>
      </div>

      <input value={busca} onChange={e => setBusca(e.target.value)}
        placeholder="Buscar por nome ou CPF/CNPJ..."
        className="w-full max-w-sm border border-gray-300 rounded-lg px-3 py-2 text-sm mb-4" />

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-gray-700">Nome</th>
              <th className="text-left px-4 py-3 font-medium text-gray-700">Tipo</th>
              <th className="text-left px-4 py-3 font-medium text-gray-700">CPF/CNPJ</th>
              <th className="text-left px-4 py-3 font-medium text-gray-700">Cidade</th>
              <th className="text-left px-4 py-3 font-medium text-gray-700">E-mail</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {tomadores?.map((t) => (
              <tr key={t.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium">{t.nome}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded font-medium ${isPJ(t.cpfCnpj) ? "bg-blue-100 text-blue-700" : "bg-green-100 text-green-700"}`}>
                    {isPJ(t.cpfCnpj) ? "PJ" : "PF"}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500 font-mono text-xs">{formatDoc(t.cpfCnpj)}</td>
                <td className="px-4 py-3 text-gray-500">{t.cidade ?? "—"}</td>
                <td className="px-4 py-3 text-gray-500">{t.email ?? "—"}</td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => {
                    // Carregar dados completos (com administradores) antes de editar
                    fetch(`/trpc/tomador.obter?input=${encodeURIComponent(JSON.stringify({ json: { id: t.id } }))}`, {
                      headers: { Authorization: `Bearer ${localStorage.getItem("avoce_token")}` }
                    }).then(r => r.json()).then(d => {
                      abrirEditar({ ...t, ...(d?.result?.data?.json ?? d?.result?.data ?? {}) });
                    }).catch(() => abrirEditar(t));
                  }} className="text-xs text-blue-600 hover:text-blue-800 mr-3">Editar</button>
                  <button onClick={() => { if (confirm("Excluir cliente?")) excluir.mutate({ id: t.id }); }}
                    className="text-xs text-red-600 hover:text-red-800">Excluir</button>
                </td>
              </tr>
            ))}
            {!tomadores?.length && (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-400">Nenhum cliente encontrado.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── Modal principal ────────────────────────────────────────────────────── */}
      {form && (
        <div className="fixed inset-0 bg-black/50 flex items-start justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl my-4">
            <div className="px-6 py-4 border-b flex items-center justify-between">
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-bold text-gray-900">{form.id ? "Editar Cliente" : "Novo Cliente"}</h2>
                {form.cpfCnpj && (
                  <span className={`text-xs px-2 py-0.5 rounded font-medium ${tipoCadastro === "PJ" ? "bg-blue-100 text-blue-700" : "bg-green-100 text-green-700"}`}>
                    {tipoCadastro === "PJ" ? "Pessoa Jurídica" : "Pessoa Física"}
                  </span>
                )}
              </div>
              <button onClick={fechar} className="text-gray-400 hover:text-gray-600 text-2xl font-bold leading-none">×</button>
            </div>

            <div className="px-6 py-5 space-y-5 max-h-[80vh] overflow-y-auto">

              {/* ── Emitente ──────────────────────────────────────────────── */}
              <section>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Escritório / Emitente</h3>
                <select value={form.empresaId} onChange={s("empresaId")} className={sel + " max-w-xs"}>
                  <option value="">Selecione o emitente...</option>
                  {(empresas ?? []).map(e => <option key={e.id} value={e.id}>{e.nome}</option>)}
                </select>
              </section>

              {/* ── Tipo de pessoa ────────────────────────────────────────── */}
              <section>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Tipo de Cadastro</h3>
                <div className="flex gap-3">
                  {(["PF", "PJ"] as const).map(t => (
                    <label key={t} className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border-2 cursor-pointer transition-colors text-sm font-medium ${
                      tipoCadastro === t
                        ? t === "PF" ? "border-green-500 bg-green-50 text-green-800" : "border-blue-500 bg-blue-50 text-blue-800"
                        : "border-gray-200 text-gray-500 hover:border-gray-300"
                    }`}>
                      <input type="radio" name="tipo" value={t} checked={tipoCadastro === t}
                        onChange={() => setForm(f => f ? { ...f, tipo: t } : f)} className="sr-only" />
                      {t === "PF" ? "👤 Pessoa Física" : "🏢 Pessoa Jurídica"}
                    </label>
                  ))}
                </div>
              </section>

              {/* ── Identificação ─────────────────────────────────────────── */}
              <section>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Identificação</h3>
                <div className="grid grid-cols-2 gap-3">
                  <Field label={tipoCadastro === "PJ" ? "Razão Social *" : "Nome completo *"} col2>
                    <input value={form.nome} onChange={s("nome")} className={inp} />
                  </Field>
                  <Field label={tipoCadastro === "PJ" ? "Nome Fantasia" : "Apelido"}>
                    <input value={form.nomeFantasia} onChange={s("nomeFantasia")} className={inp} />
                  </Field>
                  <Field label={tipoCadastro === "PJ" ? "CNPJ *" : "CPF *"}>
                    <div className="flex gap-2">
                      <input value={form.cpfCnpj} onChange={s("cpfCnpj")} className={inp}
                        placeholder={tipoCadastro === "PJ" ? "00.000.000/0001-00" : "000.000.000-00"} />
                      {tipoCadastro === "PJ" && (
                        <button type="button" onClick={buscarCnpj} disabled={buscandoCnpj}
                          className="whitespace-nowrap px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs rounded-lg font-medium">
                          {buscandoCnpj ? "..." : "🔍 Buscar"}
                        </button>
                      )}
                    </div>
                    {buscaCnpjMsg && (
                      <p className={`text-xs mt-1 ${buscaCnpjMsg.startsWith("✅") ? "text-green-700" : "text-red-600"}`}>
                        {buscaCnpjMsg}
                      </p>
                    )}
                  </Field>
                  <Field label="E-mail Principal">
                    <input type="email" value={form.email} onChange={s("email")} className={inp} placeholder="e-mail principal" />
                  </Field>
                  <Field label="E-mail Financeiro">
                    <input type="email" value={form.emailFinanceiro} onChange={s("emailFinanceiro")} className={inp} placeholder="cobranças, boletos, NFS-e" />
                  </Field>
                  <Field label="E-mail Geral">
                    <input type="email" value={form.emailGeral} onChange={s("emailGeral")} className={inp} placeholder="contato geral" />
                  </Field>
                  <Field label="E-mail Diretoria">
                    <input type="email" value={form.emailDiretoria} onChange={s("emailDiretoria")} className={inp} placeholder="diretoria / sócios" />
                  </Field>
                  <Field label="Telefone / WhatsApp">
                    <input value={form.telefone} onChange={s("telefone")} className={inp} />
                  </Field>
                  <Field label="Inscrição Municipal">
                    <input value={form.inscMunicipal} onChange={s("inscMunicipal")} className={inp} />
                  </Field>
                  <Field label="ISS" col2>
                    <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none mt-1">
                      <input
                        type="checkbox"
                        checked={form.issRetido}
                        onChange={e => setForm(f => f ? { ...f, issRetido: e.target.checked } : f)}
                        className="w-4 h-4 accent-brand-500"
                      />
                      Substituto tributário — ISS Retido na fonte
                    </label>
                  </Field>
                  {tipoCadastro === "PJ" && (
                    <Field label="Inscrição Estadual">
                      <input value={form.inscricaoEstadual} onChange={s("inscricaoEstadual")} className={inp} />
                    </Field>
                  )}
                </div>
              </section>

              {/* ── Dados Pessoa Física ───────────────────────────────────── */}
              {tipoCadastro === "PF" && (
                <section className="border border-green-100 rounded-xl bg-green-50/30 p-4">
                  <h3 className="text-xs font-semibold text-green-800 uppercase tracking-wide mb-3">Qualificação — Pessoa Física</h3>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Profissão">
                      <input value={form.profissao} onChange={s("profissao")} className={inp} placeholder="Ex: empresário, advogado..." />
                    </Field>
                    <Field label="Nacionalidade">
                      <input value={form.nacionalidade} onChange={s("nacionalidade")} className={inp} placeholder="Brasileiro(a)" />
                    </Field>
                    <Field label="Estado Civil">
                      <select value={form.estadoCivil} onChange={s("estadoCivil")} className={sel}>
                        <option value="">Selecione...</option>
                        {ESTADOS_CIVIS.map(e => <option key={e.value} value={e.value}>{e.label}</option>)}
                      </select>
                    </Field>
                    {(form.estadoCivil === "casada" || form.estadoCivil === "uniao_estavel") && (
                      <Field label="Regime de Bens">
                        <select value={form.regimeCasamento} onChange={s("regimeCasamento")} className={sel}>
                          <option value="">Selecione...</option>
                          {REGIMES_CASAMENTO.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                        </select>
                      </Field>
                    )}
                    <Field label="Data de Nascimento">
                      <input type="date" value={form.dataNascimento} onChange={s("dataNascimento")} className={inp} />
                    </Field>
                    <Field label="Naturalidade (cidade/UF)">
                      <input value={form.naturalidade} onChange={s("naturalidade")} className={inp} placeholder="Salvador/BA" />
                    </Field>
                    <Field label="RG / Doc. Identidade">
                      <input value={form.rg} onChange={s("rg")} className={inp} placeholder="Nº do documento" />
                    </Field>
                    <Field label="Órgão Emissor / UF">
                      <input value={form.rgOrgaoEmissor} onChange={s("rgOrgaoEmissor")} className={inp} placeholder="SSP/BA" />
                    </Field>
                  </div>
                </section>
              )}


              {/* ── Endereço ──────────────────────────────────────────────── */}
              <section>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Endereço</h3>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Logradouro" col2>
                    <input value={form.endereco} onChange={s("endereco")} className={inp} />
                  </Field>
                  <Field label="Número">
                    <input value={form.numero} onChange={s("numero")} className={inp} />
                  </Field>
                  <Field label="Complemento">
                    <input value={form.complemento} onChange={s("complemento")} className={inp} />
                  </Field>
                  <Field label="Bairro">
                    <input value={form.bairro} onChange={s("bairro")} className={inp} />
                  </Field>
                  <Field label="Cidade">
                    <input value={form.cidade} onChange={s("cidade")} className={inp} />
                  </Field>
                  <Field label="UF">
                    <input value={form.uf} onChange={s("uf")} className={inp} maxLength={2} />
                  </Field>
                  <Field label="CEP">
                    <input value={form.cep} onChange={s("cep")} className={inp} />
                  </Field>
                  <Field label="Cód. IBGE">
                    <input value={form.codigoMunicipio} onChange={s("codigoMunicipio")} className={inp} />
                  </Field>
                </div>
              </section>

              {/* ── Administradores (PJ) ──────────────────────────────────── */}
              {tipoCadastro === "PJ" && (
                <section className="border border-gray-200 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
                      Representante(s) Legal / Sócios-Administradores
                    </h3>
                    <button
                      onClick={() => {
                        if (!tomadorId) { alert("Salve o cadastro primeiro para adicionar administradores."); return; }
                        setAdminModal("new");
                      }}
                      className="text-xs bg-gray-900 text-white px-3 py-1.5 rounded-lg hover:bg-gray-700"
                    >
                      + Adicionar
                    </button>
                  </div>
                  {!tomadorId && (
                    <p className="text-xs text-gray-400 italic">Salve o cadastro primeiro para gerenciar os administradores.</p>
                  )}
                  {tomadorId && admins.length === 0 && (
                    <p className="text-xs text-gray-400">Nenhum administrador cadastrado.</p>
                  )}
                  <div className="space-y-2">
                    {admins.map((a: any) => (
                      <div key={a.id} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 border border-gray-100">
                        <div>
                          <p className="text-sm font-medium text-gray-900">{a.nome}</p>
                          <p className="text-xs text-gray-500">
                            {a.cargo}{a.cpf ? ` · CPF ${formatDoc(a.cpf)}` : ""}{a.estadoCivil ? ` · ${ESTADOS_CIVIS.find(e => e.value === a.estadoCivil)?.label ?? a.estadoCivil}` : ""}
                          </p>
                        </div>
                        <button
                          onClick={() => setAdminModal({
                            id: a.id, nome: a.nome ?? "", cpf: a.cpf ?? "", cargo: a.cargo ?? "Administrador",
                            nacionalidade: a.nacionalidade ?? "Brasileiro(a)", estadoCivil: a.estadoCivil ?? "",
                            regimeCasamento: a.regimeCasamento ?? "",
                            profissao: a.profissao ?? "", rg: a.rg ?? "", rgOrgaoEmissor: a.rgOrgaoEmissor ?? "",
                            dataNascimento: a.dataNascimento ? a.dataNascimento.slice(0, 10) : "",
                            naturalidade: a.naturalidade ?? "",
                            endereco: a.endereco ?? "", numero: a.numero ?? "", complemento: a.complemento ?? "",
                            bairro: a.bairro ?? "", cidade: a.cidade ?? "", uf: a.uf ?? "", cep: a.cep ?? "",
                          })}
                          className="text-xs text-blue-600 hover:text-blue-800"
                        >
                          Editar
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {erroSalvar && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                  {erroSalvar}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between px-6 py-4 border-t bg-gray-50 rounded-b-2xl">
              {form.id ? (
                <button onClick={() => { if (confirm("Excluir este cliente?")) excluir.mutate({ id: form.id! }); }}
                  className="text-xs text-red-600 border border-red-200 rounded-lg px-3 py-1.5 hover:bg-red-50">
                  Excluir cliente
                </button>
              ) : <span />}
              <div className="flex gap-2">
                <button onClick={fechar} className="text-sm px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-100">Cancelar</button>
                <button onClick={salvar} disabled={criar.isPending || atualizar.isPending}
                  className="bg-brand-600 hover:bg-brand-700 text-white text-sm px-5 py-2 rounded-lg disabled:opacity-50 font-medium">
                  {criar.isPending || atualizar.isPending ? "Salvando..." : form.id ? "Salvar alterações" : "Cadastrar cliente"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal de Administrador ─────────────────────────────────────────────── */}
      {adminModal && tomadorId && (
        <AdminModal
          admin={adminModal === "new" ? null : adminModal}
          tomadorId={tomadorId}
          onClose={() => setAdminModal(null)}
          onSave={salvarAdmin}
          onDelete={(id) => delAdm.mutate({ id })}
        />
      )}
    </div>
  );
}
