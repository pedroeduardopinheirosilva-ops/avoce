import { z }           from "zod";
import bcrypt          from "bcryptjs";
import { TRPCError }   from "@trpc/server";
import { router, authProc } from "./trpc.js";
import { prisma }      from "../db.js";

function assertGlobalAdmin(ctx: { role?: string; empresaId?: string | null }) {
  if (!(ctx.role === "admin" && !ctx.empresaId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Apenas administradores globais podem gerenciar tenants" });
  }
}

export const tenantRouter = router({
  listar: authProc.query(async ({ ctx }) => {
    assertGlobalAdmin(ctx);
    return prisma.empresa.findMany({
      orderBy: { nome: "asc" },
      include: {
        _count: { select: { usuarios: true, emitentes: true } },
      },
    });
  }),

  criar: authProc
    .input(z.object({
      nome: z.string().min(2),
      cnpj: z.string().min(11),
    }))
    .mutation(async ({ input, ctx }) => {
      assertGlobalAdmin(ctx);
      const cnpj = input.cnpj.replace(/\D/g, "");
      return prisma.empresa.create({ data: { nome: input.nome, cnpj } });
    }),

  atualizar: authProc
    .input(z.object({
      id:   z.string(),
      nome: z.string().min(2).optional(),
      cnpj: z.string().optional(),
      ativo: z.boolean().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertGlobalAdmin(ctx);
      const { id, cnpj, ...rest } = input;
      const data: Record<string, unknown> = { ...rest };
      if (cnpj) data.cnpj = cnpj.replace(/\D/g, "");
      return prisma.empresa.update({ where: { id }, data });
    }),

  listarUsuarios: authProc
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertGlobalAdmin(ctx);
      return prisma.usuario.findMany({
        where: { empresaId: input.tenantId },
        select: { id: true, nome: true, email: true, role: true, ativo: true, criadoEm: true },
        orderBy: { nome: "asc" },
      });
    }),

  criarUsuario: authProc
    .input(z.object({
      tenantId: z.string(),
      nome:     z.string().min(2),
      email:    z.string().email(),
      senha:    z.string().min(6),
      role:     z.enum(["user", "admin"]).default("admin"),
    }))
    .mutation(async ({ input, ctx }) => {
      assertGlobalAdmin(ctx);
      const hash = await bcrypt.hash(input.senha, 10);
      return prisma.usuario.create({
        data: {
          nome:      input.nome,
          email:     input.email,
          senha:     hash,
          empresaId: input.tenantId,
          role:      input.role,
        },
        select: { id: true, nome: true, email: true, role: true },
      });
    }),

  toggleUsuario: authProc
    .input(z.object({ id: z.string(), ativo: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      assertGlobalAdmin(ctx);
      return prisma.usuario.update({
        where: { id: input.id },
        data:  { ativo: input.ativo },
        select: { id: true, ativo: true },
      });
    }),
});
