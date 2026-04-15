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

export type { Context } from "./trpc.js";

export const appRouter = router({
  auth:              authRouter,
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
});

export type AppRouter = typeof appRouter;
