import { z }                from "zod";
import { router, authProc } from "./trpc.js";
import { prisma }           from "../db.js";

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
});

function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export const tomadorRouter = router({
  listar: authProc
    .input(z.object({ busca: z.string().optional() }))
    .query(async ({ input }) => {
      return prisma.tomador.findMany({
        where: input.busca
          ? { OR: [
              { nome:    { contains: input.busca, mode: "insensitive" } },
              { cpfCnpj: { contains: input.busca } },
            ] }
          : undefined,
        orderBy: { nome: "asc" },
        take: 200,
      });
    }),

  obter: authProc
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      return (prisma.tomador as any).findUniqueOrThrow({
        where: { id: input.id },
        include: { administradores: { orderBy: { criadoEm: "asc" } } },
      });
    }),

  criar: authProc
    .input(tomadorInput)
    .mutation(async ({ input }) => {
      const { dataNascimento, dataConstituicao, ...rest } = input;
      return prisma.tomador.create({
        data: {
          ...rest,
          dataNascimento:  parseDate(dataNascimento),
          dataConstituicao: parseDate(dataConstituicao),
        } as any,
      });
    }),

  atualizar: authProc
    .input(tomadorInput.partial().extend({ id: z.string() }))
    .mutation(async ({ input }) => {
      const { id, dataNascimento, dataConstituicao, ...rest } = input;
      return prisma.tomador.update({
        where: { id },
        data: {
          ...rest,
          ...(dataNascimento  !== undefined ? { dataNascimento:  parseDate(dataNascimento)  } : {}),
          ...(dataConstituicao !== undefined ? { dataConstituicao: parseDate(dataConstituicao) } : {}),
        } as any,
      });
    }),

  excluir: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      return prisma.tomador.delete({ where: { id: input.id } });
    }),

  // ── Administradores ──────────────────────────────────────────────────────────

  criarAdministrador: authProc
    .input(adminInput.extend({ tomadorId: z.string() }))
    .mutation(async ({ input }) => {
      const { dataNascimento, ...rest } = input;
      return (prisma as any).administrador.create({
        data: { ...rest, dataNascimento: parseDate(dataNascimento) },
      });
    }),

  atualizarAdministrador: authProc
    .input(adminInput.partial().extend({ id: z.string() }))
    .mutation(async ({ input }) => {
      const { id, dataNascimento, ...rest } = input;
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
    .mutation(async ({ input }) => {
      return (prisma as any).administrador.delete({ where: { id: input.id } });
    }),
});
