import { describe, it, expect } from "vitest";
import { composeEndereco, mesmaPessoa, MARCADORES_PJ } from "./coleta-docs-context.js";

// Dados reais do deal cmst275t400dtzm3ggow4wtha (lead Willis, 553492948372), em que o
// fluxo coleta_docs reperguntou nome, endereço, telefone e estado civil que o cliente
// já havia mandado no dia anterior — e ainda repediu a CNH já recebida.

const COMPROVANTE_CLIENTE = {
  rg: null, uf: "MG", cep: "38160000", cpf: null,
  nome: "WILIS RODRIGUES STEIN",
  bairro: "RESID PARQUE DAS ARVORES",
  cidade: "NOVA PONTE",
  endereco: "AV DO CONTORNO 1906 CS",
  tipo_documento: "COMPROVANTE_ENDERECO",
};

// O lead manda a conta da transportadora junto como prova do caso — mesmo tipoDocumento.
const COMPROVANTE_DA_EMPRESA = {
  nome: "SCAPINI TRANSPORTE E LOGISTICA LTDA",
  endereco: "VIA ANHANGUERA, 8",
  bairro: "SAO PAULO", cidade: "SAO PAULO", uf: "SP", cep: "02775-009",
  tipo_documento: "COMPROVANTE_ENDERECO",
};

describe("composeEndereco", () => {
  it("monta o endereço completo a partir dos campos soltos do comprovante", () => {
    expect(composeEndereco(COMPROVANTE_CLIENTE)).toBe(
      "AV DO CONTORNO 1906 CS, RESID PARQUE DAS ARVORES, NOVA PONTE - MG, CEP 38160000",
    );
  });

  it("devolve null quando não há logradouro", () => {
    expect(composeEndereco({ cidade: "NOVA PONTE", uf: "MG" })).toBeNull();
  });

  it("tolera campos parciais", () => {
    expect(composeEndereco({ endereco: "RUA A, 10", cidade: "SALVADOR", uf: "BA" }))
      .toBe("RUA A, 10, SALVADOR - BA");
  });
});

describe("MARCADORES_PJ", () => {
  it("descarta o comprovante da transportadora", () => {
    expect(MARCADORES_PJ.test(COMPROVANTE_DA_EMPRESA.nome)).toBe(true);
  });

  it("não descarta o comprovante da pessoa física", () => {
    expect(MARCADORES_PJ.test(COMPROVANTE_CLIENTE.nome)).toBe(false);
  });
});

describe("mesmaPessoa", () => {
  it("casa mesmo com o OCR errando o primeiro nome", () => {
    // A CNH-e saiu como "WILL S RODRIGUES STEIN"; o comprovante, "WILIS RODRIGUES STEIN".
    expect(mesmaPessoa("WILIS RODRIGUES STEIN", "WILL S RODRIGUES STEIN")).toBe(true);
  });

  it("casa comprovante com o nome curto do contato quando há sobrenome", () => {
    expect(mesmaPessoa("WILIS RODRIGUES STEIN", "Willis Rodrigues")).toBe(true);
  });

  it("não casa pessoas diferentes", () => {
    expect(mesmaPessoa("WILIS RODRIGUES STEIN", "MARCOS PEREIRA LIMA")).toBe(false);
  });

  it("ignora acentuação", () => {
    expect(mesmaPessoa("JOSÉ ANTÔNIO GONÇALVES", "Jose Goncalves")).toBe(true);
  });

  it("não casa quando um dos lados é vazio", () => {
    expect(mesmaPessoa("", "WILIS RODRIGUES STEIN")).toBe(false);
  });
});
