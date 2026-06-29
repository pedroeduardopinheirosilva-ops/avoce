import { initTRPC, TRPCError } from "@trpc/server";
import jwt                     from "jsonwebtoken";
import type { FastifyRequest } from "fastify";
import { prisma }              from "../db.js";
import type { PermissoesUsuario } from "./permission-constants.js";

export interface Context {
  req: FastifyRequest;
  userId?: string;
  empresaId?: string;
  empresaIds?: string[];    // all empresas this user can access (primary + extra from permissoes.empresas)
  role?: string;
  permissoes?: PermissoesUsuario | null;  // null = full access
  emitentesAcessiveis?: string[] | null;   // null = all emitentes
}

export const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    if (error.code === "BAD_REQUEST") {
      console.error("[tRPC BAD_REQUEST]", shape.message);
    }
    return shape;
  },
});

export const router     = t.router;
export const publicProc = t.procedure;

export const authProc = t.procedure.use(async ({ ctx, next }) => {
  const auth  = ctx.req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as {
      userId: string;
      empresaId?: string;
      role?: string;
    };

    // Load permissions
    const user = await prisma.usuario.findUnique({
      where: { id: payload.userId },
      select: { permissoes: true },
    });
    const raw = user?.permissoes as PermissoesUsuario | null | undefined;

    let permissoes: PermissoesUsuario | null = null;
    let emitentesAcessiveis: string[] | null = null;

    if (payload.role === "admin" && !payload.empresaId) {
      if (raw?.empresas_full?.length) {
        // Restricted global admin: data access limited to empresas_full.
        // Tenant management (assertGlobalAdmin) stays unrestricted — it checks
        // JWT payload (role + !empresaId) directly, not the resolved empresaIds.
        permissoes = raw;
        emitentesAcessiveis = (raw.emitentes as string[] | undefined) ?? null;
      } else {
        // True global admin: bypass all permission checks
        permissoes = null;
        emitentesAcessiveis = null;
      }
    } else {
      permissoes = raw ?? null;
      emitentesAcessiveis = (raw?.emitentes as string[] | undefined) ?? null;
    }

    // Build the full list of empresas this user can access for data queries
    const empresasFull = (permissoes?.empresas_full as string[] | undefined) ?? [];
    const extraEmpresas = (permissoes?.empresas as string[] | undefined) ?? [];
    const empresaIds = empresasFull.length
      ? [...new Set(empresasFull)]
      : payload.empresaId
        ? [...new Set([payload.empresaId, ...extraEmpresas])]
        : extraEmpresas;

    return next({
      ctx: {
        ...ctx,
        userId: payload.userId,
        empresaId: payload.empresaId,
        empresaIds,
        role: payload.role,
        permissoes,
        emitentesAcessiveis,
      },
    });
  } catch {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Token inválido ou expirado" });
  }
});
