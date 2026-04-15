import { initTRPC, TRPCError } from "@trpc/server";
import jwt                     from "jsonwebtoken";
import type { FastifyRequest } from "fastify";

export interface Context {
  req: FastifyRequest;
  userId?: string;
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

export const authProc = t.procedure.use(({ ctx, next }) => {
  const auth  = ctx.req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET ?? "avoce_secret") as { userId: string };
    return next({ ctx: { ...ctx, userId: payload.userId } });
  } catch {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Token inválido ou expirado" });
  }
});
