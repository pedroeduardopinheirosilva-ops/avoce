export const MODULOS = [
  "dashboard",
  "painel",
  "crm",
  "whatsapp",
  "reengajamento",
  "pipedrive",
  "propostas",
  "contratos",
  "templates_documentos",
  "assinaturas",
  "faturamento",
  "notas",
  "cobrancas",
  "financeiro",
  "financeiro_editar", // mutações do financeiro gerencial (fin.*) — ver lib/fin/perm.ts
  "acordos",           // funil de acordos
  "empresas",
  "tomadores",
  "config_ia",
  "usuarios",
] as const;

export type ModuloChave = (typeof MODULOS)[number];

export type PermissoesUsuario = {
  modulos?: ModuloChave[];
  emitentes?: string[];
  empresas?: string[];
  // Admin global restrito: acesso a dados limitado a estas empresas.
  // Acesso à gestão de tenants (página Tenants) permanece irrestrito.
  empresas_full?: string[];
};
