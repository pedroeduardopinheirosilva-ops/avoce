/**
 * Trilha de auditoria do financeiro gerencial e dos acordos (FinAuditLog).
 *
 * Uso (dentro ou fora de transação):
 *   await registrarAudit(tx, ctx, {
 *     emitenteId, entidade: "FinEmprestimo", entidadeId: e.id, acao: "atualizar", antes, depois,
 *   });
 *
 * `antes`/`depois` aceitam o objeto do Prisma direto: Decimal vira string, Date vira ISO
 * (serialização JSON). `undefined` é omitido. A gravação nunca derruba a mutação quando
 * `db` é o client global (erro só é logado); dentro de `$transaction` o erro propaga para
 * desfazer a operação inteira — prefira passar o `tx`.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../../db.js";

export type AcaoAudit = "criar" | "atualizar" | "excluir";

/** Client global ou o `tx` de `prisma.$transaction(async (tx) => …)`. */
export type DbFin = PrismaClient | Prisma.TransactionClient;

export interface RegistroAudit {
  emitenteId?: string | null;
  entidade: string; // nome do modelo (Lancamento, FinEmprestimoMov, Acordo, FinRecebimento…)
  entidadeId: string;
  acao: AcaoAudit;
  antes?: unknown;
  depois?: unknown;
}

/** Qualquer ctx com userId (o Context do tRPC serve). */
export interface CtxAudit {
  userId?: string;
}

/** Converte para JSON puro (Decimal → string, Date → ISO). null/undefined → undefined. */
export function paraJsonAudit(v: unknown): Prisma.InputJsonValue | undefined {
  if (v === null || v === undefined) return undefined;
  return JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
}

export async function registrarAudit(db: DbFin, ctx: CtxAudit | null | undefined, r: RegistroAudit): Promise<void> {
  const data = {
    emitenteId: r.emitenteId ?? null,
    entidade: r.entidade,
    entidadeId: r.entidadeId,
    acao: r.acao,
    usuarioId: ctx?.userId ?? null,
    antes: paraJsonAudit(r.antes),
    depois: paraJsonAudit(r.depois),
  };
  if (db === prisma) {
    try {
      await prisma.finAuditLog.create({ data });
    } catch (e) {
      console.error("[FinAudit] falha ao gravar log:", r.entidade, r.entidadeId, r.acao, e);
    }
    return;
  }
  await db.finAuditLog.create({ data });
}
