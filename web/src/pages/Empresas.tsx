import { useState, useRef } from "react";
import { trpc } from "../lib/trpc";

type Empresa = {
  id: string; nome: string; nomeFantasia: string | null; cnpj: string;
  inscricaoMunicipal: string; inscricaoEstadual: string | null;
  email: string | null; telefone: string | null;
  endereco: string | null; numero: string | null; complemento: string | null;
  bairro: string | null; cidade: string | null; codigoMunicipio: string | null;
  uf: string | null; cep: string | null;
  regime: string; aliquotaIss: number; itemListaServico: string; codTributacao: string;
  codigoServicoNacional: string | null; codigoNbs: string | null; regimeTributacao: string | null;
  certNome: string | null; certValidade: Date | null; certPass: string | null;
  logoPath: string | null; ativo: boolean;
  pixClientId: string | null; pixChave: string | null;
  boletoClientId: string | null; boletoNumeroCliente: string | null; boletoContaCorrente: string | null;
  boletoModalidade: string | null; boletoContratoCobranca: string | null;
  boletoMultaPercent: number | null; boletoJurosDiaPercent: number | null;
  smtpHost: string | null; smtpPort: number | null; smtpSecure: boolean;
  smtpUser: string | null; smtpPass: string | null; smtpFrom: string | null;
};

const REGIMES: Record<string, string> = { "1": "Simples Nacional", "2": "Lucro Presumido", "3": "Lucro Real" };

function formatCnpj(v: string) {
  return v.replace(/\D/g, "").replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
}

