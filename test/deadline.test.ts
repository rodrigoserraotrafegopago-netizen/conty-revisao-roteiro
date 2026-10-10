import { describe, expect, it } from "vitest";
import { BRAND_TIMEZONE, civilDate, isValidCivilDate, isWithinDueDate } from "../src/deadline.ts";

describe("dia civil no fuso da marca", () => {
  it("23:59:59.999 em São Paulo ainda é o mesmo dia, mesmo com o UTC já no dia seguinte", () => {
    expect(civilDate(new Date("2026-03-13T02:59:59.999Z"), BRAND_TIMEZONE)).toBe("2026-03-12");
  });

  it("00:00:00.000 em São Paulo já é o dia seguinte", () => {
    expect(civilDate(new Date("2026-03-13T03:00:00.000Z"), BRAND_TIMEZONE)).toBe("2026-03-13");
  });
});

describe("prazo", () => {
  it("vale até o último instante do dia do prazo", () => {
    expect(isWithinDueDate("2026-03-12", new Date("2026-03-13T02:59:59.999Z"), BRAND_TIMEZONE)).toBe(true);
  });

  it("não vale no primeiro instante do dia seguinte", () => {
    expect(isWithinDueDate("2026-03-12", new Date("2026-03-13T03:00:00.000Z"), BRAND_TIMEZONE)).toBe(false);
  });

  it("aceita só datas que existem no calendário", () => {
    expect(isValidCivilDate("2026-03-12")).toBe(true);
    expect(isValidCivilDate("2028-02-29")).toBe(true);
    expect(isValidCivilDate("2026-02-29")).toBe(false);
    expect(isValidCivilDate("2026-02-30")).toBe(false);
    expect(isValidCivilDate("12/03/2026")).toBe(false);
    expect(isValidCivilDate("2026-3-12")).toBe(false);
  });
});
