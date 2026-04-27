import { useState, useRef, useEffect, ChangeEvent } from "react";
import { useNavigate, useParams, useSearchParams, Link } from "react-router-dom";
import { trpc } from "../../lib/trpc";

export const BANK_METADATA = {
  SICOOB:   { name: "Sicoob",      code: "756" },
  BRADESCO: { name: "Bradesco",    code: "237" },
  INTER:    { name: "Inter",       code: "077" },
  BTG:      { name: "BTG Pactual", code: "208" },
} as const;

type Provider = keyof typeof BANK_METADATA;

// ─── Helpers ────────────────────────────────────────────────────────────────

function fileToBase64(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = () => res((reader.result as string).split(",")[1] ?? "");
    reader.onerror = rej;
    reader.readAsDataURL(file);
  });
}

function fileToPem(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = () => res(reader.result as string);
    reader.onerror = rej;
    reader.readAsText(file);
  });
}

// ─── Credential sub-forms ───────────────────────────────────────────────────

interface SicoobCredFormProps {
  onChange: (d: { certData?: string; certPassword?: string; clientId?: string }) => void;
}
function SicoobCredentialForm({ onChange }: SicoobCredFormProps) {
  const [certPassword, setCertPassword] = useState("");
  const [clientId, setClientId] = useState("");

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const b64 = await fileToBase64(file);
    onChange({ certData: b64, certPassword, clientId });
  }

  function update(partial: { certPassword?: string; clientId?: string }) {
    if (partial.certPassword !== undefined) setCertPassword(partial.certPassword);
    if (partial.clientId !== undefined) setClientId(partial.clientId);
    onChange({ certPassword: partial.certPassword ?? certPassword, clientId: partial.clientId ?? clientId });
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
        Certificado A1 ICP-Brasil emitido para o CNPJ da cooperativa. Extensão .pfx ou .p12.
      </p>
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Certificado (.pfx/.p12)</label>
        <input type="file" accept=".pfx,.p12" onChange={handleFile}
          className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:text-xs file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100" />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Senha do certificado</label>
        <input type="password" value={certPassword} onChange={(e) => update({ certPassword: e.target.value })}
          className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="Senha do .pfx" />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Client ID (Sicoob Dev)</label>
        <input type="text" value={clientId} onChange={(e) => update({ clientId: e.target.value })}
          className="w-full border rounded-lg px-3 py-2 text-sm font-mono" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
      </div>
    </div>
  );
}

interface BradescoCredFormProps {
  onChange: (d: { certData?: string; certPassword?: string; clientId?: string }) => void;
}
function BradescoCredentialForm({ onChange }: BradescoCredFormProps) {
  const [certPassword, setCertPassword] = useState("");
  const [clientId, setClientId] = useState("");

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const b64 = await fileToBase64(file);
    onChange({ certData: b64, certPassword, clientId });
  }

  function update(partial: { certPassword?: string; clientId?: string }) {
    if (partial.certPassword !== undefined) setCertPassword(partial.certPassword);
    if (partial.clientId !== undefined) setClientId(partial.clientId);
    onChange({ certPassword: partial.certPassword ?? certPassword, clientId: partial.clientId ?? clientId });
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
        Certificado A1 ICP-Brasil. Para acesso à API Bradesco, entre em contato com suporte.api@bradesco.com.br.
      </p>
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Certificado (.pfx/.p12)</label>
        <input type="file" accept=".pfx,.p12" onChange={handleFile}
          className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:text-xs file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100" />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Senha do certificado</label>
        <input type="password" value={certPassword} onChange={(e) => update({ certPassword: e.target.value })}
          className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="Senha do .pfx" />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Client ID</label>
        <input type="text" value={clientId} onChange={(e) => update({ clientId: e.target.value })}
          className="w-full border rounded-lg px-3 py-2 text-sm font-mono" placeholder="Client ID Bradesco" />
      </div>
    </div>
  );
}

