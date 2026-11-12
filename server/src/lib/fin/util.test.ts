import { describe, it, expect } from "vitest";
import { addMesesData, deCentavos, deDataCal, diasEntre, paraCentavos, paraDataCal, aplicarBp, paraBp } from "./util.js";

describe("util — dinheiro", () => {
  it("paraCentavos sem float acumulado", () => {
    expect(paraCentavos("1234.5")).toBe(123450);
    expect(paraCentavos("0.005")).toBe(1);
    expect(paraCentavos("-12.34")).toBe(-1234);
    expect(paraCentavos("10,90")).toBe(1090);
    expect(paraCentavos(0.1 + 0.2)).toBe(30);
    expect(paraCentavos({ toString: () => "99.99" })).toBe(9999);
    expect(paraCentavos(null)).toBe(0);
    expect(() => paraCentavos("abc")).toThrow();
  });
  it("deCentavos", () => {
    expect(deCentavos(123450)).toBe("1234.50");
    expect(deCentavos(-5)).toBe("-0.05");
    expect(deCentavos(0)).toBe("0.00");
  });
  it("percentual em pontos-base", () => {
    expect(paraBp("33.33")).toBe(3333);
    expect(aplicarBp(33333, 3000)).toBe(10000); // 9999,9 → 10000
  });
});

describe("util — datas-calendário", () => {
  it("lê o Date no fuso America/Bahia (UTC−3)", () => {
    expect(paraDataCal(new Date("2025-06-01T02:00:00Z"))).toBe("2025-05-31");
    expect(paraDataCal(new Date("2025-06-01T03:00:00Z"))).toBe("2025-06-01");
    expect(paraDataCal(deDataCal("2025-06-01"))).toBe("2025-06-01");
  });
  it("addMesesData ajusta fim de mês", () => {
    expect(addMesesData("2025-01-31", 1)).toBe("2025-02-28");
    expect(addMesesData("2024-01-31", 1)).toBe("2024-02-29");
    expect(addMesesData("2025-11-15", 3)).toBe("2026-02-15");
  });
  it("diasEntre", () => {
    expect(diasEntre("2025-06-01", "2025-07-01")).toBe(30);
  });
});
