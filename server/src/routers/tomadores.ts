import { z }                from "zod";
import { TRPCError }        from "@trpc/server";
import { router, authProc } from "./trpc.js";
import { prisma }           from "../db.js";
import { whereEmpresa, canOperate } from "./tenant-utils.js";

const ESTADOS_CIVIS = ["solteiro", "casada", "divorciado", "viuvo", "uniao_estavel"] as const;

const adminInput = z.object({
  nome:           z.string().min(2),
  cpf:            z.string().optional().nullable(),
  cargo:          z.string().optional().nullable(),
  nacionalidade:  z.string().optional().nullable(),
  estadoCivil:    z.enum(ESTADOS_CIVIS).optional().nullable(),
  regimeCasamento: z.string().optional().nullable(),
  profissao:      z.string().optional().nullable(),
  rg:             z.string().optional().nullable(),
  rgOrgaoEmissor: z.string().optional().nullable(),
  dataNascimento: z.string().optional().nullable(),  // ISO date string
  naturalidade:   z.string().optional().nullable(),
  endereco:       z.string().optional().nullable(),
  numero:         z.string().optional().nullable(),
  complemento:    z.string().optional().nullable(),
  bairro:         z.string().optional().nullable(),
  cidade:         z.string().optional().nullable(),
  uf:             z.string().optional().nullable(),
  cep:            z.string().optional().nullable(),
});

const tomadorInput = z.object({
  nome:              z.string().min(2),
  nomeFantasia:      z.string().optional().nullable(),
  cpfCnpj:           z.string().min(11),
  email:             z.string().email().optional().nullable(),
  emailFinanceiro:   z.string().email().optional().nullable(),
  emailGeral:        z.string().email().optional().nullable(),
  emailDiretoria:    z.string().email().optional().nullable(),
  telefone:          z.string().optional().nullable(),
  inscricaoEstadual: z.string().optional().nullable(),
  endereco:          z.string().optional().nullable(),
  numero:            z.string().optional().nullable(),
  complemento:       z.string().optional().nullable(),
  bairro:            z.string().optional().nullable(),
  cidade:            z.string().optional().nullable(),
  codigoMunicipio:   z.string().optional().nullable(),
  uf:                z.string().length(2).optional().nullable(),
  cep:               z.string().optional().nullable(),
  inscMunicipal:     z.string().optional().nullable(),
  // Pessoa Física
  dataNascimento:  z.string().optional().nullable(),
  nacionalidade:   z.string().optional().nullable(),
  estadoCivil:     z.enum(ESTADOS_CIVIS).optional().nullable(),
  profissao:       z.string().optional().nullable(),
  rg:              z.string().optional().nullable(),
  rgOrgaoEmissor:  z.string().optional().nullable(),
  naturalidade:    z.string().optional().nullable(),
  // Pessoa Jurídica
  capitalSocial:    z.number().int().optional().nullable(),
  dataConstituicao: z.string().optional().nullable(),
  tipoSocietario:   z.string().optional().nullable(),
  objetoSocial:     z.string().optional().nullable(),
  // Pessoa Física — adicional
  regimeCasamento:  z.string().optional().nullable(),
  // NFS-e
  issRetido:        z.boolean().optional(),
  // Emitente ao qual este tomador pertence (obrigatório quando criado por admin global)
  empresaId:        z.string().optional().nullable(),
});

function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Tomador.empresaId é FK para a tabela Empresa (tenant). O <select> "Escritório /
 * Emitente" do formulário envia o id de um EmpresaEmitente (emitente), que NÃO é
 * uma Empresa válida → FK violada. Aqui resolvemos: se o id já for uma Empresa,
 * usa direto; se for um EmpresaEmitente, usa o tenant dele (empresaId); senão cai
 * no tenant do contexto.
 */
async function resolveTenantEmpresaId(
  input: string | null | undefined,
  ctxEmpresaId: string | undefined,
): Promise<string | undefined> {
  if (input) {
    const emp = await prisma.empresa.findUnique({ where: { id: input }, select: { id: true } });
    if (emp) return emp.id;
    const emit = await (prisma as any).empresaEmitente.findUnique({
      where: { id: input }, select: { empresaId: true },
    });
    if (emit?.empresaId) return emit.empresaId as string;
  }
  return ctxEmpresaId ?? undefined;
}

