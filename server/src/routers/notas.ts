import { z }                from "zod";
import { router, authProc } from "./trpc.js";
import { prisma }           from "../db.js";
import { whereEmitenteFilter, assertEmitenteAccess } from "./tenant-utils.js";
import { emitirNfse, cancelarNfse, consultarNfse, dadosNotaEmitida, providerMunicipio, type EmpresaConfig } from "../lib/nfse.js";
import { consultarNfseChave, canalDaNota } from "../lib/nfse-dps.js";
import { enviarNfseSeNecessario } from "../lib/email-cobranca.js";
import { certPathForEmpresa } from "../upload.js";
import { renderTemplate }   from "../lib/template.js";
import { gerarCobrancaParaContrato } from "../lib/gerar-cobranca.js";
import { fieldDecrypt }     from "../lib/field-crypto.js";

async function getCfg(emitenteId: string): Promise<EmpresaConfig> {
  const emp = await prisma.empresaEmitente.findUniqueOrThrow({ where: { id: emitenteId } });
  const certPath = certPathForEmpresa(emitenteId);
  return {
    cnpj:                    emp.cnpj,
    inscricaoMunicipal:      emp.inscricaoMunicipal,
    certPath,
    certPass:                fieldDecrypt(emp.certPass) || process.env[`CERT_PASS_${emitenteId}`] || process.env.CERT_PASS_DEFAULT || "",
    aliquotaIss:             emp.aliquotaIss,
    itemListaServico:        emp.itemListaServico,
    codTributacao:           emp.codTributacao,
    codigoServicoNacional:   emp.codigoServicoNacional ?? undefined,
    codigoNbs:               emp.codigoNbs ?? undefined,
    regimeTributacao:        emp.regimeTributacao ?? undefined,
    simplesNacional:         emp.regime,
    nfseProvider:            ((emp as any).nfseProvider as "el_vdc" | "issnet_df" | null) ?? undefined,
    codigoMunicipioEmitente: emp.codigoMunicipio ?? undefined,
    codigoCnae:              (emp as any).codigoCnae ?? undefined,
    tpAmb:                   ((emp as any).nfseTpAmb as "1" | "2" | null) ?? undefined,
    nfseToken:               fieldDecrypt(emp.nfseToken) || undefined,
  };
}

