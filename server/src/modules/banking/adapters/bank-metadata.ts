import type { BankProvider } from "@prisma/client";

export interface BankMeta {
  name:    string;
  code:    string;
  logoUrl: string;
}

export const BANK_METADATA: Record<BankProvider, BankMeta> = {
  SICOOB:   { name: "Sicoob",   code: "756", logoUrl: "/assets/banks/sicoob.svg" },
  BRADESCO: { name: "Bradesco", code: "237", logoUrl: "/assets/banks/bradesco.svg" },
  INTER:    { name: "Inter",    code: "077", logoUrl: "/assets/banks/inter.svg" },
  BTG:      { name: "BTG Pactual", code: "208", logoUrl: "/assets/banks/btg.svg" },
};
