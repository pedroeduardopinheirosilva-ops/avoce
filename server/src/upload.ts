import { resolve, join } from "node:path";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { extrairMetaCert, invalidarCacheCert } from "./lib/nfse.js";
import { prisma } from "./db.js";

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

export async function salvarCertificado(
  empresaId: string,
  fileBuffer: Buffer,
  senha: string
): Promise<{ nome: string; validade: Date }> {
  // Valida e extrai metadados antes de salvar
  const meta = extrairMetaCert(fileBuffer, senha);

  mkdirSync(CERTS_DIR, { recursive: true });
  const certPath = certPathForEmpresa(empresaId);

  writeFileSync(certPath, fileBuffer);
  invalidarCacheCert(certPath);

  // Salva senha em variável de ambiente (acesso em runtime) e no banco (persistência)
  process.env[`CERT_PASS_${empresaId}`] = senha;

  // Atualiza metadados + senha no banco
  await prisma.empresaEmitente.update({
    where: { id: empresaId },
    data:  { certNome: meta.nome, certValidade: meta.validade, certPass: senha },
  });

  return meta;
}
