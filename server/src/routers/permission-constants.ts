export const MODULOS = [
  "dashboard",
  "crm",
  "whatsapp",
  "reengajamento",
  "pipedrive",
  "propostas",
  "contratos",
  "templates_documentos",
  "faturamento",
  "notas",
  "cobrancas",
  "financeiro",
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
