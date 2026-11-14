import { describe, it, expect } from "vitest";
import { caminhoColetor, ARQUIVOS_COLETOR } from "./coletor-dist.js";

describe("caminhoColetor", () => {
  it.each(ARQUIVOS_COLETOR)("permite %s dentro do diretório", (nome) => {
    expect(caminhoColetor(nome, "/opt/x/dist")).toBe(`/opt/x/dist/${nome}`);
  });
  it.each(["../server/.env", "..%2F..%2Fetc%2Fpasswd", "../../etc/passwd", "coletor-linux", "", ".env", "coletor-mac-arm64/../../x", "/etc/passwd"])(
    "rejeita %s", (nome) => {
      expect(caminhoColetor(nome, "/opt/x/dist")).toBeNull();
    });
});
