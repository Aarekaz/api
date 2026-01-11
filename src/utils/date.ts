export function nowIso(): string {
  return new Date().toISOString();
}

export function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function addDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
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