interface InterCredFormProps {
  onChange: (d: { certPem?: string; keyPem?: string; clientId?: string; clientSecret?: string; expiresAt?: string }) => void;
}
function InterCredentialForm({ onChange }: InterCredFormProps) {
  const [certPem, setCertPem] = useState("");
  const [keyPem, setKeyPem] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  async function handleCert(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const pem = await fileToPem(file);
    setCertPem(pem);
    // Try to extract expiry from cert (approximate: 1 year from today)
    const expiresAt = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + 1);
    onChange({ certPem: pem, keyPem, clientId, clientSecret, expiresAt: expiresAt.toISOString() });
  }

  async function handleKey(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const pem = await fileToPem(file);
    setKeyPem(pem);
    onChange({ certPem, keyPem: pem, clientId, clientSecret });
  }

  function update(partial: { clientId?: string; clientSecret?: string }) {
    if (partial.clientId !== undefined) setClientId(partial.clientId);
    if (partial.clientSecret !== undefined) setClientSecret(partial.clientSecret);
    onChange({ certPem, keyPem, clientId: partial.clientId ?? clientId, clientSecret: partial.clientSecret ?? clientSecret });
  }

  return (
    <div className="space-y-3">
      <div className="bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-2 text-xs text-yellow-800">
        Atenção: o certificado do Inter tem validade de 1 ano. Você receberá um alerta ao se aproximar do vencimento.
        Obtenha o certificado e a chave no Internet Banking PJ (Config → API Banking).
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Certificado (.crt / .pem)</label>
        <input type="file" accept=".crt,.pem,.cer" onChange={handleCert}
          className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:text-xs file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100" />
        {certPem && <p className="text-xs text-green-600 mt-1">Certificado carregado ({certPem.length} chars)</p>}
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Chave privada (.key / .pem)</label>
        <input type="file" accept=".key,.pem" onChange={handleKey}
          className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:text-xs file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100" />
        {keyPem && <p className="text-xs text-green-600 mt-1">Chave privada carregada ({keyPem.length} chars)</p>}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Client ID</label>
          <input type="text" value={clientId} onChange={(e) => update({ clientId: e.target.value })}
            className="w-full border rounded-lg px-3 py-2 text-sm font-mono" placeholder="Client ID" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Client Secret</label>
          <input type="password" value={clientSecret} onChange={(e) => update({ clientSecret: e.target.value })}
            className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="Client Secret" />
        </div>
      </div>
    </div>
  );
}

interface BtgCredFormProps {
  onChange: (d: { clientId?: string; clientSecret?: string }) => void;
}
function BtgCredentialForm({ onChange }: BtgCredFormProps) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  function update(partial: { clientId?: string; clientSecret?: string }) {
    if (partial.clientId !== undefined) setClientId(partial.clientId);
    if (partial.clientSecret !== undefined) setClientSecret(partial.clientSecret);
    onChange({ clientId: partial.clientId ?? clientId, clientSecret: partial.clientSecret ?? clientSecret });
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
        Credenciais OAuth2 geradas no portal de desenvolvedores BTG Pactual Empresas.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Client ID</label>
          <input type="text" value={clientId} onChange={(e) => update({ clientId: e.target.value })}
            className="w-full border rounded-lg px-3 py-2 text-sm font-mono" placeholder="Client ID" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Client Secret</label>
          <input type="password" value={clientSecret} onChange={(e) => update({ clientSecret: e.target.value })}
            className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="Client Secret" />
        </div>
      </div>
    </div>
  );
}

// ─── Main form ───────────────────────────────────────────────────────────────

