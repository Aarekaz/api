#!/usr/bin/env node
// Brings TV Time's full history into /v1/watch: every episode with the time you
// marked it, every film viewing, and the watchlist. Reads the GDPR export
// (tracking-prod-records-v2.csv for episodes, which holds everything the older
// tracking-prod-records.csv has; tracking-prod-records.csv for films and the
// watchlist). Writes only through the API, keyed by TV Time's own ids, so a
// second run adds nothing.
//
//   API_TOKEN=... node scripts/import-tv-time-watches.mjs --export-dir <dir>            # dry run: what would happen
//   API_TOKEN=... node scripts/import-tv-time-watches.mjs --export-dir <dir> --apply    # do it
//
// Titles already on the shelf keep their shelf row as it is (their viewings are
// added with update_item: false). Titles new to the shelf are added published,
// and their viewings move them (status, dates, diary), as if logged at the time.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
const exportDir = args[args.indexOf("--export-dir") + 1];
const apply = args.includes("--apply");
const base = process.env.API_BASE ?? "https://api.anuragd.me";
const token = process.env.API_TOKEN;
if (!exportDir || args.indexOf("--export-dir") < 0) throw new Error("--export-dir <dir> is required");
if (!token) throw new Error("API_TOKEN is required");

// ---- CSV (quoted fields, commas and newlines inside quotes)
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.length > 1 || r[0]);
  return body.map((r) => Object.fromEntries(header.map((name, index) => [name, r[index] ?? ""])));
}
const csv = async (name) => parseCsv(await readFile(join(exportDir, name), "utf8"));

