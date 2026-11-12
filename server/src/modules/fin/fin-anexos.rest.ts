/**
 * Anexos do financeiro gerencial e dos acordos (comprovantes, NF, autorizações) — REST, fora do tRPC.
 *
 *   POST /api/fin-anexos/upload?emitenteId=…      multipart, campo "file" (ou campo "emitenteId" no form)
 *        → 200 { path, nome, tamanho, mimetype }
 *        `path` é relativo ("fin/{emitenteId}/{AAAA-MM}/{arquivo}") e vai nos campos *Path dos modelos
 *        (Lancamento.comprovantePath, FinRecebimento.*Path, Acordo.autorizacaoAnexoPath…); `nome` no *Nome.
 *   GET  /api/fin-anexos/download?path=…&nome=…&inline=1   (Bearer ou ?token=)
 *        → o arquivo. `nome` (opcional) é o nome sugerido no download; `inline=1` abre no navegador.
 *
 * Acesso: JWT + emitente acessível ao usuário (lista de emitentes / tenant). Upload exige um dos módulos
 * financeiro_editar, financeiro ou acordos; download, financeiro, financeiro_editar ou acordos.
 * O emitente vem do próprio caminho, que é validado (sem "..", sem barra inicial, 4 segmentos fixos)
 * e resolvido dentro de `${UPLOADS_DIR}/fin`. Arquivo não é apagado ao trocar/excluir o registro.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { analisarPathAnexo, extensaoPermitida, nomeArquivoSeguro, PREFIXO_ANEXO_FIN } from "../../lib/fin/anexos.js";
import { assertEmitenteDoTenant, ctxDeTokenRest, temModulo, type CtxPerm } from "../../lib/fin/perm.js";
import { paraDataCal } from "../../lib/fin/util.js";

const MODULOS_UPLOAD = ["financeiro_editar", "financeiro", "acordos"];
const MODULOS_DOWNLOAD = ["financeiro", "financeiro_editar", "acordos"];
const LIMITE_BYTES = 25 * 1024 * 1024;

function baseDir(): string {
  return resolve(process.env.UPLOADS_DIR ?? "/opt/avoce/uploads", PREFIXO_ANEXO_FIN);
}

const MIME_POR_EXT: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  heic: "image/heic", txt: "text/plain; charset=utf-8", csv: "text/csv; charset=utf-8", xml: "application/xml", ofx: "application/x-ofx",
  zip: "application/zip", doc: "application/msword", xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  odt: "application/vnd.oasis.opendocument.text", ods: "application/vnd.oasis.opendocument.spreadsheet",
};

async function podeEmitente(ctx: CtxPerm, emitenteId: string): Promise<boolean> {
  try {
    await assertEmitenteDoTenant(ctx, emitenteId);
    return true;
  } catch {
    return false;
  }
}

function negar(reply: FastifyReply, code: number, error: string) {
  return reply.status(code).send({ error });
}

export function registrarRotasFinAnexos(app: FastifyInstance): void {
  app.post("/api/fin-anexos/upload", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const ctx = await ctxDeTokenRest(req.headers.authorization, q.token);
    if (!ctx) return negar(reply, 401, "Não autorizado");
    if (!temModulo(ctx, ...MODULOS_UPLOAD)) return negar(reply, 403, "Sem permissão para anexar no financeiro");

    let emitenteId = q.emitenteId ?? "";
    let arquivo: Buffer | null = null;
    let nomeOriginal = "arquivo";
    let mimetype = "application/octet-stream";
    let excedeu = false;
    for await (const part of req.parts()) {
      if (part.type === "file") {
        if (part.fieldname !== "file" || arquivo) {
          part.file.resume();
          continue;
        }
        nomeOriginal = part.filename || nomeOriginal;
        mimetype = part.mimetype || mimetype;
        const chunks: Buffer[] = [];
        let tam = 0;
        for await (const chunk of part.file) {
          tam += (chunk as Buffer).length;
          if (tam > LIMITE_BYTES) {
            excedeu = true;
            break;
          }
          chunks.push(chunk as Buffer);
        }
        if (excedeu) part.file.resume();
        arquivo = Buffer.concat(chunks);
      } else if (part.fieldname === "emitenteId" && !emitenteId) {
        emitenteId = String(part.value ?? "");
      }
    }
    if (excedeu) return negar(reply, 413, "Arquivo maior que 25 MB");
    if (!arquivo || arquivo.length === 0) return negar(reply, 400, "Envie o arquivo no campo 'file'");
    if (!emitenteId || !/^[A-Za-z0-9_-]+$/.test(emitenteId)) return negar(reply, 400, "emitenteId obrigatório");
    if (!extensaoPermitida(nomeOriginal)) return negar(reply, 400, "Tipo de arquivo não permitido");
    if (!(await podeEmitente(ctx, emitenteId))) return negar(reply, 403, "Acesso negado a esta empresa emissora");

    const mesPasta = paraDataCal(new Date()).slice(0, 7);
    const arquivoDisco = nomeArquivoSeguro(nomeOriginal, `${Date.now()}_${randomBytes(4).toString("hex")}`);
    const relativo = `${PREFIXO_ANEXO_FIN}/${emitenteId}/${mesPasta}/${arquivoDisco}`;
    if (!analisarPathAnexo(relativo)) return negar(reply, 400, "Nome de arquivo inválido");
    const dir = join(baseDir(), emitenteId, mesPasta);
    mkdirSync(dir, { recursive: true });
    await writeFile(join(dir, arquivoDisco), arquivo);
    return reply.send({ path: relativo, nome: nomeOriginal.slice(0, 255), tamanho: arquivo.length, mimetype });
  });

  app.get("/api/fin-anexos/download", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const ctx = await ctxDeTokenRest(req.headers.authorization, q.token);
    if (!ctx) return negar(reply, 401, "Não autorizado");
    if (!temModulo(ctx, ...MODULOS_DOWNLOAD)) return negar(reply, 403, "Sem permissão");

    const info = analisarPathAnexo(q.path);
    if (!info) return negar(reply, 400, "Caminho inválido");
    if (!(await podeEmitente(ctx, info.emitenteId))) return negar(reply, 403, "Acesso negado a esta empresa emissora");

    const base = baseDir();
    const abs = resolve(base, ...info.partes.slice(1));
    if (!abs.startsWith(base + sep)) return negar(reply, 400, "Caminho inválido");
    if (!existsSync(abs) || !statSync(abs).isFile()) return negar(reply, 404, "Arquivo não encontrado");

    const nomeDisco = info.partes[3];
    const ext = (nomeDisco.split(".").pop() ?? "").toLowerCase();
    const nome = (q.nome && q.nome.length <= 255 ? q.nome : nomeDisco).replace(/[\r\n"]/g, "_");
    reply.header("Content-Type", MIME_POR_EXT[ext] ?? "application/octet-stream");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Content-Disposition", `${q.inline === "1" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(nome)}`);
    return reply.send(createReadStream(abs));
  });
}