export const tomadorRouter = router({
  listar: authProc
    .input(z.object({ busca: z.string().optional() }))
    .query(async ({ input, ctx }) => {
      const empresaFilter = whereEmpresa(ctx);

      // Usuário com acesso restrito a emitentes específicos: filtra tomadores
      // que possuem pelo menos uma proposta ou contrato desses emitentes.
      const emitentes = ctx.emitentesAcessiveis;
      const emitenteFilter: Record<string, unknown> =
        emitentes && emitentes.length > 0
          ? { OR: [
              { propostas: { some: { emitenteId: { in: emitentes } } } },
              { contratos: { some: { emitenteId: { in: emitentes } } } },
            ] }
          : {};

      const baseWhere: Record<string, unknown> = Object.keys(emitenteFilter).length
        ? { AND: [empresaFilter, emitenteFilter] }
        : empresaFilter;

      return prisma.tomador.findMany({
        where: input.busca
          ? { AND: [baseWhere, { OR: [
              { nome:    { contains: input.busca, mode: "insensitive" } },
              { cpfCnpj: { contains: input.busca } },
            ] }] }
          : baseWhere,
        orderBy: { nome: "asc" },
        take: 200,
      });
    }),

  obter: authProc
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const tomador = await (prisma.tomador as any).findUniqueOrThrow({
        where: { id: input.id },
        include: { administradores: { orderBy: { criadoEm: "asc" } } },
      });
      if (!canOperate(ctx, tomador.empresaId)) throw new Error("Tomador não pertence à sua empresa");
      return tomador;
    }),

  criar: authProc
    .input(tomadorInput)
    .mutation(async ({ input, ctx }) => {
      const { dataNascimento, dataConstituicao, empresaId: inputEmpresaId, ...rest } = input;
      const empresaId = await resolveTenantEmpresaId(inputEmpresaId, ctx.empresaId);
      try {
        return await prisma.tomador.create({
          data: {
            ...rest,
            empresaId,
            dataNascimento:  parseDate(dataNascimento),
            dataConstituicao: parseDate(dataConstituicao),
          } as any,
        });
      } catch (e: any) {
        if (e?.code === "P2002") {
          throw new TRPCError({ code: "CONFLICT", message: "Já existe um tomador cadastrado com este CPF/CNPJ." });
        }
        throw e;
      }
    }),

  atualizar: authProc
    .input(tomadorInput.partial().extend({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { id, dataNascimento, dataConstituicao, empresaId: inputEmpresaId, ...rest } = input;
      const tomador = await prisma.tomador.findUnique({ where: { id }, select: { empresaId: true } });
      if (!tomador || !canOperate(ctx, tomador.empresaId)) throw new Error("Tomador não pertence à sua empresa");
      // Só toca em empresaId quando enviado e resolúvel para uma Empresa válida.
      let empresaUpdate: { empresaId?: string } = {};
      if (inputEmpresaId) {
        const resolved = await resolveTenantEmpresaId(inputEmpresaId, ctx.empresaId);
        if (resolved) empresaUpdate = { empresaId: resolved };
      }
      return prisma.tomador.update({
        where: { id },
        data: {
          ...rest,
          ...empresaUpdate,
          ...(dataNascimento  !== undefined ? { dataNascimento:  parseDate(dataNascimento)  } : {}),
          ...(dataConstituicao !== undefined ? { dataConstituicao: parseDate(dataConstituicao) } : {}),
        } as any,
      });
    }),

  excluir: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { id } = input;
      const tomador = await prisma.tomador.findUnique({ where: { id }, select: { empresaId: true } });
      if (!tomador || !canOperate(ctx, tomador.empresaId)) throw new Error("Tomador não pertence à sua empresa");
      return prisma.tomador.delete({ where: { id: input.id } });
    }),

  // ── Administradores ──────────────────────────────────────────────────────────

  criarAdministrador: authProc
    .input(adminInput.extend({ tomadorId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { dataNascimento, ...rest } = input;
      return (prisma as any).administrador.create({
        data: { ...rest, empresaId: ctx.empresaId ?? undefined, dataNascimento: parseDate(dataNascimento) },
      });
    }),

  atualizarAdministrador: authProc
    .input(adminInput.partial().extend({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { id, dataNascimento, ...rest } = input;
      const adm = await (prisma as any).administrador.findUnique({ where: { id }, select: { empresaId: true } });
      if (!adm || !canOperate(ctx, adm.empresaId)) throw new Error("Administrador não pertence à sua empresa");
      return (prisma as any).administrador.update({
        where: { id },
        data: {
          ...rest,
          ...(dataNascimento !== undefined ? { dataNascimento: parseDate(dataNascimento) } : {}),
        },
      });
    }),

  excluirAdministrador: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { id } = input;
      const adm = await (prisma as any).administrador.findUnique({ where: { id }, select: { empresaId: true } });
      if (!adm || !canOperate(ctx, adm.empresaId)) throw new Error("Administrador não pertence à sua empresa");
      return (prisma as any).administrador.delete({ where: { id: input.id } });
    }),
});
