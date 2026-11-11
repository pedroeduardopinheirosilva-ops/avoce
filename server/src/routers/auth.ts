import { z }         from "zod";
import jwt           from "jsonwebtoken";
import bcrypt        from "bcryptjs";
import { TRPCError } from "@trpc/server";
import { router, publicProc, authProc } from "./trpc.js";
import { prisma }    from "../db.js";
import { canOperate, canAccess } from "./tenant-utils.js";
import type { PermissoesUsuario } from "./permission-constants.js";

// ── Rate limiting para login: 5 tentativas por IP a cada 15 minutos ───────────
const _loginAttempts = new Map<string, { count: number; resetAt: number }>();

function checkLoginRateLimit(ip: string): void {
  const now = Date.now();
  const WINDOW_MS = 15 * 60 * 1000;
  const MAX = 5;
  const entry = _loginAttempts.get(ip);
  if (entry && now < entry.resetAt) {
    if (entry.count >= MAX) {
      throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Muitas tentativas. Aguarde 15 minutos." });
    }
    entry.count++;
  } else {
    _loginAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  }
}

export const authRouter = router({
  login: publicProc
    .input(z.object({ email: z.string().email(), senha: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const ip = (ctx.req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0].trim()
        ?? ctx.req.ip
        ?? "unknown";
      checkLoginRateLimit(ip);

      const user = await prisma.usuario.findUnique({
        where: { email: input.email },
        select: { id: true, nome: true, email: true, senha: true, ativo: true, empresaId: true, role: true },
      });
      if (!user || !user.ativo) throw new Error("Credenciais inválidas");
      const ok = await bcrypt.compare(input.senha, user.senha);
      if (!ok) throw new Error("Credenciais inválidas");

      const token = jwt.sign(
        { userId: user.id, empresaId: user.empresaId, role: user.role },
        process.env.JWT_SECRET!,
        { expiresIn: "7d" }
      );
      return { token, nome: user.nome, email: user.email, empresaId: user.empresaId, role: user.role };
    }),

  me: authProc.query(async ({ ctx }) => {
    const user = await prisma.usuario.findUniqueOrThrow({
      where: { id: ctx.userId },
      select: { id: true, nome: true, email: true, empresaId: true, role: true, permissoes: true },
    });
    return user;
  }),

  listUsuarios: authProc.query(async ({ ctx }) => {
    const where = ctx.role === "admin" && !ctx.empresaId ? {} : { empresaId: ctx.empresaId };
    return (prisma as any).usuario.findMany({
      where,
      select: { id: true, nome: true, email: true, role: true, ativo: true, criadoEm: true, permissoes: true, whatsapp: true },
      orderBy: { nome: "asc" },
    });
  }),

  createUsuario: authProc
    .input(z.object({
      nome: z.string(),
      email: z.string().email(),
      senha: z.string().min(6),
      empresaId: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.role !== "admin") throw new Error("Apenas administradores podem criar usuários");
      const hash = await bcrypt.hash(input.senha, 10);
      // Só admin global (sem empresaId) pode definir empresaId manualmente
      const empresaId = input.empresaId
        ? (ctx.role === "admin" && !ctx.empresaId ? input.empresaId : ctx.empresaId)
        : ctx.empresaId;
      return prisma.usuario.create({
        data: {
          nome: input.nome,
          email: input.email,
          senha: hash,
          empresaId,
          role: "user",
        },
        select: { id: true, nome: true, email: true, role: true },
      });
    }),

  updateUsuario: authProc
    .input(z.object({
      id:        z.string(),
      nome:      z.string().optional(),
      email:     z.string().email().optional(),
      senha:     z.string().min(6).optional(),
      ativo:     z.boolean().optional(),
      role:      z.enum(["user", "admin"]).optional(),
      whatsapp:  z.string().regex(/^\d{10,15}$/).nullable().optional(), // somente dígitos
    }))
    .mutation(async ({ input, ctx }) => {
      const { id, senha, ...rest } = input;
      const data: any = { ...rest };
      if (senha) data.senha = await bcrypt.hash(senha, 10);

      // Não-admin só edita o próprio cadastro e não muda papel nem status: antes qualquer
      // usuário se promovia a admin ou trocava senha/WhatsApp de colegas (o WhatsApp é a
      // identidade no Assistente Interno).
      const target = await prisma.usuario.findUnique({ where: { id }, select: { empresaId: true, role: true, ativo: true } });
      if (ctx.role !== "admin") {
        if (id !== ctx.userId) throw new Error("Apenas administradores podem editar outros usuários");
        // O formulário sempre reenvia `ativo`; só recusa se tentar MUDAR papel/status
        if ((rest.role !== undefined && rest.role !== target?.role) ||
            (rest.ativo !== undefined && rest.ativo !== target?.ativo)) {
          throw new Error("Apenas administradores podem alterar papel ou status");
        }
        delete data.role;
        delete data.ativo;
      }

      // Verify the user belongs to the same empresa (unless admin)
      if (!target || !canOperate(ctx, target.empresaId)) {
        throw new Error("Usuário não pertence à sua empresa");
      }

      return (prisma as any).usuario.update({
        where: { id },
        data,
        select: { id: true, nome: true, email: true, role: true, ativo: true, whatsapp: true },
      });
    }),

  deleteUsuario: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.role !== "admin") throw new Error("Apenas administradores podem excluir usuários");
      // Prevent self-deletion
      if (input.id === ctx.userId) throw new Error("Não é possível excluir sua própria conta");
      // Tenant admin can only delete users from same empresa
      {
        const target = await prisma.usuario.findUnique({ where: { id: input.id }, select: { empresaId: true } });
        if (!target || !canOperate(ctx, target.empresaId)) throw new Error("Usuário não pertence à sua empresa");
      }
      return prisma.usuario.delete({ where: { id: input.id } });
    }),

  updatePermissoes: authProc
    .input(z.object({
      id: z.string(),
      permissoes: z.object({
        modulos: z.array(z.string()).optional(),
        emitentes: z.array(z.string()).optional(),
        empresas: z.array(z.string()).optional(),
      }).nullable(),
    }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.role !== "admin") throw new Error("Apenas administradores podem alterar permissões");
      const target = await prisma.usuario.findUnique({ where: { id: input.id }, select: { empresaId: true } });
      if (!target || !canOperate(ctx, target.empresaId)) throw new Error("Usuário não pertence à sua empresa");
      // Admin de empresa só concede empresas/emitentes que ele mesmo alcança
      const p = input.permissoes;
      if (p?.empresas?.some((e) => !canAccess(ctx, e))) throw new Error("Empresa fora do seu escopo");
      if (p?.emitentes?.length) {
        const emits = await prisma.empresaEmitente.findMany({ where: { id: { in: p.emitentes } }, select: { empresaId: true } });
        if (emits.length !== new Set(p.emitentes).size || emits.some((e) => !canAccess(ctx, e.empresaId))) {
          throw new Error("Emitente fora do seu escopo");
        }
      }
      return prisma.usuario.update({
        where: { id: input.id },
        data:  { permissoes: input.permissoes as any },
        select: { id: true, nome: true, email: true, permissoes: true },
      });
    }),

  listEmitentesAcessiveis: authProc.query(async ({ ctx }) => {
    if (ctx.role !== "admin" && ctx.empresaId) {
      return prisma.empresaEmitente.findMany({
        where: { empresaId: ctx.empresaId },
        select: { id: true, nome: true },
        orderBy: { nome: "asc" },
      });
    }
    return prisma.empresaEmitente.findMany({
      select: { id: true, nome: true },
      orderBy: { nome: "asc" },
    });
  }),
});
