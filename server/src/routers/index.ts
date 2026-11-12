import { router }                        from "./trpc.js";
import { authRouter }                    from "./auth.js";
import { empresaRouter }                 from "./empresas.js";
import { tomadorRouter }                 from "./tomadores.js";
import { contratoRouter }               from "./contratos.js";
import { notaRouter }                    from "./notas.js";
import { cobrancaRouter }               from "./cobranca.js";
import { propostaRouter }               from "./propostas.js";
import { templateDocumentoRouter }      from "./templateDocumentos.js";
import { crmRouter }                    from "./crm.js";
import { iaRouter }                     from "./ia.js";
import { pipedriveRouter }              from "./pipedrive.js";
import { reengajamentoRouter }          from "./reengajamento.js";
import { financeiroRouter }             from "./financeiro.js";
import { finGerencialRouter }           from "./finGerencial.js";
import { bankingRouter }               from "../modules/banking/banking.router.js";
import { marketingAutopilotRouter }    from "./marketingAutopilot.js";
import { ligacoesRouter }              from "./ligacoes.js";
import { reunioesRouter }              from "./reunioes.js";
import { agendaRouter }               from "./agenda.js";
import { tenantRouter }               from "./tenants.js";
import { assinaturaRouter }           from "./assinaturas.js";
import { painelRouter }               from "./painel.js";
import { audienciaRouter }            from "./audiencia.js";
import { motoresRouter }              from "./motores.js";
import { metaCapiRouter }             from "./metaCapi.js";
import { metaSocialRouter }           from "./metaSocial.js";
import { disparosRouter }             from "./disparos.js";
import { acordosRouter }              from "./acordos.js";
import { recebimentosRouter }         from "./recebimentos.js";

export type { Context } from "./trpc.js";

export const appRouter = router({
  auth:              authRouter,
  tenant:            tenantRouter,
  empresa:           empresaRouter,
  tomador:           tomadorRouter,
  contrato:          contratoRouter,
  nota:              notaRouter,
  cobranca:          cobrancaRouter,
  proposta:          propostaRouter,
  templateDocumento: templateDocumentoRouter,
  crm:               crmRouter,
  ia:                iaRouter,
  pipedrive:         pipedriveRouter,
  reengajamento:     reengajamentoRouter,
  financeiro:        financeiroRouter,
  fin:               finGerencialRouter,
  banking:           bankingRouter,
  mkt:               marketingAutopilotRouter,
  ligacoes:          ligacoesRouter,
  reunioes:          reunioesRouter,
  agenda:            agendaRouter,
  assinatura:        assinaturaRouter,
  painel:            painelRouter,
  audiencia:         audienciaRouter,
  motores:           motoresRouter,
  metaCapi:          metaCapiRouter,
  metaSocial:        metaSocialRouter,
  disparos:          disparosRouter,
  acordos:           acordosRouter,
  recebimentos:      recebimentosRouter,
});

export type AppRouter = typeof appRouter;
