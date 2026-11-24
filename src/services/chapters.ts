// Chapters: a life's eras, read from where the hours went. For each month the
// place with the most hours is home; months with the same home (within 500 m)
// run together into a chapter. Up to four months elsewhere between two stretches
// of the same home is a blip (a trip, a summer), not a chapter of its own.

export type MonthPlace = {
  mo: string; key: string; hours: number; n: number; lat: number; lng: number;
  name: string | null; city: string | null; country: string | null;
  /** The kind of a place you saved (home, work…), when the spot is one. */
  saved?: string;
};
export type MonthCount = { mo: string; n: number };
/** A place you defined: everything inside the circle, in its months, is this place. */
export type SavedPlace = {
  id: number; name: string; kind: string; latitude: number; longitude: number; radius_m: number;
  starts_on: string | null; ends_on: string | null;
};

/** Whether a saved place applies in a month ("2019-04"); dates are "YYYY-MM" or "YYYY-MM-DD". */
export function savedCovers(p: SavedPlace, mo: string) {
  return (!p.starts_on || mo >= p.starts_on.slice(0, 7)) && (!p.ends_on || mo <= p.ends_on.slice(0, 7));
}

/** Folds each month's spots inside a saved place into one spot named for it. */
export function applySaved(rows: MonthPlace[], saved: SavedPlace[]): MonthPlace[] {
  if (!saved.length) return rows;
  const merged = new Map<string, MonthPlace>();
  for (const r of rows) {
    const p = saved
      .filter((s) => savedCovers(s, r.mo) && km(r, { lat: s.latitude, lng: s.longitude }) * 1000 <= s.radius_m)
      .sort((a, b) => a.radius_m - b.radius_m)[0];
    const row = p ? { ...r, key: `saved:${p.id}`, name: p.name, lat: p.latitude, lng: p.longitude, saved: p.kind } : r;
    const id = `${row.mo}|${row.key}`;
    const into = merged.get(id);
    if (into) { into.hours += row.hours; into.n += row.n; into.city ??= row.city; into.country ??= row.country; }
    else merged.set(id, { ...row });
  }
  return [...merged.values()].sort((a, b) => a.mo.localeCompare(b.mo) || b.hours - a.hours);
}
export type MonthMode = { mo: string; mode: string; m: number };

export type ChapterPlace = {
  key: string; name: string | null; city: string | null; country: string | null;
  lat: number; lng: number; hours: number; visits: number;
};
export type Chapter = {
  start: string; end: string; months: number;
  city: string | null; country: string | null;
  home: ChapterPlace;
  /** Where most days went, away from home (school, work), if anywhere stands out. */
  anchor: ChapterPlace | null;
  /** The other places you spent the most time, home and anchor left out. */
  haunts: ChapterPlace[];
  visits: number; newPlaces: number;
  km: number; modes: Array<{ mode: string; km: number }>;
};

const R = 6371;
export function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function monthsBetween(a: string, b: string) {
  const [ay, am] = a.split("-").map(Number), [by, bm] = b.split("-").map(Number);
  return (by - ay) * 12 + (bm - am);
}

