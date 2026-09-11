/**
 * Instância do WhatsApp (Evolution) POR ESCRITÓRIO.
 *
 * Regra do escritório (08/09/2026): toda comunicação do Avoce com clientes e
 * propostas da PSA sai pelo número da Judite (instância `psa-docs`); a da RAP,
 * pelo número da Isabella (instância `avoce`). Antes, tudo saía pela instância
 * do "primeiro projeto de IA ativo" — que é da RAP.
 *
 * Fonte da verdade, nesta ordem:
 *   1. `Configuracao.whatsapp_evolution_<empresaId>` = JSON {baseUrl, apiKey, instancia}
 *   2. o projeto de IA ativo mais antigo DESSE escritório (IaProjetoConfig/whatsapp)
 * Sem nenhum dos dois devolve null — quem chama decide o fallback (e avisa).
 */
import { prisma } from "../db.js";
import type { EvolutionConfig } from "./evolution.js";

export const CHAVE_CONFIG_PREFIXO = "whatsapp_evolution_";

async function configDoProjeto(projetoId: string): Promise<EvolutionConfig | null> {
  const configs = await prisma.iaProjetoConfig.findMany({ where: { projetoId, categoria: "whatsapp" } });
  const get = (k: string) => configs.find((c) => c.chave === k)?.valor ?? "";
  const baseUrl = get("evolution_api_url");
  const apiKey = get("evolution_api_key");
  const instancia = get("evolution_instancia");
  if (!baseUrl || !apiKey || !instancia) return null;
  return { baseUrl, apiKey, instancia };
}

export async function getEvolutionConfigForEmpresa(empresaId?: string | null): Promise<EvolutionConfig | null> {
  if (!empresaId) return null;
  const cfg = await prisma.configuracao
    .findUnique({ where: { chave: `${CHAVE_CONFIG_PREFIXO}${empresaId}` } })
    .catch(() => null);
  if (cfg?.valor) {
    try {
      const j = JSON.parse(cfg.valor);
      if (j?.baseUrl && j?.apiKey && j?.instancia) {
        return { baseUrl: String(j.baseUrl), apiKey: String(j.apiKey), instancia: String(j.instancia) };
      }
    } catch (e) {
      console.warn(`[Evolution] ${CHAVE_CONFIG_PREFIXO}${empresaId} não é JSON válido:`, e);
    }
  }
  const projeto = await prisma.iaProjeto.findFirst({
    where: { ativo: true, empresaId },
    orderBy: { criadoEm: "asc" },
    select: { id: true },
  });
  return projeto ? configDoProjeto(projeto.id) : null;
}

/** Idem, a partir do escritório remetente (EmpresaEmitente) — Proposta/Assinatura. */
export async function getEvolutionConfigForEmitente(
  emitente: { id: string; empresaId?: string | null } | string,
): Promise<EvolutionConfig | null> {
  let empresaId = typeof emitente === "string" ? null : emitente.empresaId ?? null;
  const emitenteId = typeof emitente === "string" ? emitente : emitente.id;
  if (!empresaId) {
    const e = await prisma.empresaEmitente.findUnique({ where: { id: emitenteId }, select: { empresaId: true } });
    empresaId = e?.empresaId ?? null;
  }
  return getEvolutionConfigForEmpresa(empresaId);
}