export default function ContaBancariaForm() {
  const navigate = useNavigate();
  const { id } = useParams<{ id?: string }>();
  const [searchParams] = useSearchParams();
  const isEdit = !!id && id !== "nova";

  const { data: empresas } = trpc.empresa.listar.useQuery();
  const [emitenteId, setEmitenteId] = useState(
    () => searchParams.get("emitenteId") ?? localStorage.getItem("avoce_emitenteId") ?? ""
  );

  // Account fields
  const [provider, setProvider] = useState<Provider>("SICOOB");
  const [name, setName] = useState("");
  const [agency, setAgency] = useState("");
  const [agencyDigit, setAgencyDigit] = useState("");
  const [account, setAccount] = useState("");
  const [accountDigit, setAccountDigit] = useState("");
  const [accountType, setAccountType] = useState("CC");
  const [pixKey, setPixKey] = useState("");
  const [isDefault, setIsDefault] = useState(false);

  // Credential state
  const credRef = useRef<Record<string, any>>({});

  // Test connection state
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // Load existing account for edit
  const { data: existing } = trpc.banking.accounts.get.useQuery(
    { emitenteId, id: id! },
    { enabled: isEdit && !!emitenteId && !!id }
  );

  useEffect(() => {
    if (existing) {
      setProvider((existing as any).provider ?? "SICOOB");
      setName((existing as any).name ?? "");
      setAgency((existing as any).agency ?? "");
      setAgencyDigit((existing as any).agencyDigit ?? "");
      setAccount((existing as any).account ?? "");
      setAccountDigit((existing as any).accountDigit ?? "");
      setAccountType((existing as any).accountType ?? "CC");
      setPixKey((existing as any).pixKey ?? "");
      setIsDefault((existing as any).isDefault ?? false);
    }
  }, [existing]);

  const createMut = trpc.banking.accounts.create.useMutation({
    onSuccess: () => navigate("/financeiro/contas"),
    onError: (e) => alert("Erro: " + e.message),
  });
  const updateMut = trpc.banking.accounts.update.useMutation({
    onSuccess: () => navigate("/financeiro/contas"),
    onError: (e) => alert("Erro: " + e.message),
  });
  const saveCredMut = trpc.banking.credentials.save.useMutation({
    onError: (e) => alert("Erro ao salvar credencial: " + e.message),
  });
  const testConnMut = trpc.banking.credentials.testConnection.useMutation({
    onSuccess: (r: any) => setTestResult({ ok: r.ok, msg: r.message ?? (r.ok ? "Conexão OK!" : "Falha na conexão") }),
    onError: (e) => setTestResult({ ok: false, msg: e.message }),
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!emitenteId) { alert("Selecione uma empresa."); return; }

    if (isEdit) {
      await updateMut.mutateAsync({
        emitenteId,
        id: id!,
        name: name || undefined,
        pixKey: pixKey || undefined,
        isDefault,
        accountType: accountType || undefined,
      });
    } else {
      const created = await createMut.mutateAsync({
        emitenteId,
        provider,
        name,
        bankCode: BANK_METADATA[provider].code,
        agency,
        agencyDigit: agencyDigit || undefined,
        account,
        accountDigit: accountDigit || undefined,
        accountType,
        pixKey: pixKey || undefined,
        isDefault,
      });

      // Save credentials if any
      const cred = credRef.current;
      if (cred && Object.keys(cred).length > 0) {
        const credType = provider === "INTER" ? "MTLS_KEYPAIR" : provider === "BTG" ? "OAUTH2" : "MTLS_CERT";
        await saveCredMut.mutateAsync({
          emitenteId,
          bankAccountId: (created as any).id,
          credentialType: credType,
          ...cred,
        });
      }
    }
  }

  async function handleTestConnection() {
    if (!emitenteId || !id) {
      alert("Salve a conta primeiro para testar a conexão.");
      return;
    }
    setTestResult(null);
    testConnMut.mutate({ emitenteId, bankAccountId: id, provider });
  }

  const isBusy = createMut.isPending || updateMut.isPending || saveCredMut.isPending;

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link to="/financeiro/contas" className="text-sm text-indigo-600 hover:underline">← Contas</Link>
        <h1 className="text-2xl font-bold text-gray-900">
          {isEdit ? "Editar Conta" : "Nova Conta Bancária"}
        </h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Empresa */}
        <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Empresa</h2>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Empresa emitente</label>
            <select
              value={emitenteId}
              onChange={(e) => { setEmitenteId(e.target.value); localStorage.setItem("avoce_emitenteId", e.target.value); }}
              className="w-full border rounded-lg px-3 py-2 text-sm"
              required
            >
              <option value="">Selecione...</option>
              {empresas?.map((e) => (
                <option key={e.id} value={e.id}>{e.nomeFantasia || e.nome}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Bank selection */}
        {!isEdit && (
          <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Banco</h2>
            <div className="grid grid-cols-2 gap-3">
              {(Object.keys(BANK_METADATA) as Provider[]).map((key) => {
                const m = BANK_METADATA[key];
                const selected = provider === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => { setProvider(key); setTestResult(null); }}
                    className={`flex items-center gap-3 p-3 rounded-xl border-2 text-left transition-colors ${
                      selected ? "border-indigo-500 bg-indigo-50" : "border-gray-200 hover:border-gray-300 bg-white"
                    }`}
                  >
                    <img
                      src={`/assets/banks/${key.toLowerCase()}.svg`}
                      alt={m.name}
                      className="h-8 w-8 rounded object-contain"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                    />
                    <div>
                      <p className={`text-sm font-semibold ${selected ? "text-indigo-700" : "text-gray-800"}`}>{m.name}</p>
                      <p className="text-xs text-gray-400">{m.code}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Account details */}
        <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Dados da Conta</h2>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Apelido</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="Ex: Conta Principal Sicoob"
              className="w-full border rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Agência</label>
              <input type="text" value={agency} onChange={(e) => setAgency(e.target.value)}
                required={!isEdit} className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="0001" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Dígito ag.</label>
              <input type="text" value={agencyDigit} onChange={(e) => setAgencyDigit(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="-" maxLength={2} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Tipo</label>
              <select value={accountType} onChange={(e) => setAccountType(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm">
                <option value="CC">Conta Corrente</option>
                <option value="CP">Conta Poupança</option>
                <option value="PP">Conta Pagamento</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Conta</label>
              <input type="text" value={account} onChange={(e) => setAccount(e.target.value)}
                required={!isEdit} className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="00000001" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Dígito conta</label>
              <input type="text" value={accountDigit} onChange={(e) => setAccountDigit(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="0" maxLength={2} />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Chave PIX (opcional)</label>
            <input type="text" value={pixKey} onChange={(e) => setPixKey(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="CPF, CNPJ, e-mail, telefone ou chave aleatória" />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} className="rounded" />
            <span className="text-sm text-gray-700">Definir como conta padrão</span>
          </label>
        </div>

        {/* Credentials — only on create */}
        {!isEdit && (
          <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Credenciais Bancárias</h2>
            {provider === "SICOOB" && (
              <SicoobCredentialForm onChange={(d) => { credRef.current = d; }} />
            )}
            {provider === "BRADESCO" && (
              <BradescoCredentialForm onChange={(d) => { credRef.current = d; }} />
            )}
            {provider === "INTER" && (
              <InterCredentialForm onChange={(d) => { credRef.current = d; }} />
            )}
            {provider === "BTG" && (
              <BtgCredentialForm onChange={(d) => { credRef.current = d; }} />
            )}
          </div>
        )}

        {/* Test connection — only on edit */}
        {isEdit && (
          <div className="bg-white border border-gray-200 rounded-xl p-5">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleTestConnection}
                disabled={testConnMut.isPending}
                className="text-sm px-4 py-2 bg-teal-50 hover:bg-teal-100 text-teal-700 rounded-lg disabled:opacity-50 transition-colors"
              >
                {testConnMut.isPending ? "Testando..." : "Testar Conexão"}
              </button>
              {testResult && (
                <span className={`text-sm flex items-center gap-1.5 ${testResult.ok ? "text-green-700" : "text-red-700"}`}>
                  {testResult.ok ? "✅" : "❌"} {testResult.msg}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-3">
          <Link to="/financeiro/contas"
            className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors">
            Cancelar
          </Link>
          <button
            type="submit"
            disabled={isBusy}
            className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
          >
            {isBusy ? "Salvando..." : isEdit ? "Salvar alterações" : "Criar conta"}
          </button>
        </div>
      </form>
    </div>
  );
}