export const notaRouter = router({
  listar: authProc
    .input(z.object({
      emitenteId:  z.string().optional(),
      contratoId:  z.string().optional(),
      status:      z.string().optional(),
      competencia: z.string().optional(),
      page:        z.number().int().default(1),
      pageSize:    z.number().int().default(20),
    }))
    .query(async ({ input, ctx }) => {
      const emitenteFilter = whereEmitenteFilter(ctx);
      const where = {
        ...emitenteFilter,
        ...(input.emitenteId  ? { emitenteId: input.emitenteId }   : {}),
        ...(input.contratoId  ? { contratoId: input.contratoId }   : {}),
        ...(input.status      ? { status: input.status }           : {}),
        ...(input.competencia ? { competencia: input.competencia } : {}),
      };
      const [notas, total] = await Promise.all([
        prisma.notaFiscal.findMany({
          where,
          include: {
            emitente: { select: { id: true, nome: true, nfseProvider: true } },
            contrato: { select: { id: true, descricaoServico: true, tomador: { select: { nome: true } } } },
          },
          orderBy: { criadoEm: "desc" },
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
        }),
        prisma.notaFiscal.count({ where }),
      ]);
      return { notas, total, pages: Math.ceil(total / input.pageSize) };
    }),

  emitir: authProc
    .input(z.object({ contratoId: z.string(), competencia: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      const contrato = await prisma.contrato.findUniqueOrThrow({
        where:   { id: input.contratoId },
        include: { emitente: true, tomador: true },
      });
      assertEmitenteAccess(ctx, contrato.emitenteId);

      // Contratos suspensos ainda podem ter NFS-e emitida manualmente

      const competencia = input.competencia ?? (() => {
        const d = new Date();
        return `${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
      })();

      // Verificar se já emitida neste mês
      const [mm, yyyy] = competencia.split("/");
      const jaExiste = await prisma.notaFiscal.findFirst({
        where: { contratoId: input.contratoId, competencia, status: { in: ["EMITIDA", "PENDENTE"] } },
      });
      if (jaExiste) throw new Error(`Já existe nota para competência ${competencia}`);

      const nota = await prisma.notaFiscal.create({
        data: {
          contratoId:  input.contratoId,
          emitenteId:  contrato.emitenteId,
          competencia,
          valor:       contrato.valor,
          status:      "PENDENTE",
        },
      });

      try {
        const cfg = await getCfg(contrato.emitenteId);

        // Calcular vencimento com base no diaVencimento do contrato (clampado ao último dia do mês)
        const dtVenc = new Date();
        const _ultimoDia1 = new Date(dtVenc.getFullYear(), dtVenc.getMonth() + 1, 0).getDate();
        dtVenc.setDate(Math.min(contrato.diaVencimento, _ultimoDia1));
        const vencimento = dtVenc.toISOString().slice(0, 10);

        // Renderizar templates
        const templateVars = {
          competencia: competencia,
          vencimento:  vencimento,
          valor:       contrato.valor,
          emitente:    contrato.emitente.nomeFantasia || contrato.emitente.nome,
          tomador:     contrato.tomador.nome,
          servico:     contrato.nomeServico ?? undefined,
        };
        const discriminacaoRendered = renderTemplate(contrato.descricaoServico, templateVars);

        const result = await emitirNfse(contrato.emitenteId, cfg, {
          valor:         contrato.valor,
          discriminacao: discriminacaoRendered,
          tomador: {
            nome:            contrato.tomador.nome,
            cpfCnpj:         contrato.tomador.cpfCnpj,
            inscMunicipal:   contrato.tomador.inscMunicipal ?? undefined,
            endereco:        contrato.tomador.endereco ?? "Endereço não informado",
            numero:          contrato.tomador.numero ?? "S/N",
            bairro:          contrato.tomador.bairro ?? "Centro",
            cidade:          contrato.tomador.cidade ?? contrato.emitente.cidade ?? "",
            codigoMunicipio: contrato.tomador.codigoMunicipio ?? providerMunicipio(cfg),
            uf:              contrato.tomador.uf ?? contrato.emitente.uf ?? "",
            cep:             contrato.tomador.cep ?? "00000000",
            email:           contrato.tomador.email ?? undefined,
          },
          competencia:      `${yyyy}-${mm}`,
          issRetido:        contrato.issRetido || contrato.tomador.issRetido,
          itemListaServico: contrato.itemListaServico ?? undefined,
          codigoNbs:        contrato.codigoNbs ?? undefined,
          retirIr:          contrato.retirIr,
          retirCsll:        contrato.retirCsll,
          retirPis:         contrato.retirPis,
          retirCofins:      contrato.retirCofins,
        });

        const notaAtualizada = await prisma.notaFiscal.update({
          where: { id: nota.id },
          data:  dadosNotaEmitida(result),
        });
        enviarNfseSeNecessario(nota.id).catch((e) => console.error(`[NFS-e] E-mail da nota ${nota.id}:`, e));

        return notaAtualizada;
      } catch (err) {
        await prisma.notaFiscal.update({
          where: { id: nota.id },
          data: { status: "ERRO", erroMsg: String(err instanceof Error ? err.message : err).slice(0, 1000) },
        });
        throw err;
      }
    }),

  // ── Faturamento em lote ─────────────────────────────────────────────────────
  // Emite NFS-e para uma lista de contratos em uma dada competência.
  // Retorna o resultado de cada contrato (ok / pulado / erro) sem lançar exceção.
  faturarLote: authProc
    .input(z.object({
      competencia: z.string().regex(/^\d{2}\/\d{4}$/),
      contratoIds: z.array(z.string()).min(1).max(100),
    }))
    .mutation(async ({ input, ctx }) => {
      const { competencia, contratoIds } = input;
      const [mm, yyyy] = competencia.split("/");

      const emitenteFilter = whereEmitenteFilter(ctx);
      const contratos = await prisma.contrato.findMany({
        where: { id: { in: contratoIds }, ativo: true, ...emitenteFilter },
        include: { emitente: true, tomador: true },
      });

      type NfseStatus = "EMITIDA" | "PULADA" | "ERRO" | "NAO_APLICAVEL";
      type CobStatus  = "GERADA"  | "PULADA" | "ERRO";
      type ResultItem = {
        contratoId:  string;
        tomador:     string;
        emitente:    string;
        valor:       number;
        nfseStatus:  NfseStatus;
        cobStatus:   CobStatus;
        nfseNumero?: string;
        erroNfse?:   string;
        erroCob?:    string;
      };

      const resultados: ResultItem[] = [];

      for (const contrato of contratos) {
        const nfseAoFaturar = (contrato as any).nfseAoFaturar !== false;

        // Calcular vencimento clampado ao último dia do mês
        const dtVenc   = new Date();
        const ultimoDia = new Date(dtVenc.getFullYear(), dtVenc.getMonth() + 1, 0).getDate();
        dtVenc.setDate(Math.min(contrato.diaVencimento, ultimoDia));
        const vencimento = dtVenc.toISOString().slice(0, 10);

        // Verificar se já existe cobrança neste mês (critério universal de "já faturado")
        const jaTemCobranca = await prisma.cobranca.findFirst({
          where: { contratoId: contrato.id, competencia },
        });

        let nfseStatus: NfseStatus = "NAO_APLICAVEL";
        let cobStatus:  CobStatus  = "PULADA";
        let nfseNumero: string | undefined;
        let erroNfse:   string | undefined;
        let erroCob:    string | undefined;
        let notaEmitidaId: string | undefined;

        // ── NFS-e ──────────────────────────────────────────────────────────────
        if (nfseAoFaturar) {
          const jaEmitida = await prisma.notaFiscal.findFirst({
            where: { contratoId: contrato.id, competencia, status: { in: ["EMITIDA", "PENDENTE"] } },
          });

          if (jaEmitida) {
            nfseStatus = "PULADA";
            nfseNumero = jaEmitida.numero ?? undefined;
          } else {
            const nota = await prisma.notaFiscal.create({
              data: { contratoId: contrato.id, emitenteId: contrato.emitenteId, competencia, valor: contrato.valor, status: "PENDENTE" },
            });
            try {
              const cfg = await getCfg(contrato.emitenteId);
              const templateVars = {
                competencia, vencimento, valor: contrato.valor,
                emitente: contrato.emitente.nomeFantasia || contrato.emitente.nome,
                tomador:  contrato.tomador.nome,
                servico:  contrato.nomeServico ?? undefined,
              };
              const discriminacaoRendered = renderTemplate(contrato.descricaoServico, templateVars);
              const result = await emitirNfse(contrato.emitenteId, cfg, {
                valor:            contrato.valor,
                discriminacao:    discriminacaoRendered,
                tomador: {
                  nome:            contrato.tomador.nome,
                  cpfCnpj:         contrato.tomador.cpfCnpj,
                  inscMunicipal:   contrato.tomador.inscMunicipal ?? undefined,
                  endereco:        contrato.tomador.endereco ?? "Endereço não informado",
                  numero:          contrato.tomador.numero ?? "S/N",
                  bairro:          contrato.tomador.bairro ?? "Centro",
                  cidade:          contrato.tomador.cidade ?? contrato.emitente.cidade ?? "",
                  codigoMunicipio: contrato.tomador.codigoMunicipio ?? providerMunicipio(cfg),
                  uf:              contrato.tomador.uf ?? contrato.emitente.uf ?? "",
                  cep:             contrato.tomador.cep ?? "00000000",
                  email:           contrato.tomador.email ?? undefined,
                },
                competencia:      `${yyyy}-${mm}`,
                issRetido:        contrato.issRetido || contrato.tomador.issRetido,
                itemListaServico: contrato.itemListaServico ?? undefined,
                codigoNbs:        contrato.codigoNbs ?? undefined,
                retirIr:          contrato.retirIr,
                retirCsll:        contrato.retirCsll,
                retirPis:         contrato.retirPis,
                retirCofins:      contrato.retirCofins,
              });
              await prisma.notaFiscal.update({
                where: { id: nota.id },
                data:  dadosNotaEmitida(result),
              });
              nfseStatus = "EMITIDA";
              nfseNumero = result.pendente ? `DPS ${result.nDps} em processamento` : result.numero;
              if (!result.pendente) notaEmitidaId = nota.id;
            } catch (err) {
              const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
              await prisma.notaFiscal.update({ where: { id: nota.id }, data: { status: "ERRO", erroMsg: msg } });
              nfseStatus = "ERRO";
              erroNfse   = msg;
            }
          }
        }

        // ── Cobrança ───────────────────────────────────────────────────────────
        const gerarCob = (contrato as any).gerarCobrancaAuto !== false &&
                         (contrato as any).metodoCobr !== "NENHUM" &&
                         (contrato as any).metodoCobr !== "ALVARA";

        if (!gerarCob) {
          cobStatus = "PULADA";
        } else if (jaTemCobranca) {
          cobStatus = "PULADA";
        } else {
          try {
            await gerarCobrancaParaContrato(contrato, competencia, vencimento);
            cobStatus = "GERADA";
          } catch (err) {
            erroCob  = (err instanceof Error ? err.message : String(err)).slice(0, 300);
            cobStatus = "ERRO";
          }
        }

        // Depois da cobrança: se ela já tinha saído (sem a nota), a NFS-e vai avulsa
        if (notaEmitidaId) {
          enviarNfseSeNecessario(notaEmitidaId).catch((e) => console.error(`[NFS-e] E-mail da nota ${notaEmitidaId}:`, e));
        }

        resultados.push({
          contratoId: contrato.id,
          tomador:    contrato.tomador.nome,
          emitente:   contrato.emitente.nome,
          valor:      contrato.valor,
          nfseStatus, cobStatus, nfseNumero, erroNfse, erroCob,
        });
      }

      return resultados;
    }),

  cancelar: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const nota = await prisma.notaFiscal.findUniqueOrThrow({
        where: { id: input.id },
        select: { emitenteId: true, status: true, numero: true, chaveAcesso: true, xmlRetorno: true, contratoId: true, competencia: true },
      });
      assertEmitenteAccess(ctx, nota.emitenteId);
      if (nota.status !== "EMITIDA") throw new Error("Apenas notas emitidas podem ser canceladas");
      if (!nota.numero) throw new Error("Nota sem número");

      const cfg = await getCfg(nota.emitenteId);
      await cancelarNfse(cfg, nota.numero, nota.chaveAcesso, nota.xmlRetorno);

      await prisma.notaFiscal.update({
        where: { id: input.id },
        data:  { status: "CANCELADA" },
      });

      // Cancelar cobranças vinculadas (mesma competência/contrato) que não estejam pagas
      if (nota.contratoId) {
        await prisma.cobranca.updateMany({
          where: { contratoId: nota.contratoId, competencia: nota.competencia, pixStatus: { not: "PAGO" } },
          data:  { pixStatus: "CANCELADO" },
        });
        await prisma.cobranca.updateMany({
          where: { contratoId: nota.contratoId, competencia: nota.competencia, boletoStatus: { not: "PAGO" } },
          data:  { boletoStatus: "CANCELADO" },
        });
      }

      return { ok: true };
    }),

  consultar: authProc
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const nota = await prisma.notaFiscal.findUniqueOrThrow({
        where: { id: input.id },
        select: { emitenteId: true, numero: true, chaveAcesso: true, xmlRetorno: true },
      });
      assertEmitenteAccess(ctx, nota.emitenteId);
      if (!nota.numero) throw new Error("Nota sem número emitido");
      const cfg = await getCfg(nota.emitenteId);
      return nota.chaveAcesso
        ? consultarNfseChave(cfg, nota.chaveAcesso, canalDaNota(nota.xmlRetorno))
        : consultarNfse(cfg, nota.numero);
    }),

  // Verifica todas as notas EMITIDAS no E&L e marca como CANCELADA as que foram canceladas na prefeitura.
  // Cancela também as cobranças (PIX/boleto) vinculadas ao mesmo contrato e competência.
  sincronizarCanceladas: authProc.mutation(async ({ ctx }) => {
    const emitenteFilter = whereEmitenteFilter(ctx);
    const notas = await prisma.notaFiscal.findMany({
      // Só notas ABRASF: a heurística de consultarNfse marcaria nota DPS (nº nacional) como cancelada
      where:   { status: "EMITIDA", numero: { not: null }, chaveAcesso: null, ...emitenteFilter },
      include: { emitente: true },
    });

    const resultados: { id: string; numero: string; resultado: "CANCELADA" | "ATIVA" | "ERRO"; erroMsg?: string }[] = [];

    for (const nota of notas) {
      if (!nota.numero) continue;
      try {
        const cfg    = await getCfg(nota.emitenteId);
        const status = await consultarNfse(cfg, nota.numero);

        if (status.cancelada) {
          // Marcar nota como cancelada
          await prisma.notaFiscal.update({
            where: { id: nota.id },
            data:  { status: "CANCELADA" },
          });

          // Cancelar cobranças da mesma competência e contrato (se existirem)
          if (nota.contratoId) {
            await prisma.cobranca.updateMany({
              where: {
                contratoId:  nota.contratoId,
                competencia: nota.competencia,
                pixStatus:   { not: "PAGO" },
              },
              data: { pixStatus: "CANCELADO" },
            });
            await prisma.cobranca.updateMany({
              where: {
                contratoId:   nota.contratoId,
                competencia:  nota.competencia,
                boletoStatus: { not: "PAGO" },
              },
              data: { boletoStatus: "CANCELADO" },
            });
          }

          console.log(`[Sync] Nota ${nota.numero} (${nota.id}) marcada como CANCELADA`);
          resultados.push({ id: nota.id, numero: nota.numero, resultado: "CANCELADA" });
        } else {
          resultados.push({ id: nota.id, numero: nota.numero, resultado: "ATIVA" });
        }
      } catch (err: any) {
        const erroMsg = (err?.message ?? String(err)).slice(0, 200);
        console.error(`[Sync] Erro ao verificar nota ${nota.numero}: ${erroMsg}`);
        resultados.push({ id: nota.id, numero: nota.numero ?? "", resultado: "ERRO", erroMsg });
      }

      // Pequena pausa para não sobrecarregar o webservice da prefeitura
      await new Promise(r => setTimeout(r, 300));
    }

    const canceladas = resultados.filter(r => r.resultado === "CANCELADA").length;
    const erros      = resultados.filter(r => r.resultado === "ERRO").length;
    console.log(`[Sync] Sincronização concluída: ${canceladas} canceladas, ${erros} erros, ${notas.length} verificadas`);
    return { total: notas.length, canceladas, erros, resultados };
  }),

  dashboard: authProc.query(async ({ ctx }) => {
    const emitenteFilter = whereEmitenteFilter(ctx);
    const [total, emitidas, erros, valorAgg] = await Promise.all([
      prisma.notaFiscal.count({ where: emitenteFilter }),
      prisma.notaFiscal.count({ where: { ...emitenteFilter, status: "EMITIDA" } }),
      prisma.notaFiscal.count({ where: { ...emitenteFilter, status: "ERRO" } }),
      prisma.notaFiscal.aggregate({
        where:  { ...emitenteFilter, status: "EMITIDA" },
        _sum:   { valor: true },
      }),
    ]);
    return {
      total,
      emitidas,
      erros,
      valorTotal: valorAgg._sum.valor ?? 0,
    };
  }),
});
