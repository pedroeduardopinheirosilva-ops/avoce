import { describe, it, expect } from "vitest";
import { classificarConfirmacao } from "./confirmacao-reuniao.js";

describe("classificarConfirmacao", () => {
  it("reconhece confirmação como os leads realmente escrevem", () => {
    for (const t of ["sim", "Ok", "blz", "tudo certo", "confirmo sim", "pode ser",
                     "beleza, estarei lá", "👍", "combinado", "tô sim"])
      expect(classificarConfirmacao(t), t).toBe("confirmou");
  });

  it("reconhece quem avisa que não vai dar", () => {
    for (const t of ["não vai dar não", "não consigo nesse horário", "vamos remarcar",
                     "preciso desmarcar", "tive um imprevisto", "pode ser outro dia?"])
      expect(classificarConfirmacao(t), t).toBe("negou");
  });

  it("não confunde conversa comum com confirmação", () => {
    for (const t of ["quanto vou receber?", "trabalhei 3 anos lá", "meu nome é Carlos", ""])
      expect(classificarConfirmacao(t), t).toBe("nenhum");
  });

  it("negação tem prioridade sobre confirmação na mesma frase", () => {
    expect(classificarConfirmacao("ok, mas vamos remarcar")).toBe("negou");
  });
});
