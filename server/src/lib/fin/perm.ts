/**
 * Permissões e isolamento do financeiro gerencial / acordos (decisão 9 do plano).
 *
 * Módulos (Usuario.permissoes.modulos):
 *   - permissoes === null  → acesso total (como hoje);
 *   - permissoes.modulos ausente → sem restrição de módulo (como o web já trata em usePermission);
 *   - role "admin" → sem restrição de módulo (admin já pode se dar qualquer módulo);
 *   - senão o módulo precisa estar na lista.
 *
 *   financeiro        → leitura do financeiro (e edição dos lançamentos antigos `financeiro.*`, modo legado)
 *   financeiro_editar → mutações do financeiro gerencial (`fin.*`); também libera leitura
 *   acordos           → funil de acordos (2B)
 *
 * Emitente: `assertEmitenteDoTenant` = assertEmitenteAccess (lista permissoes.emitentes) +
 * emitente existe e pertence a uma empresa do usuário (quando ele não tem lista explícita).
 */
import { TRPCError } from "@trpc/server";
import jwt from "jsonwebtoken";
import { prisma } from "../../db.js";
import { authProc } from "../../routers/trpc.js";
import { assertEmitenteAccess, whereEmpresa, type TenantCtx } from "../../routers/tenant-utils.js";
import type { PermissoesUsuario } from "../../routers/permission-constants.js";

export interface CtxPerm extends TenantCtx {
  userId?: string;
  permissoes?: PermissoesUsuario | null;
}

/** true se o usuário tem QUALQUER um dos módulos (ver regras no topo). */
export function temModulo(ctx: CtxPerm, ...modulos: string[]): boolean {
  if (ctx.role === "admin") return true;
  const p = ctx.permissoes;
  if (p === null || p === undefined) return true;
  if (!Array.isArray(p.modulos)) return true;
  return modulos.some((m) => (p.modulos as string[]).includes(m));
}

export function exigirModulo(ctx: CtxPerm, ...modulos: string[]): void {
  if (!temModulo(ctx, ...modulos)) {
    throw new TRPCError({ code: "FORBIDDEN", message: `Sem permissão (módulo ${modulos.join(" ou ")})` });
  }
}

/** Leitura do financeiro: `financeiro` ou `financeiro_editar`. */
export function exigirFinanceiroLeitura(ctx: CtxPerm): void {
  exigirModulo(ctx, "financeiro", "financeiro_editar");
}

/**
 * Mutação do financeiro gerencial: exige `financeiro_editar`.
 * `legado: true` (rotas antigas `financeiro.criar/atualizar/deletar`) aceita também `financeiro`,
 * para não tirar a edição de quem já lança hoje.
 */
export function exigirFinanceiroEditar(ctx: CtxPerm, opts?: { legado?: boolean }): void {
  if (opts?.legado) exigirModulo(ctx, "financeiro_editar", "financeiro");
  else exigirModulo(ctx, "financeiro_editar");
}

/** Emitente acessível pelo usuário e do tenant dele. Lança FORBIDDEN/NOT_FOUND. */
export async function assertEmitenteDoTenant(ctx: CtxPerm, emitenteId: string): Promise<void> {
  assertEmitenteAccess(ctx, emitenteId);
  const listaExplicita = Array.isArray(ctx.emitentesAcessiveis);
  const em = await prisma.empresaEmitente.findFirst({
    where: listaExplicita ? { id: emitenteId } : { id: emitenteId, ...whereEmpresa(ctx) },
    select: { id: true },
  });
  if (!em) throw new TRPCError({ code: "FORBIDDEN", message: "Empresa emissora não encontrada ou fora do seu escopo" });
}

/** Procedures prontas: leitura (financeiro|financeiro_editar) e edição (financeiro_editar). */
export const finLeituraProc = authProc.use(({ ctx, next }) => {
  exigirFinanceiroLeitura(ctx);
  return next();
});

export const finEdicaoProc = authProc.use(({ ctx, next }) => {
  exigirFinanceiroEditar(ctx);
  return next();
});

// ── REST (fora do tRPC) ─────────────────────────────────────────────────────

/**
 * Reconstrói o contexto de permissões a partir do Bearer (ou `?token=`) de uma rota REST,
 * com a mesma regra do `authProc`. Retorna null se o token for inválido.
 */
export async function ctxDeTokenRest(authorization: string | undefined, tokenQuery?: string): Promise<CtxPerm | null> {
  const header = (authorization ?? "").startsWith("Bearer ") ? (authorization as string).slice(7) : "";
  const token = header || tokenQuery || "";
  let payload: { userId: string; empresaId?: string; role?: string };
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET!) as typeof payload;
  } catch {
    return null;
  }
  const user = await prisma.usuario.findUnique({ where: { id: payload.userId }, select: { permissoes: true, ativo: true } });
  if (!user || user.ativo === false) return null;
  const raw = user.permissoes as PermissoesUsuario | null | undefined;
  let permissoes: PermissoesUsuario | null;
  if (payload.role === "admin" && !payload.empresaId) permissoes = raw?.empresas_full?.length ? raw : null;
  else permissoes = raw ?? null;
  const emitentesAcessiveis = (permissoes?.emitentes as string[] | undefined) ?? null;
  const empresasFull = permissoes?.empresas_full ?? [];
  const extra = permissoes?.empresas ?? [];
  const empresaIds = empresasFull.length
    ? [...new Set(empresasFull)]
    : payload.empresaId ? [...new Set([payload.empresaId, ...extra])] : extra;
  return {
    userId: payload.userId,
    empresaId: payload.empresaId,
    empresaIds,
    role: payload.role,
    permissoes,
    emitentesAcessiveis,
  };
}
