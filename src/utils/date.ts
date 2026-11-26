// Dates and calendar days. A "day" is a `YYYY-MM-DD` string: the calendar day
// somewhere, never an instant. docs/adr/0008-day-helpers.md.

/** A calendar day, `YYYY-MM-DD`. */
export const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Whether `value` looks like a calendar day (the shape only, not that it exists). */
export const isDay = (value: unknown): value is string => typeof value === "string" && DAY.test(value);

export function nowIso(): string {
  return new Date().toISOString();
}

/** The UTC day of an instant. */
export function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function addDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/** The day `days` after (or before) a day. */
export function shiftDay(day: string, days: number): string {
  return dateOnly(new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000));
}

/** The day of an instant at a fixed UTC offset in minutes (east positive). */
export function dayAtOffset(at: string | number | Date, offsetMinutes: number): string {
  const ms = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(at);
  return dateOnly(new Date(ms + offsetMinutes * 60_000));
}

/**
 * The day of an instant in an IANA time zone, with its summer time. Builds the
 * formatter once; throws a RangeError for a zone the runtime doesn't know.
 */
export function dayInZone(timeZone: string): (at: string | number | Date) => string {
  const format = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return (at) => {
    const parts = format.formatToParts(at instanceof Date ? at : new Date(at));
    const part = (type: string) => parts.find((p) => p.type === type)!.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  };
}

export function daysBetween(start: string, end: string): number {
  const startDate = new Date(`${start}T00:00:00Z`).getTime();
  const endDate = new Date(`${end}T00:00:00Z`).getTime();
  if (Number.isNaN(startDate) || Number.isNaN(endDate)) {
    return 0;
  }
  return Math.floor((endDate - startDate) / 86400000) + 1;
}

export function hourInTimezone(timestampMs: number, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(timestampMs));
  const hourPart = parts.find((part) => part.type === "hour");
  return hourPart ? Number(hourPart.value) : new Date(timestampMs).getUTCHours();
}
