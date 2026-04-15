import { z }         from "zod";
import jwt           from "jsonwebtoken";
import bcrypt        from "bcryptjs";
import { router, publicProc, authProc } from "./trpc.js";
import { prisma }    from "../db.js";

export const authRouter = router({
  login: publicProc
    .input(z.object({ email: z.string().email(), senha: z.string() }))
    .mutation(async ({ input }) => {
      const user = await prisma.usuario.findUnique({ where: { email: input.email } });
      if (!user || !user.ativo) throw new Error("Credenciais inválidas");
      const ok = await bcrypt.compare(input.senha, user.senha);
      if (!ok) throw new Error("Credenciais inválidas");

      const token = jwt.sign(
        { userId: user.id },
        process.env.JWT_SECRET ?? "avoce_secret",
        { expiresIn: "7d" }
      );
      return { token, nome: user.nome, email: user.email };
    }),

  me: authProc.query(async ({ ctx }) => {
    const user = await prisma.usuario.findUniqueOrThrow({ where: { id: ctx.userId } });
    return { id: user.id, nome: user.nome, email: user.email };
  }),

  listUsuarios: authProc.query(async () => {
    return prisma.usuario.findMany({
      select: { id: true, nome: true, email: true, ativo: true, criadoEm: true },
      orderBy: { nome: "asc" },
    });
  }),

  createUsuario: authProc
    .input(z.object({ nome: z.string(), email: z.string().email(), senha: z.string().min(6) }))
    .mutation(async ({ input }) => {
      const hash = await bcrypt.hash(input.senha, 10);
      return prisma.usuario.create({
        data: { nome: input.nome, email: input.email, senha: hash },
        select: { id: true, nome: true, email: true },
      });
    }),

  updateUsuario: authProc
    .input(z.object({
      id:    z.string(),
      nome:  z.string().optional(),
      email: z.string().email().optional(),
      senha: z.string().min(6).optional(),
      ativo: z.boolean().optional(),
    }))
    .mutation(async ({ input }) => {
      const { id, senha, ...rest } = input;
      const data: any = { ...rest };
      if (senha) data.senha = await bcrypt.hash(senha, 10);
      return prisma.usuario.update({
        where: { id },
        data,
        select: { id: true, nome: true, email: true, ativo: true },
      });
    }),
});