// ---- API
async function api(method, path, payload) {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${typeof json === "string" ? json.slice(0, 200) : JSON.stringify(json).slice(0, 300)}`);
  return json;
}
const tagValue = (tags, key) => (tags ?? []).find((tag) => tag.startsWith(`${key}:`))?.slice(key.length + 1);
const tvTimeTime = (value) => value ? value.replace(" ", "T") + "Z" : undefined;
const yearOf = (value) => (value || "").slice(0, 4) || undefined;

// ---- Read the export
const v2 = await csv("tracking-prod-records-v2.csv");
const v1 = await csv("tracking-prod-records.csv");
const episodes = v2.filter((r) => r.key.startsWith("watch-episode-") || r.key.startsWith("rewatch-episode-"));
const userSeries = new Map(v2.filter((r) => r.key.startsWith("user-series-")).map((r) => [r.s_id, r]));
const films = v1.filter((r) => r.type === "watch" && r.entity_type === "movie");
const watchlist = v1.filter((r) => r.type === "towatch");

// TV Time sometimes holds the same episode twice in one run (a season marked again): keep the first time.
episodes.sort((a, b) => a.created_at.localeCompare(b.created_at));
const once = new Set();
const byShow = new Map();
for (const r of episodes) {
  const key = `${r.s_id}:${r.key.startsWith("rewatch-") ? 1 : 0}:${r.season_number}:${r.episode_number}`;
  // Episode 0 is TV Time's own extra (a recap or a pilot TMDB doesn't number); TMDB has no such episode.
  if (once.has(key) || !(Number(r.episode_number) > 0)) continue;
  once.add(key);
  const show = byShow.get(r.s_id) ?? { tvdb: Number(r.s_id), name: r.series_name, marks: [] };
  show.marks.push({
    season: Number(r.season_number),
    episode: Number(r.episode_number),
    watched_at: tvTimeTime(r.created_at),
    source_key: `tvtime:${r.key}`,
    run: r.key.startsWith("rewatch-") ? 1 : 0,
  });
  byShow.set(r.s_id, show);
}

// ---- What's on the shelf
const shelf = await api("GET", "/v1/shelf?type=movie,show,anime&include_unpublished=1&limit=1000&offset=0");
const showByTvdb = new Map(), filmByUuid = new Map(), filmByName = new Map();
for (const item of shelf) {
  const tvdb = tagValue(item.tags, "tv_time_show_id");
  if (tvdb) showByTvdb.set(tvdb, item);
  const uuid = tagValue(item.tags, "tv_time_uuid");
  if (uuid) filmByUuid.set(uuid, item);
  if (item.type === "movie") filmByName.set(item.title.toLowerCase(), item);
}

const plan = { showsOnShelf: 0, showsNew: [], episodesOnShelf: 0, episodesNew: 0, filmsOnShelf: 0, filmsNew: [], watchlistNew: [], unmatched: [] };

// Shows
for (const [sId, show] of byShow) {
  const existing = showByTvdb.get(sId);
  if (existing) { plan.showsOnShelf++; plan.episodesOnShelf += show.marks.length; show.item = existing; }
  else { plan.showsNew.push(show.name); plan.episodesNew += show.marks.length; }
}

// Films: TMDB search by name and release year, when not already on the shelf.
async function findFilm(name, year, alphaKey) {
  const search = async (q, y) => (await api("GET", `/v1/watch/search?type=movie&q=${encodeURIComponent(q)}${y ? `&year=${y}` : ""}`)).items?.[0];
  // TV Time's alpha key spells a title in Latin letters ("watch-alpha-zindagi-na-milegi-dobara") when the name isn't.
  const latin = alphaKey?.replace(/^(watch|follow|towatch)-alpha-/, "").replaceAll("-", " ");
  return (await search(name, year)) ?? (year ? await search(name) : undefined) ?? (latin ? await search(latin, year) : undefined);
}
for (const r of films) {
  const existing = filmByUuid.get(r.uuid) ?? filmByName.get(r.movie_name.toLowerCase());
  if (existing) { plan.filmsOnShelf++; r.item = existing; continue; }
  const match = await findFilm(r.movie_name, yearOf(r.release_date), r.alpha_range_key);
  if (match) { r.match = match; plan.filmsNew.push(`${r.movie_name} → ${match.title} (${match.year ?? "?"})${match.item_id ? " [on shelf]" : ""}`); }
  else plan.unmatched.push(`film: ${r.movie_name}`);
}
for (const r of watchlist) {
  const name = r.movie_name || r.series_name;
  const year = yearOf(r.release_date);
  const match = r.entity_type === "movie" ? await findFilm(name, year, r.alpha_range_key) : undefined;
  if (match) { r.match = match; plan.watchlistNew.push(`${name} → ${match.title} (${match.year ?? "?"})${match.item_id ? " [on shelf]" : ""}`); }
  else plan.unmatched.push(`watchlist: ${name}`);
}

console.log(JSON.stringify({
  mode: apply ? "apply" : "dry run",
  shows_on_shelf: plan.showsOnShelf, episodes_for_them: plan.episodesOnShelf,
  shows_new: plan.showsNew.length, episodes_for_new: plan.episodesNew, new_show_names: plan.showsNew,
  films_on_shelf: plan.filmsOnShelf, films_new: plan.filmsNew,
  watchlist: plan.watchlistNew, unmatched: plan.unmatched,
}, null, 2));
if (!apply) process.exit(0);

// ---- Apply
const log = (...parts) => console.log(...parts);

// 1. Warm TMDB details (and episodes) for what's already on the shelf.
for (const item of args.includes("--no-warm") ? [] : shelf.filter((i) => i.type === "movie" || i.type === "show")) {
  try { await api("GET", `/v1/watch/titles/${item.id}`); } catch (error) { log("warm failed", item.title, error.message); }
}
log("warmed", shelf.length);

// 2. Shows.
for (const [sId, show] of byShow) {
  try {
    const series = userSeries.get(sId);
    let itemId = show.item?.id;
    let fresh = false;
    if (!itemId) {
      const status = series?.is_for_later === "true" ? "want_to_watch" : series?.is_archived === "true" ? "dropped" : undefined;
      const added = await api("POST", "/v1/watch/titles", { tvdb_id: show.tvdb, status, published: true, source: "tv-time", added_at: tvTimeTime(series?.created_at), tags: [`tv_time_show_id:${sId}`] });
      itemId = added.id;
      fresh = added.created && status !== "dropped";
      await api("GET", `/v1/watch/titles/${itemId}`);
    }
    for (const run of [0, 1]) {
      const marks = show.marks.filter((m) => m.run === run).map(({ run: _run, ...mark }) => mark);
      for (let i = 0; i < marks.length; i += 1000) {
        const res = await api("POST", `/v1/watch/titles/${itemId}/episodes`, { episodes: marks.slice(i, i + 1000), source: "tvtime", run, update_item: fresh });
        log(show.name, run ? "rewatch" : "", `+${res.added}`);
      }
    }
  } catch (error) { log("show failed", show.name, error.message); }
}

// 3. Films.
for (const r of films) {
  try {
    let itemId = r.item?.id ?? r.match?.item_id;
    const fresh = !itemId;
    if (!itemId) {
      if (!r.match) continue;
      itemId = (await api("POST", "/v1/watch/titles", { media_type: "movie", tmdb_id: r.match.tmdb_id, published: true, source: "tv-time", added_at: tvTimeTime(r.created_at), tags: [`tv_time_uuid:${r.uuid}`] })).id;
    }
    const res = await api("POST", `/v1/watch/films/${itemId}/watched`, { watched_at: tvTimeTime(r.created_at), source: "tvtime", source_key: `tvtime:${r["type-uuid-n"]}`, update_item: fresh });
    log(r.movie_name, `+${res.added}`);
  } catch (error) { log("film failed", r.movie_name, error.message); }
}

// 4. The watchlist.
for (const r of watchlist) {
  try {
    if (!r.match || r.match.item_id) continue;
    await api("POST", "/v1/watch/titles", { media_type: "movie", tmdb_id: r.match.tmdb_id, status: "want_to_watch", published: true, source: "tv-time", added_at: tvTimeTime(r.created_at) });
    log("to watch", r.movie_name);
  } catch (error) { log("watchlist failed", r.movie_name, error.message); }
}
log("done");
