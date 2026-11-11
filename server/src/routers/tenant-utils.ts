import { TRPCError } from "@trpc/server";

export interface TenantCtx {
  empresaId?: string;
  empresaIds?: string[];
  role?: string;
  emitentesAcessiveis?: string[] | null;
}

function resolveEmpresaIds(ctx: TenantCtx): string[] {
  if (ctx.empresaIds?.length) return ctx.empresaIds;
  if (ctx.empresaId) return [ctx.empresaId];
  return [];
}

function isGlobalAdmin(ctx: TenantCtx): boolean {
  return ctx.role === "admin" && !ctx.empresaId && !ctx.empresaIds?.length;
}

/**
 * Retorna o filtro `where` para isolar dados por empresa.
 * Admin global vê tudo. Usuário com N empresas filtra por qualquer delas.
 */
export function whereEmpresa(ctx: TenantCtx, field = "empresaId"): Record<string, unknown> {
  if (isGlobalAdmin(ctx)) return {};
  const ids = resolveEmpresaIds(ctx);
  if (ids.length === 0) return { [field]: "__none__" };
  if (ids.length === 1) return { [field]: ids[0] };
  return { [field]: { in: ids } };
}

/**
 * Verifica se o usuário pode acessar um recurso de uma determinada empresa.
 */
export function canAccess(ctx: TenantCtx, recursoEmpresaId: string | null | undefined): boolean {
  if (isGlobalAdmin(ctx)) return true;
  const ids = resolveEmpresaIds(ctx);
  return !!recursoEmpresaId && ids.includes(recursoEmpresaId);
}

/**
 * Verifica se o usuário pode OPERAR um recurso de uma empresa.
 *
 * Igual a `canAccess`, mas também libera o admin da plataforma (role admin sem
 * empresa primária) — que pode ter `empresas_full` e ainda assim precisa alcançar
 * registros de empresa nula/legada.
 *
 * Use no lugar da comparação crua `recurso.empresaId !== ctx.empresaId`: aquela
 * ignora `permissoes.empresas`, então trava todo usuário que opera mais de uma
 * empresa (e trava por completo quem não tem empresa primária).
 */
export function canOperate(ctx: TenantCtx, recursoEmpresaId: string | null | undefined): boolean {
  if (ctx.role === "admin" && !ctx.empresaId) return true;
  return canAccess(ctx, recursoEmpresaId);
}

/**
 * Drop-in replacement for the inline `empresaFilter` pattern used in
 * emitente-scoped routers (notas, cobrancas, contratos, propostas, etc.).
 *
 * Handles three cases:
 * 1. User with full emitente access → same as current behavior (empresaId filter)
 * 2. User with specific emitentes → emitente.id IN filter
 * 3. Global admin → no filter
 */
export function whereEmitenteFilter(ctx: TenantCtx): Record<string, unknown> {
  const emitentes = ctx.emitentesAcessiveis;
  if (emitentes === null || emitentes === undefined) {
    // Full access: same as current behavior
    if (ctx.role === "admin" && !ctx.empresaId) return {};
    return { emitente: { empresaId: ctx.empresaId } };
  }
  if (emitentes.length === 0) return { emitente: { id: "__none__" } };
  return { emitente: { id: { in: emitentes } } };
}

/**
 * Verifica se o usuário pode acessar um emitente específico.
 */
export function canAccessEmitente(ctx: TenantCtx, emitenteId: string): boolean {
  const emitentes = ctx.emitentesAcessiveis;
  if (emitentes === null || emitentes === undefined) return true;
  return emitentes.includes(emitenteId);
}

/**
 * Lança FORBIDDEN se o usuário não puder acessar o emitente.
 */
export function assertEmitenteAccess(ctx: TenantCtx, emitenteId: string): void {
  if (!canAccessEmitente(ctx, emitenteId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Acesso negado a esta empresa emissora" });
  }
}