/** "Nepal" as a city is the country leaking in; prefer a real city from the same stretch. */
function cityOf(places: ChapterPlace[]) {
  const counts = new Map<string, number>();
  for (const p of places) {
    if (!p.city || p.city === p.country) continue;
    counts.set(p.city, (counts.get(p.city) ?? 0) + p.hours);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** A month's home: the spot whose neighbourhood (300 m) holds the most hours,
 *  since one home is often several neighbouring keys. */
function homeOf(list: MonthPlace[]) {
  // A home you saved for this month wins over any guess.
  const saved = list.filter((p) => p.saved === "home").sort((a, b) => b.hours - a.hours)[0];
  if (saved) return saved;
  let best = list[0], bestHours = -1;
  for (const p of list) {
    const around = list.reduce((s, q) => s + (km(p, q) < 0.3 ? q.hours : 0), 0);
    if (around > bestHours || (around === bestHours && p.hours > best.hours)) { best = p; bestHours = around; }
  }
  return best;
}

type Run = { start: string; end: string; homes: MonthPlace[]; months: string[] };

export function buildChapters(rows: MonthPlace[], visits: MonthCount[], fresh: MonthCount[], modes: MonthMode[]): Chapter[] {
  const kinds = new Map(rows.filter((r) => r.saved).map((r) => [r.key, r.saved!]));
  const byMonth = new Map<string, MonthPlace[]>();
  for (const r of rows) byMonth.set(r.mo, [...(byMonth.get(r.mo) ?? []), r]);
  const months = [...byMonth.keys()].sort();

  // 1. Runs of months that share a home.
  const runs: Run[] = [];
  for (const mo of months) {
    const top = homeOf(byMonth.get(mo)!);
    const last = runs[runs.length - 1];
    const sameHome = last && km(last.homes[0], top) < 0.5 && monthsBetween(last.end, mo) <= 6;
    if (sameHome) { last.end = mo; last.homes.push(top); last.months.push(mo); }
    else runs.push({ start: mo, end: mo, homes: [top], months: [mo] });
  }

  // 2. Fold blips (≤ 4 months: a trip, a summer, a thin stretch of data) into the run before them when the run after returns to the same home,
  //    and fold any lone short run into its neighbour so a chapter is never a single stray month.
  for (let i = 1; i < runs.length - 1; i++) {
    const [a, b, c] = [runs[i - 1], runs[i], runs[i + 1]];
    if (b.months.length <= 4 && km(a.homes[0], c.homes[0]) < 0.5) {
      a.end = c.end; a.months.push(...b.months, ...c.months); a.homes.push(...c.homes);
      runs.splice(i, 2); i--;
    }
  }
  for (let i = runs.length - 1; i >= 0 && runs.length > 1; i--) {
    if (runs[i].months.length > 1) continue;
    const into = i > 0 ? runs[i - 1] : runs[i + 1];
    into.months.push(...runs[i].months); into.months.sort();
    into.start = into.months[0]; into.end = into.months[into.months.length - 1];
    runs.splice(i, 1);
  }

  const visitsBy = new Map(visits.map((v) => [v.mo, v.n]));
  const freshBy = new Map(fresh.map((v) => [v.mo, v.n]));

  return runs.map((run) => {
    // Every place in the chapter's months, hours added up.
    const totals = new Map<string, ChapterPlace>();
    for (const mo of run.months) for (const r of byMonth.get(mo) ?? []) {
      const t = totals.get(r.key) ?? { key: r.key, name: r.name, city: r.city, country: r.country, lat: r.lat, lng: r.lng, hours: 0, visits: 0 };
      t.hours += r.hours; t.visits += r.n;
      totals.set(r.key, t);
    }
    const all = [...totals.values()].sort((a, b) => b.hours - a.hours);
    const centre = run.homes[Math.floor(run.homes.length / 2)];
    const home = all.find((p) => p.key === centre.key) ?? all.find((p) => km(p, centre) < 0.3) ?? all[0];
    // Away from home but in the same part of the world: a visit back to an old city isn't a haunt here.
    const away = all.filter((p) => km(p, home) >= 0.5 && km(p, home) < 50);
    // An anchor is somewhere you kept going back to: at least ten visits and a real share of the days.
    // A work or school you saved is the anchor whenever it has time in this chapter.
    const savedAnchor = away.find((p) => p.key.startsWith("saved:") && kinds.get(p.key) && ["work", "school"].includes(kinds.get(p.key)!));
    const anchorPick = savedAnchor ?? [...away].sort((a, b) => b.visits - a.visits)[0];
    const anchor = anchorPick && (savedAnchor || anchorPick.visits >= 10) ? anchorPick : null;
    // One entry per named place (a campus can span several keys), the anchor left out.
    const seen = new Set([anchor?.name?.trim().toLowerCase()]);
    const haunts = away.filter((p) => {
      const name = p.name?.trim().toLowerCase();
      if (p.key === anchor?.key || p.visits < 2 || !name || seen.has(name)) return false;
      seen.add(name);
      return true;
    }).slice(0, 6);

    const modeKm = new Map<string, number>();
    for (const m of modes) if (m.mo >= run.start && m.mo <= run.end) modeKm.set(m.mode, (modeKm.get(m.mode) ?? 0) + m.m / 1000);
    const modeList = [...modeKm.entries()].map(([mode, k]) => ({ mode, km: Math.round(k) })).filter((m) => m.km > 0).sort((a, b) => b.km - a.km);

    return {
      start: run.start, end: run.end, months: monthsBetween(run.start, run.end) + 1,
      city: (home.city && home.city !== home.country ? home.city : null) ?? cityOf(all), country: home.country ?? all.find((p) => p.country)?.country ?? null,
      home: { ...home, hours: Math.round(home.hours) },
      anchor: anchor ? { ...anchor, hours: Math.round(anchor.hours) } : null,
      haunts: haunts.map((h) => ({ ...h, hours: Math.round(h.hours) })),
      visits: run.months.reduce((s, mo) => s + (visitsBy.get(mo) ?? 0), 0),
      newPlaces: run.months.reduce((s, mo) => s + (freshBy.get(mo) ?? 0), 0),
      km: modeList.filter((m) => m.mode !== "flying").reduce((s, m) => s + m.km, 0),
      modes: modeList,
    };
  });
}