export default function Empresas() {
  const utils = trpc.useUtils();
  const { data: empresas, isLoading } = trpc.empresa.listar.useQuery();
  const [form, setForm] = useState<Partial<Empresa> | null>(null);
  const [formTab, setFormTab] = useState<"dados" | "cobranca" | "smtp">("dados");
  const [certUpload, setCertUpload] = useState<{ id: string; nome: string } | null>(null);
  const [certSenha, setCertSenha] = useState("");
  const [certFile, setCertFile] = useState<File | null>(null);
  const [uploadMsg, setUploadMsg] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const [smtpTestMsg, setSmtpTestMsg]     = useState<{ ok: boolean; msg: string } | null>(null);
  const [senhaCertInput, setSenhaCertInput] = useState("");
  const [senhaCertMsg, setSenhaCertMsg]     = useState<{ ok: boolean; msg: string } | null>(null);
  const [logoFile, setLogoFile]             = useState<File | null>(null);
  const [logoMsg, setLogoMsg]               = useState<{ ok: boolean; msg: string } | null>(null);
  const [logoUploading, setLogoUploading]   = useState(false);
  const logoRef = useRef<HTMLInputElement>(null);
  const [timbradoFile, setTimbradoFile]         = useState<File | null>(null);
  const [timbradoMsg, setTimbradoMsg]           = useState<{ ok: boolean; msg: string } | null>(null);
  const [timbradoUploading, setTimbradoUploading] = useState(false);
  const timbradoRef = useRef<HTMLInputElement>(null);
  const [buscandoCnpj, setBuscandoCnpj] = useState(false);
  const [buscaCnpjMsg, setBuscaCnpjMsg] = useState<string | null>(null);

  const criar           = trpc.empresa.criar.useMutation({ onSuccess: () => { utils.empresa.listar.invalidate(); setForm(null); } });
  const atualizar       = trpc.empresa.atualizar.useMutation({ onSuccess: () => { utils.empresa.listar.invalidate(); setForm(null); } });
  const excluir         = trpc.empresa.excluir.useMutation({ onSuccess: () => utils.empresa.listar.invalidate() });
  const salvarSenhaCert = trpc.empresa.salvarSenhaCert.useMutation({
    onSuccess: () => { setSenhaCertMsg({ ok: true,  msg: "✅ Senha salva e validada com sucesso" }); utils.empresa.listar.invalidate(); setSenhaCertInput(""); },
    onError:   (e) => setSenhaCertMsg({ ok: false, msg: `❌ ${e.message}` }),
  });
  const testarSmtp      = trpc.empresa.testarSmtp.useMutation({
    onSuccess: (r) => setSmtpTestMsg({ ok: true,  msg: `✅ E-mail de teste enviado para ${r.destinatario}` }),
    onError:   (e) => setSmtpTestMsg({ ok: false, msg: `❌ ${e.message}` }),
  });

  function abrirForm(emp?: Empresa) {
    setForm(emp ? { ...emp } : { regime: "2", aliquotaIss: 0.05, itemListaServico: "1.01", codTributacao: "0101", smtpPort: 587, smtpSecure: false });
    setFormTab("dados");
    setSmtpTestMsg(null);
    setSenhaCertMsg(null);
    setSenhaCertInput("");
    setLogoFile(null);
    setLogoMsg(null);
    setTimbradoFile(null);
    setTimbradoMsg(null);
  }

  async function uploadLogo() {
    if (!form?.id || !logoFile) return;
    setLogoUploading(true);
    setLogoMsg(null);
    const fd = new FormData();
    fd.append("logo", logoFile);
    try {
      const r = await fetch(`/api/logo/${form.id}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${localStorage.getItem("avoce_token")}` },
        body: fd,
      });
      const j = await r.json();
      if (j.ok) {
        setLogoMsg({ ok: true, msg: "✅ Logo salva com sucesso" });
        utils.empresa.listar.invalidate();
        setLogoFile(null);
        if (logoRef.current) logoRef.current.value = "";
      } else {
        setLogoMsg({ ok: false, msg: `❌ ${j.error}` });
      }
    } catch {
      setLogoMsg({ ok: false, msg: "❌ Erro ao enviar logo" });
    } finally {
      setLogoUploading(false);
    }
  }

  async function uploadTimbrado() {
    if (!form?.id || !timbradoFile) return;
    setTimbradoUploading(true);
    setTimbradoMsg(null);
    const fd = new FormData();
    fd.append("timbrado", timbradoFile);
    try {
      const r = await fetch(`/api/empresa/${form.id}/timbrado`, {
        method: "POST",
        headers: { Authorization: `Bearer ${localStorage.getItem("avoce_token")}` },
        body: fd,
      });
      const j = await r.json();
      if (j.ok) {
        setTimbradoMsg({ ok: true, msg: "✅ Timbrado salvo com sucesso" });
        utils.empresa.listar.invalidate();
        setTimbradoFile(null);
        if (timbradoRef.current) timbradoRef.current.value = "";
      } else {
        setTimbradoMsg({ ok: false, msg: `❌ ${j.error}` });
      }
    } catch {
      setTimbradoMsg({ ok: false, msg: "❌ Erro ao enviar timbrado" });
    } finally {
      setTimbradoUploading(false);
    }
  }

  function salvar() {
    if (!form) return;
    const campos = {
      nome: form.nome, nomeFantasia: form.nomeFantasia || null,
      inscricaoMunicipal: form.inscricaoMunicipal,
      inscricaoEstadual: form.inscricaoEstadual || null,
      email: form.email || null, telefone: form.telefone || null,
      endereco: form.endereco || null, numero: form.numero || null,
      complemento: form.complemento || null, bairro: form.bairro || null,
      cidade: form.cidade || null, codigoMunicipio: form.codigoMunicipio || null,
      uf: form.uf || null, cep: form.cep?.replace(/\D/g, "") || null,
      regime: form.regime as "1"|"2"|"3",
      aliquotaIss: form.aliquotaIss,
      itemListaServico: form.itemListaServico,
      codTributacao: form.codTributacao,
      codigoServicoNacional: form.codigoServicoNacional || null,
      codigoNbs:             form.codigoNbs             || null,
      regimeTributacao:      form.regimeTributacao      || null,
      smtpHost:   form.smtpHost  || null,
      smtpPort:   form.smtpPort  ?? null,
      smtpSecure: form.smtpSecure ?? false,
      smtpUser:   form.smtpUser  || null,
      smtpPass:   form.smtpPass  || null,
      smtpFrom:   form.smtpFrom  || null,
      // Cobrança
      pixClientId:            form.pixClientId            || null,
      pixChave:               form.pixChave               || null,
      boletoClientId:         form.boletoClientId         || null,
      boletoNumeroCliente:    form.boletoNumeroCliente     || null,
      boletoContaCorrente:    form.boletoContaCorrente     || null,
      boletoModalidade:       form.boletoModalidade        || null,
      boletoContratoCobranca: form.boletoContratoCobranca  || null,
      boletoMultaPercent:     form.boletoMultaPercent      ?? null,
      boletoJurosDiaPercent:  form.boletoJurosDiaPercent   ?? null,
    };
    if (form.id) {
      atualizar.mutate({ id: form.id, ...campos });
    } else {
      criar.mutate({ ...campos, nome: form.nome!, cnpj: form.cnpj!.replace(/\D/g, ""),
        inscricaoMunicipal: form.inscricaoMunicipal!,
        regime: (form.regime ?? "2") as "1"|"2"|"3",
        aliquotaIss: form.aliquotaIss ?? 0.05,
        itemListaServico: form.itemListaServico ?? "1.01",
        codTributacao: form.codTributacao ?? "0101" });
    }
  }

  async function uploadCert() {
    if (!certUpload || !certFile) return;
    setUploadMsg("Enviando...");
    const fd = new FormData();
    fd.append("cert", certFile);
    fd.append("senha", certSenha);
    try {
      const r = await fetch(`/api/cert/${certUpload.id}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${localStorage.getItem("avoce_token")}` },
        body: fd,
      });
      const j = await r.json();
      if (j.ok) {
        setUploadMsg(`✅ Certificado salvo: ${j.nome} — válido até ${new Date(j.validade).toLocaleDateString("pt-BR")}`);
        utils.empresa.listar.invalidate();
      } else {
        setUploadMsg(`❌ ${j.error}`);
      }
    } catch (e) {
      setUploadMsg(`❌ Erro ao enviar`);
    }
  }

  async function buscarCnpj() {
    const cnpj = form?.cnpj?.replace(/\D/g, "") ?? "";
    if (cnpj.length !== 14) { setBuscaCnpjMsg("CNPJ deve ter 14 dígitos"); return; }
    setBuscandoCnpj(true);
    setBuscaCnpjMsg(null);
    try {
      const r = await fetch(`/api/cnpj-lookup/${cnpj}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("avoce_token")}` },
      });
      if (!r.ok) { setBuscaCnpjMsg("CNPJ não encontrado"); return; }
      const d = await r.json();
      setForm(f => f ? {
        ...f,
        nome:      d.nome      || f.nome,
        nomeFantasia: d.nomeFantasia || f.nomeFantasia,
        email:     d.email     || f.email,
        telefone:  d.telefone  || f.telefone,
        endereco:  d.endereco  || f.endereco,
        numero:    d.numero    || f.numero,
        complemento: d.complemento || f.complemento,
        bairro:    d.bairro    || f.bairro,
        cidade:    d.cidade    || f.cidade,
        uf:        d.uf        || f.uf,
        cep:       d.cep       || f.cep,
      } : f);
      setBuscaCnpjMsg(`✅ Dados preenchidos: ${d.nome}`);
    } catch {
      setBuscaCnpjMsg("Erro ao consultar CNPJ");
    } finally {
      setBuscandoCnpj(false);
    }
  }

  if (isLoading) return <div className="p-8 text-gray-500">Carregando...</div>;

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Empresas Emitentes</h1>
        <button onClick={() => abrirForm()} className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded-lg text-sm font-medium">
          + Nova Empresa
        </button>
      </div>

      <div className="space-y-3">
        {empresas?.filter(e => e.ativo).map((emp) => (
          <div key={emp.id} className="bg-white border border-gray-200 rounded-xl p-5 flex items-start justify-between">
            <div>
              <p className="font-semibold text-gray-900">{emp.nome}</p>
              <p className="text-sm text-gray-500">{formatCnpj(emp.cnpj)} · IM: {emp.inscricaoMunicipal}</p>
              <p className="text-sm text-gray-500">{REGIMES[emp.regime]} · ISS {(emp.aliquotaIss * 100).toFixed(1)}%</p>
              {emp.certNome ? (
                <p className="text-xs text-green-600 mt-1">
                  🔐 {emp.certNome}{emp.certValidade ? ` · válido até ${new Date(emp.certValidade).toLocaleDateString("pt-BR")}` : ""}
                  {emp.certPass ? " · senha salva ✓" : " · ⚠️ senha não salva"}
                </p>
              ) : (
                <p className="text-xs text-amber-600 mt-1">⚠️ Sem certificado</p>
              )}
              {emp.logoPath && <p className="text-xs text-blue-600 mt-0.5">🖼️ Logo cadastrada</p>}
            </div>
            <div className="flex gap-2 flex-shrink-0">
              <button
                onClick={() => { setCertUpload({ id: emp.id, nome: emp.nome }); setCertSenha(""); setCertFile(null); setUploadMsg(""); }}
                className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-1.5 rounded-lg"
              >🔐 Certificado</button>
              <button onClick={() => abrirForm(emp as Empresa)} className="text-xs bg-blue-50 hover:bg-blue-100 text-blue-700 px-3 py-1.5 rounded-lg">Editar</button>
              <button onClick={() => { if (confirm("Desativar empresa?")) excluir.mutate({ id: emp.id }); }}
                className="text-xs bg-red-50 hover:bg-red-100 text-red-700 px-3 py-1.5 rounded-lg">Desativar</button>
            </div>
          </div>
        ))}
        {!empresas?.filter(e => e.ativo).length && (
          <p className="text-gray-500 text-sm">Nenhuma empresa cadastrada.</p>
        )}
      </div>

      {/* Modal Form */}
      {form && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-bold mb-3">{form.id ? "Editar Empresa" : "Nova Empresa"}</h2>

            {/* Abas */}
            <div className="flex gap-1 mb-4 border-b border-gray-200">
              {(["dados", "cobranca", "smtp"] as const).map(t => (
                <button key={t} onClick={() => setFormTab(t)}
                  className={`text-sm px-4 py-2 -mb-px border-b-2 transition-colors ${formTab === t ? "border-brand-600 text-brand-700 font-medium" : "border-transparent text-gray-500 hover:text-gray-700"}`}>
                  {t === "dados" ? "Dados Fiscais" : t === "cobranca" ? "PIX / Boleto" : "E-mail / SMTP"}
                </button>
              ))}
            </div>

            {formTab === "cobranca" && (
              <div className="space-y-5">
                <p className="text-xs text-gray-500">Configure as credenciais Sicoob desta empresa para emitir PIX e boletos. O certificado mTLS é o mesmo já cadastrado nos Dados Fiscais.</p>

                <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                  <p className="text-xs font-semibold text-blue-800 uppercase tracking-wide mb-3">PIX — Sicoob</p>
                  <div className="grid grid-cols-1 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Client ID PIX</label>
                      <input value={form.pixClientId ?? ""} onChange={e => setForm(f => ({ ...f, pixClientId: e.target.value }))}
                        placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" className="w-full border rounded-lg px-3 py-2 text-sm font-mono" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Chave PIX</label>
                      <input value={form.pixChave ?? ""} onChange={e => setForm(f => ({ ...f, pixChave: e.target.value }))}
                        placeholder="CNPJ, e-mail, telefone ou chave aleatória" className="w-full border rounded-lg px-3 py-2 text-sm" />
                    </div>
                  </div>
                </div>

                <div className="bg-green-50 border border-green-200 rounded-xl p-4">
                  <p className="text-xs font-semibold text-green-800 uppercase tracking-wide mb-3">Boleto — Sicoob Cobrança Bancária</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="col-span-2">
                      <label className="block text-xs font-medium text-gray-700 mb-1">Client ID Boleto</label>
                      <input value={form.boletoClientId ?? ""} onChange={e => setForm(f => ({ ...f, boletoClientId: e.target.value }))}
                        placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" className="w-full border rounded-lg px-3 py-2 text-sm font-mono" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Número do Cliente</label>
                      <input value={form.boletoNumeroCliente ?? ""} onChange={e => setForm(f => ({ ...f, boletoNumeroCliente: e.target.value }))}
                        placeholder="628530" className="w-full border rounded-lg px-3 py-2 text-sm" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Conta Corrente</label>
                      <input value={form.boletoContaCorrente ?? ""} onChange={e => setForm(f => ({ ...f, boletoContaCorrente: e.target.value }))}
                        placeholder="124257" className="w-full border rounded-lg px-3 py-2 text-sm" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Modalidade</label>
                      <input value={form.boletoModalidade ?? "1"} onChange={e => setForm(f => ({ ...f, boletoModalidade: e.target.value }))}
                        placeholder="1" className="w-full border rounded-lg px-3 py-2 text-sm" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Contrato de Cobrança</label>
                      <input value={form.boletoContratoCobranca ?? ""} onChange={e => setForm(f => ({ ...f, boletoContratoCobranca: e.target.value }))}
                        placeholder="0 (deixar 0 se não houver)" className="w-full border rounded-lg px-3 py-2 text-sm" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Multa após vencimento (%)</label>
                      <input type="number" step="0.1" min="0" value={form.boletoMultaPercent ?? 2}
                        onChange={e => setForm(f => ({ ...f, boletoMultaPercent: parseFloat(e.target.value) }))}
                        className="w-full border rounded-lg px-3 py-2 text-sm" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Juros mora por dia (%)</label>
                      <input type="number" step="0.001" min="0" value={form.boletoJurosDiaPercent ?? 0.033}
                        onChange={e => setForm(f => ({ ...f, boletoJurosDiaPercent: parseFloat(e.target.value) }))}
                        className="w-full border rounded-lg px-3 py-2 text-sm" />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {formTab === "smtp" && (
              <div className="space-y-3">
                <p className="text-xs text-gray-500 mb-3">Configure o servidor SMTP desta empresa para envio automático de NFS-e e cobranças.</p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2">
                    <label className="block text-xs font-medium text-gray-700 mb-1">Servidor SMTP (host)</label>
                    <input value={form.smtpHost ?? ""} onChange={e => setForm(f => ({ ...f, smtpHost: e.target.value }))}
                      placeholder="smtp.gmail.com" className="w-full border rounded-lg px-3 py-2 text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Porta</label>
                    <input type="number" value={form.smtpPort ?? 587} onChange={e => setForm(f => ({ ...f, smtpPort: parseInt(e.target.value) }))}
                      className="w-full border rounded-lg px-3 py-2 text-sm" />
                  </div>
                  <div className="flex items-center gap-2 pt-5">
                    <input type="checkbox" id="smtpSecure" checked={form.smtpSecure ?? false}
                      onChange={e => setForm(f => ({ ...f, smtpSecure: e.target.checked }))} />
                    <label htmlFor="smtpSecure" className="text-sm text-gray-700">TLS (porta 465)</label>
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs font-medium text-gray-700 mb-1">Usuário (e-mail)</label>
                    <input type="email" value={form.smtpUser ?? ""} onChange={e => setForm(f => ({ ...f, smtpUser: e.target.value }))}
                      placeholder="empresa@gmail.com" className="w-full border rounded-lg px-3 py-2 text-sm" />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs font-medium text-gray-700 mb-1">Senha (ou App Password)</label>
                    <input type="password" value={form.smtpPass ?? ""} onChange={e => setForm(f => ({ ...f, smtpPass: e.target.value }))}
                      placeholder="Senha de app do Gmail ou senha SMTP" className="w-full border rounded-lg px-3 py-2 text-sm" />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs font-medium text-gray-700 mb-1">Remetente (From)</label>
                    <input value={form.smtpFrom ?? ""} onChange={e => setForm(f => ({ ...f, smtpFrom: e.target.value }))}
                      placeholder="NFS-e Empresa <empresa@gmail.com>" className="w-full border rounded-lg px-3 py-2 text-sm" />
                  </div>
                </div>
                <p className="text-xs text-blue-600 mt-2">
                  💡 Gmail: ative "Senhas de app" em myaccount.google.com → Segurança → Verificação em 2 etapas → Senhas de app. Use a senha gerada aqui.
                </p>
                {form.id && (
                  <div className="mt-3 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => { setSmtpTestMsg(null); testarSmtp.mutate({ id: form.id! }); }}
                      disabled={testarSmtp.isPending || !form.smtpHost || !form.smtpUser}
                      className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm px-4 py-2 rounded-lg transition-colors"
                    >
                      {testarSmtp.isPending ? "Testando..." : "📧 Testar SMTP"}
                    </button>
                    {smtpTestMsg && (
                      <p className={`text-sm ${smtpTestMsg.ok ? "text-green-700" : "text-red-600"}`}>{smtpTestMsg.msg}</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {formTab === "dados" && <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-700 mb-1">Razão Social *</label>
                <input value={form.nome ?? ""} onChange={e => setForm(f => ({ ...f, nome: e.target.value }))}
                  className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-700 mb-1">Nome Fantasia</label>
                <input value={form.nomeFantasia ?? ""} onChange={e => setForm(f => ({ ...f, nomeFantasia: e.target.value }))}
                  className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              {!form.id && (
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-gray-700 mb-1">CNPJ *</label>
                  <div className="flex gap-2">
                    <input value={form.cnpj ?? ""} onChange={e => { setForm(f => ({ ...f, cnpj: e.target.value.replace(/\D/g, "") })); setBuscaCnpjMsg(null); }}
                      placeholder="00000000000000" className="flex-1 border rounded-lg px-3 py-2 text-sm" maxLength={14} />
                    <button type="button" onClick={buscarCnpj} disabled={buscandoCnpj}
                      className="whitespace-nowrap px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium">
                      {buscandoCnpj ? "..." : "🔍 Buscar"}
                    </button>
                  </div>
                  {buscaCnpjMsg && <p className={`text-xs mt-1 ${buscaCnpjMsg.startsWith("✅") ? "text-green-600" : "text-red-500"}`}>{buscaCnpjMsg}</p>}
                </div>
              )}
              {form.id && (
                <div className="col-span-2 flex items-center gap-2">
                  <span className="text-xs text-gray-500">CNPJ: {formatCnpj(form.cnpj ?? "")}</span>
                  <button type="button" onClick={buscarCnpj} disabled={buscandoCnpj}
                    className="px-2 py-1 text-xs bg-blue-50 hover:bg-blue-100 text-blue-700 rounded border border-blue-200 disabled:opacity-50">
                    {buscandoCnpj ? "..." : "🔍 Buscar dados por CNPJ"}
                  </button>
                  {buscaCnpjMsg && <span className={`text-xs ${buscaCnpjMsg.startsWith("✅") ? "text-green-600" : "text-red-500"}`}>{buscaCnpjMsg}</span>}
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Inscrição Municipal *</label>
                <input value={form.inscricaoMunicipal ?? ""} onChange={e => setForm(f => ({ ...f, inscricaoMunicipal: e.target.value }))}
                  className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Inscrição Estadual</label>
                <input value={form.inscricaoEstadual ?? ""} onChange={e => setForm(f => ({ ...f, inscricaoEstadual: e.target.value }))}
                  className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">E-mail</label>
                <input type="email" value={form.email ?? ""} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Telefone</label>
                <input value={form.telefone ?? ""} onChange={e => setForm(f => ({ ...f, telefone: e.target.value }))}
                  className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-700 mb-1">Endereço</label>
                <input value={form.endereco ?? ""} onChange={e => setForm(f => ({ ...f, endereco: e.target.value }))}
                  className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Número</label>
                <input value={form.numero ?? ""} onChange={e => setForm(f => ({ ...f, numero: e.target.value }))}
                  className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Complemento</label>
                <input value={form.complemento ?? ""} onChange={e => setForm(f => ({ ...f, complemento: e.target.value }))}
                  className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Bairro</label>
                <input value={form.bairro ?? ""} onChange={e => setForm(f => ({ ...f, bairro: e.target.value }))}
                  className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Cidade</label>
                <input value={form.cidade ?? ""} onChange={e => setForm(f => ({ ...f, cidade: e.target.value }))}
                  className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">UF</label>
                <input value={form.uf ?? ""} onChange={e => setForm(f => ({ ...f, uf: e.target.value }))}
                  maxLength={2} className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">CEP</label>
                <input value={form.cep ?? ""} onChange={e => setForm(f => ({ ...f, cep: e.target.value }))}
                  className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Regime</label>
                <select value={form.regime ?? "2"} onChange={e => setForm(f => ({ ...f, regime: e.target.value }))}
                  className="w-full border rounded-lg px-3 py-2 text-sm">
                  <option value="1">Simples Nacional</option>
                  <option value="2">Lucro Presumido</option>
                  <option value="3">Lucro Real</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Alíquota ISS (%)</label>
                <input type="number" step="0.1" min="0" max="10"
                  value={(form.aliquotaIss ?? 0.05) * 100}
                  onChange={e => setForm(f => ({ ...f, aliquotaIss: parseFloat(e.target.value) / 100 }))}
                  className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              {/* NFS-e service codes section */}
              <div className="col-span-2 mt-2">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3 border-t pt-3">Configuração NFS-e</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Item LC 116 <span className="text-gray-400">(com pontos, ex: 17.14)</span></label>
                    <input value={form.itemListaServico ?? ""} onChange={e => setForm(f => ({ ...f, itemListaServico: e.target.value }))}
                      placeholder="ex: 17.14" className="w-full border rounded-lg px-3 py-2 text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Cód. Tributação Municipal <span className="text-gray-400">(com pontos, ex: 17.14)</span></label>
                    <input value={form.codTributacao ?? ""} onChange={e => setForm(f => ({ ...f, codTributacao: e.target.value }))}
                      placeholder="ex: 17.14" className="w-full border rounded-lg px-3 py-2 text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Cód. Serviço Nacional <span className="text-gray-400">(somente números, 6 dígitos)</span>
                    </label>
                    <input
                      value={form.codigoServicoNacional ?? ""}
                      onChange={e => setForm(f => ({ ...f, codigoServicoNacional: e.target.value.replace(/\D/g, "").slice(0, 9) || null }))}
                      placeholder="ex: 171401"
                      maxLength={9}
                      className={`w-full border rounded-lg px-3 py-2 text-sm ${form.codigoServicoNacional && form.codigoServicoNacional.length < 4 ? "border-red-400" : ""}`}
                    />
                    {form.codigoServicoNacional && <p className="text-xs text-gray-400 mt-0.5">{(form.codigoServicoNacional as string).length} dígito(s)</p>}
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Cód. NBS <span className="text-gray-400">(somente números, sem pontos, 9 dígitos)</span>
                    </label>
                    <input
                      value={form.codigoNbs ?? ""}
                      onChange={e => setForm(f => ({ ...f, codigoNbs: e.target.value.replace(/\D/g, "").slice(0, 9) || null }))}
                      placeholder="ex: 113019000"
                      maxLength={9}
                      className={`w-full border rounded-lg px-3 py-2 text-sm ${form.codigoNbs && form.codigoNbs.length !== 9 ? "border-yellow-400" : ""}`}
                    />
                    {form.codigoNbs && <p className={`text-xs mt-0.5 ${form.codigoNbs.length === 9 ? "text-green-600" : "text-yellow-600"}`}>{(form.codigoNbs as string).length}/9 dígitos</p>}
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs font-medium text-gray-700 mb-1">Regime Especial de Tributação</label>
                    <select value={form.regimeTributacao ?? ""} onChange={e => setForm(f => ({ ...f, regimeTributacao: e.target.value || null }))}
                      className="w-full border rounded-lg px-3 py-2 text-sm">
                      <option value="">— Não informar —</option>
                      <option value="1">1 – Microempresa Municipal</option>
                      <option value="2">2 – Estimativa</option>
                      <option value="3">3 – Sociedade de Profissionais</option>
                      <option value="4">4 – Cooperativa</option>
                      <option value="5">5 – MEI</option>
                      <option value="6">6 – ME / EPP</option>
                      <option value="7">7 – Profissional Autônomo</option>
                      <option value="8">8 – Notário ou Registrador</option>
                      <option value="9">9 – Outros</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>}

            {/* Logo da empresa — só para empresas já cadastradas */}
            {formTab === "dados" && form.id && (
              <div className="mt-4 bg-gray-50 border border-gray-200 rounded-xl p-4">
                <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-2">🖼️ Logo da Empresa</p>
                <p className="text-xs text-gray-500 mb-3">Usada na Nota de Honorários. Formatos: PNG, JPG, SVG. Máx. 5 MB.</p>
                {(form as any).logoPath && (
                  <div className="mb-3 flex items-center gap-2">
                    <img
                      src={`/api/logo/${form.id}?t=${Date.now()}`}
                      alt="Logo atual"
                      className="h-10 object-contain border rounded"
                      onError={e => (e.currentTarget.style.display = "none")}
                    />
                    <span className="text-xs text-green-700">✅ Logo cadastrada</span>
                  </div>
                )}
                <div className="flex gap-2">
                  <input
                    ref={logoRef}
                    type="file"
                    accept="image/png,image/jpeg,image/svg+xml"
                    onChange={e => { setLogoFile(e.target.files?.[0] ?? null); setLogoMsg(null); }}
                    className="flex-1 text-sm"
                  />
                  <button
                    type="button"
                    onClick={uploadLogo}
                    disabled={!logoFile || logoUploading}
                    className="bg-gray-800 hover:bg-gray-900 disabled:opacity-40 text-white text-sm px-4 py-2 rounded-lg whitespace-nowrap"
                  >
                    {logoUploading ? "Enviando..." : "Salvar Logo"}
                  </button>
                </div>
                {logoMsg && (
                  <p className={`text-xs mt-2 ${logoMsg.ok ? "text-green-700" : "text-red-600"}`}>{logoMsg.msg}</p>
                )}
              </div>
            )}

            {/* Timbrado da empresa — só para empresas já cadastradas */}
            {formTab === "dados" && form.id && (
              <div className="mt-4 bg-gray-50 border border-gray-200 rounded-xl p-4">
                <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-2">📄 Timbrado da Empresa</p>
                <p className="text-xs text-gray-500 mb-3">Arquivo DOCX (ou imagem PNG/JPG) usado como base para gerar contratos e procurações com cabeçalho/rodapé da empresa.</p>
                {(form as any).timbradoPath && (
                  <p className="text-xs text-green-700 mb-2">✅ Timbrado configurado: {((form as any).timbradoPath as string).split("/").pop()}</p>
                )}
                <div className="flex gap-2">
                  <input
                    ref={timbradoRef}
                    type="file"
                    accept=".docx,.png,.jpg,.jpeg,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/png,image/jpeg"
                    onChange={e => { setTimbradoFile(e.target.files?.[0] ?? null); setTimbradoMsg(null); }}
                    className="flex-1 text-sm"
                  />
                  <button
                    type="button"
                    onClick={uploadTimbrado}
                    disabled={!timbradoFile || timbradoUploading}
                    className="bg-gray-800 hover:bg-gray-900 disabled:opacity-40 text-white text-sm px-4 py-2 rounded-lg whitespace-nowrap"
                  >
                    {timbradoUploading ? "Enviando..." : "Salvar Timbrado"}
                  </button>
                </div>
                {timbradoMsg && (
                  <p className={`text-xs mt-2 ${timbradoMsg.ok ? "text-green-700" : "text-red-600"}`}>{timbradoMsg.msg}</p>
                )}
              </div>
            )}

            {/* Senha do Certificado — só para empresas já cadastradas com cert */}
            {formTab === "dados" && form.id && form.certNome && (
              <div className="mt-4 bg-gray-50 border border-gray-200 rounded-xl p-4">
                <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-2">🔑 Senha do Certificado A1</p>
                {form.certPass ? (
                  <p className="text-xs text-green-700 mb-2">✅ Senha salva no banco. Para alterar, digite a nova senha abaixo.</p>
                ) : (
                  <p className="text-xs text-amber-600 mb-2">⚠️ Senha não salva. O sistema não conseguirá emitir NFS-e após reiniciar. Salve a senha abaixo.</p>
                )}
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={senhaCertInput}
                    onChange={e => { setSenhaCertInput(e.target.value); setSenhaCertMsg(null); }}
                    placeholder="Senha do arquivo .p12"
                    className="flex-1 border rounded-lg px-3 py-2 text-sm"
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    onClick={() => salvarSenhaCert.mutate({ id: form.id!, certPass: senhaCertInput })}
                    disabled={!senhaCertInput || salvarSenhaCert.isPending}
                    className="bg-gray-800 hover:bg-gray-900 disabled:opacity-40 text-white text-sm px-4 py-2 rounded-lg whitespace-nowrap"
                  >
                    {salvarSenhaCert.isPending ? "Salvando..." : "Salvar Senha"}
                  </button>
                </div>
                {senhaCertMsg && (
                  <p className={`text-xs mt-2 ${senhaCertMsg.ok ? "text-green-700" : "text-red-600"}`}>{senhaCertMsg.msg}</p>
                )}
              </div>
            )}

            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setForm(null)} className="text-sm text-gray-600 hover:text-gray-900 px-4 py-2">Cancelar</button>
              <button onClick={salvar} disabled={criar.isPending || atualizar.isPending}
                className="bg-brand-600 hover:bg-brand-700 text-white text-sm px-4 py-2 rounded-lg disabled:opacity-50">
                {criar.isPending || atualizar.isPending ? "Salvando..." : "Salvar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Certificado */}
      {certUpload && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm">
            <h2 className="text-lg font-bold mb-1">Upload de Certificado</h2>
            <p className="text-sm text-gray-500 mb-4">{certUpload.nome}</p>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Arquivo .p12 / .pfx</label>
                <input ref={fileRef} type="file" accept=".p12,.pfx" onChange={e => setCertFile(e.target.files?.[0] ?? null)}
                  className="w-full text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Senha do certificado</label>
                <input type="password" value={certSenha} onChange={e => setCertSenha(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              {uploadMsg && <p className="text-sm">{uploadMsg}</p>}
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setCertUpload(null)} className="text-sm text-gray-600 px-4 py-2">Fechar</button>
              <button onClick={uploadCert} disabled={!certFile}
                className="bg-brand-600 hover:bg-brand-700 text-white text-sm px-4 py-2 rounded-lg disabled:opacity-50">
                Enviar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
