import { resolve, join } from "node:path";
import { writeFileSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { extrairMetaCert, invalidarCacheCert } from "./lib/nfse.js";
import { invalidarCacheSicoobBoleto } from "./lib/sicoob-boleto.js";
import { invalidarCacheSicoobPix }    from "./lib/sicoob-pix.js";
import { prisma } from "./db.js";
import { fieldEncrypt } from "./lib/field-crypto.js";

export const CERTS_DIR  = resolve(process.env.CERTS_DIR  ?? "./certs");
export const LOGOS_DIR  = resolve(process.env.LOGOS_DIR  ?? "./logos");

export function certPathForEmpresa(empresaId: string): string {
  return join(CERTS_DIR, `${empresaId}.p12`);
}

export function logoPathForEmpresa(empresaId: string, ext: string): string {
  return join(LOGOS_DIR, `${empresaId}.${ext}`);
}

export async function salvarLogo(
  empresaId: string,
  fileBuffer: Buffer,
  mimetype: string
): Promise<string> {
  const ext = mimetype === "image/png" ? "png" : mimetype === "image/svg+xml" ? "svg" : "jpg";
  mkdirSync(LOGOS_DIR, { recursive: true });
  const logoPath = logoPathForEmpresa(empresaId, ext);
  writeFileSync(logoPath, fileBuffer);
  await prisma.empresaEmitente.update({
    where: { id: empresaId },
    data:  { logoPath },
  });
  return logoPath;
}

// Converte PKCS12 legado (RC2-40-CBC) → moderno (AES-256) via openssl -legacy
// Certificados ICP-Brasil antigos usam RC2-40, que o OpenSSL 3.x desativou.
function normalizarPkcs12(input: Buffer, senha: string): Buffer {
  const tmp   = join(tmpdir(), `cert_${Date.now()}`);
  const tmpIn = `${tmp}_in.p12`;
  const tmpPem= `${tmp}.pem`;
  const tmpOut= `${tmp}_out.p12`;
  try {
    writeFileSync(tmpIn, input);
    // Sem shell e com a senha via env: a senha do certificado é entrada do usuário
    const env = { ...process.env, P12_SENHA: senha, P12_TMP: "temp_conv123" };
    execFileSync("openssl",
      ["pkcs12", "-legacy", "-in", tmpIn, "-out", tmpPem, "-passin", "env:P12_SENHA", "-passout", "env:P12_TMP"],
      { stdio: "pipe", env }
    );
    execFileSync("openssl",
      ["pkcs12", "-export", "-in", tmpPem, "-out", tmpOut, "-passin", "env:P12_TMP", "-passout", "env:P12_SENHA"],
      { stdio: "pipe", env }
    );
    return readFileSync(tmpOut);
  } finally {
    for (const f of [tmpIn, tmpPem, tmpOut]) try { unlinkSync(f); } catch {}
  }
}

export async function salvarCertificado(
  empresaId: string,
  fileBuffer: Buffer,
  senha: string
): Promise<{ nome: string; validade: Date }> {
  // Valida e extrai metadados antes de salvar
  const meta = extrairMetaCert(fileBuffer, senha);

  mkdirSync(CERTS_DIR, { recursive: true });
  const certPath = certPathForEmpresa(empresaId);

  // Tenta usar diretamente; se falhar com algoritmo legado, converte
  let certData = fileBuffer;
  try {
    // Verifica se o Node.js consegue abrir o PKCS12 (cria contexto TLS de teste)
    const { createSecureContext } = await import("node:tls");
    createSecureContext({ pfx: fileBuffer, passphrase: senha });
  } catch (err: any) {
    if (/unsupported|rc2|legacy/i.test(String(err?.message ?? ""))) {
      console.log(`[Upload] Certificado legado detectado (${err.message}) — convertendo para AES-256...`);
      certData = normalizarPkcs12(fileBuffer, senha);
      console.log("[Upload] Certificado convertido com sucesso");
    } else {
      throw err;
    }
  }

  writeFileSync(certPath, certData);
  invalidarCacheCert(certPath);
  invalidarCacheSicoobBoleto(certPath);
  invalidarCacheSicoobPix(certPath);

  // Salva senha em variável de ambiente (acesso em runtime) e no banco (persistência)
  process.env[`CERT_PASS_${empresaId}`] = senha;

  // Atualiza metadados + senha no banco
  await prisma.empresaEmitente.update({
    where: { id: empresaId },
    data:  { certNome: meta.nome, certValidade: meta.validade, certPass: fieldEncrypt(senha) },
  });

  return meta;
}
