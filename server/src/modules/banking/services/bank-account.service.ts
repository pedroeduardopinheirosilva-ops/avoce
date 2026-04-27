import { prisma } from "../../../db.js";
import type { BankProvider, Prisma } from "@prisma/client";

export interface CreateBankAccountInput {
  emitenteId:        string;
  provider:          BankProvider;
  name:              string;
  bankCode:          string;
  agency:            string;
  agencyDigit?:      string;
  account:           string;
  accountDigit?:     string;
  accountType:       string;
  pixKey?:           string;
  isDefault?:        boolean;
  externalAccountId?: string;
}

export interface UpdateBankAccountInput {
  name?:              string;
  pixKey?:            string;
  isDefault?:         boolean;
  isActive?:          boolean;
  externalAccountId?: string;
  accountType?:       string;
}

export const bankAccountService = {
  async create(input: CreateBankAccountInput) {
    // If isDefault, unset others first
    if (input.isDefault) {
      await prisma.bankAccount.updateMany({
        where: { emitenteId: input.emitenteId, isDefault: true },
        data:  { isDefault: false },
      });
    }

    return prisma.bankAccount.create({
      data: {
        emitenteId:        input.emitenteId,
        provider:          input.provider,
        name:              input.name,
        bankCode:          input.bankCode,
        agency:            input.agency,
        agencyDigit:       input.agencyDigit,
        account:           input.account,
        accountDigit:      input.accountDigit,
        accountType:       input.accountType,
        pixKey:            input.pixKey,
        isDefault:         input.isDefault ?? false,
        externalAccountId: input.externalAccountId,
      },
    });
  },

  async findAll(emitenteId: string) {
    return prisma.bankAccount.findMany({
      where:   { emitenteId, isActive: true },
      include: {
        credential: {
          select: {
            id:            true,
            credentialType: true,
            expiresAt:     true,
            isActive:      true,
            lastTestedAt:  true,
            lastTestOk:    true,
          },
        },
      },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    });
  },

  async findById(emitenteId: string, id: string) {
    return prisma.bankAccount.findFirst({
      where:   { id, emitenteId },
      include: {
        credential: {
          select: {
            id:             true,
            credentialType: true,
            expiresAt:      true,
            isActive:       true,
            lastTestedAt:   true,
            lastTestOk:     true,
          },
        },
      },
    });
  },

  async update(emitenteId: string, id: string, input: UpdateBankAccountInput) {
    // Verify ownership
    await this.findById(emitenteId, id);

    if (input.isDefault) {
      await prisma.bankAccount.updateMany({
        where: { emitenteId, isDefault: true, NOT: { id } },
        data:  { isDefault: false },
      });
    }

    return prisma.bankAccount.update({
      where: { id },
      data:  input,
    });
  },

  async deactivate(emitenteId: string, id: string) {
    await this.findById(emitenteId, id);
    return prisma.bankAccount.update({
      where: { id },
      data:  { isActive: false },
    });
  },

  async setDefault(emitenteId: string, id: string) {
    await this.findById(emitenteId, id);
    await prisma.bankAccount.updateMany({
      where: { emitenteId, isDefault: true },
      data:  { isDefault: false },
    });
    return prisma.bankAccount.update({
      where: { id },
      data:  { isDefault: true },
    });
  },

  async updateBalance(
    emitenteId: string,
    id:         string,
    balance:    number,
    date:       Date
  ) {
    await this.findById(emitenteId, id);
    return prisma.bankAccount.update({
      where: { id },
      data:  { currentBalance: balance, balanceDate: date },
    });
  },

  async getSummary(emitenteId: string) {
    const accounts = await prisma.bankAccount.findMany({
      where:  { emitenteId, isActive: true },
      select: { id: true, name: true, provider: true, currentBalance: true, balanceDate: true, isDefault: true },
    });

    const totalBalance = accounts.reduce((sum, a) => sum + Number(a.currentBalance), 0);

    return { accounts, totalBalance };
  },
};
