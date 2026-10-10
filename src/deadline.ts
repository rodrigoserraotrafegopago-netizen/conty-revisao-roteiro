// O prazo é um dia civil no fuso da marca e vale até o último instante desse dia.
// Por isso a comparação é entre dias civis em São Paulo, nunca entre datas UTC:
// 23:30 de 12/03 em São Paulo já é 13/03 em UTC, e o prazo de 12/03 ainda vale.

export const BRAND_TIMEZONE = "America/Sao_Paulo";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function civilDate(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

// AAAA-MM-DD que existe no calendário: 2026-02-30 não passa.
export function isValidCivilDate(value: string): boolean {
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function isWithinDueDate(dueDate: string, instant: Date, timeZone: string): boolean {
  return civilDate(instant, timeZone) <= dueDate;
}

export function describeDueDate(dueDate: string, timeZone: string): string {
  return `vale até 23:59:59.999 de ${dueDate} em ${timeZone}`;
}
