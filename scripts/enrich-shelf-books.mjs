#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

const DEFAULT_API_BASE_URL = "https://api.anuragd.me";
const DEFAULT_OUT_FILE = "tmp/book-shelf-enrichment-preview.json";
const DEFAULT_GOODREADS_EXPORT_DIR = "/Users/aarekaz/Downloads/apple-books-goodreads-export";
const DEFAULT_GOODREADS_USER_ID = "201901201";
const DEFAULT_GOODREADS_SHELVES = ["read", "currently-reading", "to-read"];
const REQUEST_DELAY_MS = 140;
const FETCH_TIMEOUT_MS = 18_000;
const DEFAULT_MIN_SCORE = 75;
const BAD_GOODREADS_TITLE_PHRASES = [
  "summary",
  "summary of",
  "summary:",
  "summary -",
  "summary and analysis",
  "analysis of",
  "workbook",
  "study guide",
  "audiobook",
  "audio trilogy",
  "conversation starters",
  "companion",
  "key takeaways",
  "successnotes",
  "success notes",
  "cosmic summary",
  "supersummary",
];
const KNOWN_BAD_GOODREADS_BOOK_IDS = new Set([
  "114682259",
  "55428427",
  "51394531",
  "54159824",
  "122026760",
  "56582802",
  "35912448",
  "60684769",
  "96513103",
  "56363442",
  "48509544",
  "57177765",
  "36613555",
  "25375881",
]);

const args = parseArgs(process.argv.slice(2));
await loadEnvFiles([...args.envFiles, ".env.local", ".dev.vars", ".env"]);

if (args.help) {
  printUsage();
  process.exit(0);
}

const apiBaseUrl = normalizeApiBaseUrl(
  args.apiUrl ?? process.env.API_BASE_URL ?? process.env.API_URL ?? DEFAULT_API_BASE_URL,
);
const apiToken = args.token ?? process.env.API_TOKEN;
const outFile = resolve(args.out ?? DEFAULT_OUT_FILE);
const goodreadsExportDir = resolve(args.goodreadsExportDir ?? DEFAULT_GOODREADS_EXPORT_DIR);
const goodreadsUserId = args.goodreadsUserId ?? process.env.GOODREADS_USER_ID ?? DEFAULT_GOODREADS_USER_ID;
const goodreadsShelves = args.goodreadsShelves ?? DEFAULT_GOODREADS_SHELVES;

if (!apiToken) {
  throw new Error("Missing API_TOKEN. Set it in an env file or pass --token.");
}

const shelfItems = await fetchExistingShelfItems(apiBaseUrl, apiToken);
const books = shelfItems
  .filter(isBook)
  .filter((item) => args.onlyMissing ? !item.image_url : true)
  .slice(0, args.limit ?? shelfItems.length);
const isbnIndex = await buildIsbnIndex(goodreadsExportDir);
const goodreadsIndex = args.skipGoodreads
  ? { byExactKey: new Map(), byTitleKey: new Map(), records: [], count: 0, shelves: [] }
  : await buildGoodreadsIndex({ userId: goodreadsUserId, shelves: goodreadsShelves });

const matches = [];
for (const item of books) {
  const match = await enrichBook(item, { isbnIndex, goodreadsIndex });
  matches.push(match);
  await delay(REQUEST_DELAY_MS);
}

const matched = matches.filter((match) => match.status === "matched" && match.cover_url);
const patchable = matched.filter((match) => shouldPatchMatch(match, args.minScore));
const preview = {
  source: "goodreads_rss_google_books_viewapi_and_openlibrary",
  generated_at: new Date().toISOString(),
  mode: args.commit ? "commit" : "dry-run",
  api_url: apiBaseUrl,
  goodreads_export_dir: goodreadsExportDir,
  goodreads_user_id: args.skipGoodreads ? null : goodreadsUserId,
  goodreads_shelves: args.skipGoodreads ? [] : goodreadsShelves,
  stats: {
    shelf_items: shelfItems.length,
    books_checked: books.length,
    isbn_keys: isbnIndex.size,
    goodreads_books: goodreadsIndex.count,
    matched: matched.length,
    patchable: patchable.length,
    min_score: args.minScore,
    unmatched: matches.length - matched.length,
  },
  matches,
};

if (args.commit) {
  preview.patch_result = await patchMatchedItems({
    apiBaseUrl,
    apiToken,
    matches: patchable,
  });
}

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, `${JSON.stringify(preview, null, 2)}\n`);

console.log(`${args.commit ? "Book enrichment complete" : "Book enrichment dry run complete"}`);
console.log(`  Checked: ${preview.stats.books_checked}`);
console.log(`  Matched: ${preview.stats.matched}`);
console.log(`  Unmatched: ${preview.stats.unmatched}`);
if (preview.patch_result) {
  console.log(`  Patched: ${preview.patch_result.patched.length}`);
  console.log(`  Failed: ${preview.patch_result.failed.length}`);
}
console.log(`Preview written to ${outFile}`);

function parseArgs(argv) {
  const parsed = {
    commit: false,
    envFiles: [],
    help: false,
    limit: null,
    minScore: DEFAULT_MIN_SCORE,
    onlyMissing: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--commit") parsed.commit = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--only-missing") parsed.onlyMissing = true;
    else if (arg === "--skip-goodreads") parsed.skipGoodreads = true;
    else if (arg === "--env-file") {
      parsed.envFiles.push(requireValue(arg, next));
      index += 1;
    } else if (arg.startsWith("--env-file=")) {
      parsed.envFiles.push(arg.slice("--env-file=".length));
    } else if (arg === "--goodreads-export-dir") {
      parsed.goodreadsExportDir = requireValue(arg, next);
      index += 1;
    } else if (arg.startsWith("--goodreads-export-dir=")) {
      parsed.goodreadsExportDir = arg.slice("--goodreads-export-dir=".length);
    } else if (arg === "--goodreads-user-id") {
      parsed.goodreadsUserId = requireValue(arg, next);
      index += 1;
    } else if (arg.startsWith("--goodreads-user-id=")) {
      parsed.goodreadsUserId = arg.slice("--goodreads-user-id=".length);
    } else if (arg === "--goodreads-shelves") {
      parsed.goodreadsShelves = parseShelfList(requireValue(arg, next));
      index += 1;
    } else if (arg.startsWith("--goodreads-shelves=")) {
      parsed.goodreadsShelves = parseShelfList(arg.slice("--goodreads-shelves=".length));
    } else if (arg === "--out") {
      parsed.out = requireValue(arg, next);
      index += 1;
    } else if (arg.startsWith("--out=")) {
      parsed.out = arg.slice("--out=".length);
    } else if (arg === "--api-url") {
      parsed.apiUrl = requireValue(arg, next);
      index += 1;
    } else if (arg.startsWith("--api-url=")) {
      parsed.apiUrl = arg.slice("--api-url=".length);
    } else if (arg === "--token") {
      parsed.token = requireValue(arg, next);
      index += 1;
    } else if (arg.startsWith("--token=")) {
      parsed.token = arg.slice("--token=".length);
    } else if (arg === "--limit") {
      parsed.limit = parsePositiveInteger(requireValue(arg, next));
      index += 1;
    } else if (arg.startsWith("--limit=")) {
      parsed.limit = parsePositiveInteger(arg.slice("--limit=".length));
    } else if (arg === "--min-score") {
      parsed.minScore = parsePositiveNumber(requireValue(arg, next));
      index += 1;
    } else if (arg.startsWith("--min-score=")) {
      parsed.minScore = parsePositiveNumber(arg.slice("--min-score=".length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function printUsage() {
  console.log(`
Usage:
  npm run enrich:shelf-books -- [options]

Options:
  --env-file <path>                Optional env file to read before .env.local/.env
  --goodreads-export-dir <path>    Directory with Goodreads/Apple Books helper CSVs
  --goodreads-user-id <id>         Goodreads user id for public RSS shelves (default: ${DEFAULT_GOODREADS_USER_ID})
  --goodreads-shelves <list>       Comma list of Goodreads shelves (default: ${DEFAULT_GOODREADS_SHELVES.join(",")})
  --skip-goodreads                 Skip Goodreads RSS and use only ISBN/Open Library enrichment
  --out <path>                     Preview JSON path (default: ${DEFAULT_OUT_FILE})
  --commit                         PATCH matched shelf items with cover/page metadata
  --only-missing                   Only check books missing image_url
  --api-url <url>                  API base URL (default: ${DEFAULT_API_BASE_URL})
  --token <token>                  API bearer token (or set API_TOKEN)
  --limit <number>                 Limit books checked, useful for testing
  --min-score <number>             Minimum match score patched with --commit (default: ${DEFAULT_MIN_SCORE})
`);
}

async function enrichBook(item, { isbnIndex, goodreadsIndex }) {
  const goodreads = findGoodreadsBook(item, goodreadsIndex);
  if (goodreads?.book_large_image_url) {
    const pageCount = reliablePageCount(goodreads.num_pages);
    return baseMatch(item, {
      status: "matched",
      match_method: goodreads.match_method,
      score: goodreads.score,
      isbn: goodreads.isbn ?? isbnIndex.get(bookKey(item.title, item.author)) ?? null,
      cover_url: goodreads.book_large_image_url,
      page_count: pageCount,
      year: goodreads.book_published ?? null,
      metadata: {
        ...(item.metadata ?? {}),
        book_cover_source: "goodreads_rss",
        book_cover_checked_at: new Date().toISOString(),
        goodreads_book_id: goodreads.book_id ?? null,
        goodreads_review_url: goodreads.link ?? null,
        goodreads_shelf: goodreads.shelf ?? null,
        book_image_url: goodreads.book_image_url ?? null,
        book_small_image_url: goodreads.book_small_image_url ?? null,
        book_medium_image_url: goodreads.book_medium_image_url ?? null,
        book_large_image_url: goodreads.book_large_image_url,
        isbn: goodreads.isbn ?? undefined,
        page_count: pageCount ?? undefined,
        num_pages: pageCount ?? undefined,
        published_year: goodreads.book_published ?? undefined,
        average_rating: goodreads.average_rating ?? undefined,
        goodreads_user_rating: goodreads.user_rating ?? undefined,
        goodreads_user_read_at: goodreads.user_read_at ?? undefined,
        goodreads_user_date_added: goodreads.user_date_added ?? undefined,
      },
    });
  }

  const isbn = isbnIndex.get(bookKey(item.title, item.author));
  if (isbn) {
    const google = await fetchGoogleBooksViewApiCover(isbn);
    if (google.cover_url) {
      return baseMatch(item, {
        status: "matched",
        match_method: "isbn_google_books_viewapi",
        score: 100,
        isbn,
        cover_url: google.cover_url,
        metadata: {
          ...(item.metadata ?? {}),
          book_cover_source: "google_books_viewapi",
          book_cover_checked_at: new Date().toISOString(),
          google_books_bibkey: google.bib_key ?? `ISBN:${isbn}`,
          google_books_id: google.google_books_id ?? null,
          cover_width: google.cover_width ?? undefined,
          cover_height: google.cover_height ?? undefined,
          isbn,
        },
      });
    }
  }

  const openLibrary = await searchOpenLibrary(item);
  if (openLibrary.cover_url) {
    const google = openLibrary.isbn ? await fetchGoogleBooksViewApiCover(openLibrary.isbn) : {};
    const coverUrl = google.cover_url ?? openLibrary.cover_url;
    const coverSource = google.cover_url ? "google_books_viewapi" : "openlibrary";
    return baseMatch(item, {
      status: "matched",
      match_method: openLibrary.match_method,
      score: openLibrary.score,
      isbn: openLibrary.isbn ?? isbn ?? null,
      cover_url: coverUrl,
      page_count: openLibrary.page_count ?? null,
      year: openLibrary.year ?? null,
      metadata: {
        ...(item.metadata ?? {}),
        book_cover_source: coverSource,
        book_cover_checked_at: new Date().toISOString(),
        google_books_bibkey: google.bib_key ?? null,
        google_books_id: google.google_books_id ?? null,
        cover_width: google.cover_width ?? undefined,
        cover_height: google.cover_height ?? undefined,
        openlibrary_key: openLibrary.key ?? null,
        openlibrary_cover_id: openLibrary.cover_id ?? null,
        isbn: openLibrary.isbn ?? isbn ?? null,
        page_count: openLibrary.page_count ?? undefined,
        published_year: openLibrary.year ?? undefined,
      },
    });
  }

  return baseMatch(item, {
    status: "unmatched",
    isbn: isbn ?? null,
    candidates: openLibrary.candidates ?? [],
  });
}

async function buildGoodreadsIndex({ userId, shelves }) {
  const byExactKey = new Map();
  const byTitleKey = new Map();
  const records = [];
  let count = 0;

  for (const shelf of shelves) {
    const books = await fetchGoodreadsShelf({ userId, shelf });
    for (const book of books) {
      count += 1;
      records.push(book);
      const exactKey = bookKey(book.title, book.author_name);
      const titleKey = normalizeTitle(book.title);

      const existingExact = byExactKey.get(exactKey);
      if (!existingExact || goodreadsRecordScore(book) > goodreadsRecordScore(existingExact)) {
        byExactKey.set(exactKey, book);
      }

      const titleMatches = byTitleKey.get(titleKey) ?? [];
      titleMatches.push(book);
      byTitleKey.set(titleKey, titleMatches);
    }

    await delay(REQUEST_DELAY_MS);
  }

  return { byExactKey, byTitleKey, records, count, shelves };
}

async function fetchGoodreadsShelf({ userId, shelf }) {
  const url = new URL(`https://www.goodreads.com/review/list_rss/${userId}`);
  url.searchParams.set("shelf", shelf);

  const { response, bodyText } = await fetchText(url).catch(() => ({}));
  if (!response?.ok || !bodyText) return [];

  return parseGoodreadsRss(bodyText, shelf);
}

function parseGoodreadsRss(xml, shelf) {
  const items = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/giu;
  let match;

  while ((match = itemPattern.exec(xml)) !== null) {
    const itemXml = match[1];
    const title = textFromXmlTag(itemXml, "title");
    const authorName = textFromXmlTag(itemXml, "author_name");
    if (!title) continue;

    items.push({
      shelf,
      title,
      link: textFromXmlTag(itemXml, "link"),
      book_id: textFromXmlTag(itemXml, "book_id"),
      book_image_url: upgradeGoodreadsImageUrl(textFromXmlTag(itemXml, "book_image_url")),
      book_small_image_url: upgradeGoodreadsImageUrl(textFromXmlTag(itemXml, "book_small_image_url")),
      book_medium_image_url: upgradeGoodreadsImageUrl(textFromXmlTag(itemXml, "book_medium_image_url")),
      book_large_image_url: upgradeGoodreadsImageUrl(textFromXmlTag(itemXml, "book_large_image_url")),
      author_name: authorName,
      isbn: normalizeIsbn(textFromXmlTag(itemXml, "isbn")),
      num_pages: parseOptionalNumber(textFromXmlTag(itemXml, "num_pages")),
      user_rating: parseOptionalNumber(textFromXmlTag(itemXml, "user_rating")),
      user_read_at: textFromXmlTag(itemXml, "user_read_at"),
      user_date_added: textFromXmlTag(itemXml, "user_date_added"),
      average_rating: parseOptionalNumber(textFromXmlTag(itemXml, "average_rating")),
      book_published: parseOptionalNumber(textFromXmlTag(itemXml, "book_published")),
    });
  }

  return items;
}

function findGoodreadsBook(item, goodreadsIndex) {
  const exact = goodreadsIndex.byExactKey.get(bookKey(item.title, item.author));
  if (exact && !isBadGoodreadsRecord(item, exact)) {
    return {
      ...exact,
      match_method: "title_author_goodreads_rss",
      score: 100,
    };
  }

  const targetTitle = normalizeTitle(item.title);
  const titleMatches = [
    ...(goodreadsIndex.byTitleKey.get(targetTitle) ?? []),
    ...goodreadsIndex.records.filter((book) => {
      const candidateTitle = normalizeTitle(book.title);
      if (isBadGoodreadsEditionMatch({ targetTitle, candidateTitle })) return false;
      return candidateTitle !== targetTitle && (
        candidateTitle.includes(targetTitle) ||
        targetTitle.includes(candidateTitle) ||
        titleTokenOverlap(targetTitle, candidateTitle) >= 0.62
      );
    }),
  ];
  const targetAuthor = normalizeAuthor(item.author);
  const scored = titleMatches
    .filter((book) => !isBadGoodreadsRecord(item, book))
    .map((book) => {
      const candidateAuthor = normalizeAuthor(book.author_name);
      const candidateTitle = normalizeTitle(book.title);
      const exactTitle = candidateTitle === targetTitle;
      const partialTitle = candidateTitle.includes(targetTitle) || targetTitle.includes(candidateTitle);
      const titleScore = exactTitle ? 82 : partialTitle ? 76 : titleTokenOverlap(targetTitle, candidateTitle) * 74;
      let authorScore = 0;
      if (targetAuthor && authorsEqual(targetAuthor, candidateAuthor)) authorScore = 18;
      else if (targetAuthor && authorsOverlap(targetAuthor, candidateAuthor)) authorScore = 12;
      else if (!targetAuthor) authorScore = 6;

      return {
        ...book,
        match_method: "title_goodreads_rss",
        score: Number(Math.min(99, titleScore + authorScore).toFixed(2)),
      };
    })
    .sort((left, right) => right.score - left.score || goodreadsRecordScore(right) - goodreadsRecordScore(left));

  return scored[0];
}

function isBadGoodreadsEditionMatch({ targetTitle, candidateTitle }) {
  if (candidateTitle === targetTitle) return false;

  return BAD_GOODREADS_TITLE_PHRASES.some((phrase) => candidateTitle.includes(phrase) && !targetTitle.includes(phrase));
}

function isBadGoodreadsRecord(item, book) {
  const targetTitle = normalizeTitle(item.title);
  const candidateTitle = normalizeTitle(book.title);
  if (isBadGoodreadsEditionMatch({ targetTitle, candidateTitle })) return true;

  const targetAuthor = normalizeAuthor(item.author);
  const candidateAuthor = normalizeAuthor(book.author_name);
  if (
    targetAuthor &&
    candidateAuthor &&
    !authorsOverlap(targetAuthor, candidateAuthor) &&
    BAD_GOODREADS_TITLE_PHRASES.some((phrase) => candidateTitle.includes(phrase))
  ) {
    return true;
  }

  return false;
}

function authorsEqual(left, right) {
  return left === right || compactName(left) === compactName(right);
}

function authorsOverlap(left, right) {
  if (!left || !right) return false;
  const compactLeft = compactName(left);
  const compactRight = compactName(right);
  return (
    left.includes(right) ||
    right.includes(left) ||
    compactLeft.includes(compactRight) ||
    compactRight.includes(compactLeft) ||
    titleTokenOverlap(left, right) >= 0.67
  );
}

function compactName(value) {
  return String(value ?? "").replace(/\s+/gu, "");
}

function goodreadsRecordScore(book) {
  return (
    (book.book_large_image_url ? 100 : 0) +
    (book.num_pages ? 20 : 0) +
    (book.isbn ? 12 : 0) +
    (book.user_rating ? 5 : 0)
  );
}

function textFromXmlTag(xml, tagName) {
  const pattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "iu");
  const match = pattern.exec(xml);
  return match ? decodeXmlText(match[1]).trim() : "";
}

function decodeXmlText(value) {
  return String(value ?? "")
    .replace(/^<!\[CDATA\[/u, "")
    .replace(/\]\]>$/u, "")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'");
}

function upgradeGoodreadsImageUrl(value) {
  if (!value) return "";
  const url = value
    .replace(/^http:/u, "https:")
    .replace(/\._S[XY]\d+(_S[XY]\d+)?_\./iu, ".")
    .replace(/\._S[XY]\d+(_S[XY]\d+)?_/iu, ".")
    .replace(/_S[XY]\d+(_S[XY]\d+)?_/iu, "");
  return isUsefulGoodreadsCover(url) ? url : "";
}

function isUsefulGoodreadsCover(url) {
  return Boolean(url) && !/\/nophoto\/book\//iu.test(url) && !/nophoto.*\.png/iu.test(url);
}

function parseOptionalNumber(value) {
  const number = Number(String(value ?? "").trim());
  return Number.isFinite(number) && number > 0 ? number : null;
}

function reliablePageCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 60) return null;
  return number;
}

async function fetchGoogleBooksViewApiCover(isbn) {
  const url = new URL("https://books.google.com/books");
  url.searchParams.set("bibkeys", `ISBN:${isbn}`);
  url.searchParams.set("jscmd", "viewapi");
  url.searchParams.set("format", "json");

  const { response, bodyText } = await fetchText(url).catch(() => ({}));
  if (!response?.ok) return {};

  const jsonText = bodyText.replace(/^var\s+_GBSBookInfo\s*=\s*/u, "").replace(/;\s*$/u, "");
  let body;
  try {
    body = JSON.parse(jsonText);
  } catch {
    return {};
  }

  const record = body[`ISBN:${isbn}`];
  if (!record?.thumbnail_url) return {};

  const coverUrl = new URL(record.thumbnail_url.replace(/^http:/u, "https:"));
  coverUrl.searchParams.set("zoom", "0");
  const dimensions = await fetchImageDimensions(coverUrl);
  if (!isUsefulGoogleCover(dimensions)) return {};

  return {
    bib_key: record.bib_key,
    google_books_id: /books\?id=([^&]+)/u.exec(record.info_url ?? "")?.[1] ?? null,
    cover_url: coverUrl.toString(),
    cover_width: dimensions.width,
    cover_height: dimensions.height,
  };
}

async function searchOpenLibrary(item) {
  const title = cleanTitle(item.title);
  const author = cleanAuthor(item.author);
  const url = new URL("https://openlibrary.org/search.json");
  url.searchParams.set("title", title);
  if (author) url.searchParams.set("author", author);
  url.searchParams.set("limit", "8");
  url.searchParams.set("fields", "key,title,author_name,first_publish_year,cover_i,isbn,language,publisher,number_of_pages_median,edition_count");

  const { response, bodyText, error } = await fetchText(url).catch((fetchError) => ({
    error: fetchError instanceof Error ? fetchError.message : String(fetchError),
  }));
  if (error) return { candidates: [{ error }] };
  if (!response.ok) {
    return { candidates: [{ error: `${response.status} ${response.statusText}: ${bodyText.slice(0, 160)}` }] };
  }

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { candidates: [{ error: "Open Library returned invalid JSON" }] };
  }

  const docs = Array.isArray(body.docs) ? body.docs : [];
  const scored = docs
    .filter((doc) => doc.cover_i)
    .map((doc) => scoreOpenLibraryDoc(doc, item))
    .sort((left, right) => right.score - left.score);
  const best = scored[0];
  if (!best || best.score < 58) {
    return { candidates: scored.slice(0, 4).map(candidateSummary) };
  }

  return {
    match_method: "title_author_openlibrary",
    score: best.score,
    key: best.key,
    cover_id: best.cover_i,
    cover_url: `https://covers.openlibrary.org/b/id/${best.cover_i}-L.jpg`,
    isbn: pickPreferredIsbn(best.isbn),
    page_count: best.number_of_pages_median ?? null,
    year: best.first_publish_year ?? null,
    candidates: scored.slice(0, 4).map(candidateSummary),
  };
}

function scoreOpenLibraryDoc(doc, item) {
  const targetTitle = normalizeTitle(item.title);
  const candidateTitle = normalizeTitle(doc.title);
  const targetAuthor = normalizeAuthor(item.author);
  const candidateAuthors = Array.isArray(doc.author_name) ? doc.author_name.map(normalizeAuthor) : [];
  let score = 0;

  if (isBadGoodreadsEditionMatch({ targetTitle, candidateTitle })) score -= 42;

  if (candidateTitle === targetTitle) score += 52;
  else if (candidateTitle.includes(targetTitle) || targetTitle.includes(candidateTitle)) score += 32;
  else score += titleTokenOverlap(targetTitle, candidateTitle) * 28;

  if (targetAuthor && candidateAuthors.includes(targetAuthor)) score += 32;
  else if (targetAuthor && candidateAuthors.some((author) => author.includes(targetAuthor) || targetAuthor.includes(author))) score += 22;

  const languages = Array.isArray(doc.language) ? doc.language.map((language) => String(language).toLowerCase()) : [];
  if (languages.includes("eng")) score += 8;
  else if (languages.length > 0) score -= 12;
  if (languages.length === 1 && languages[0] === "eng") score += 6;
  else if (languages.length > 1 && languages.includes("eng")) score -= 4;

  const titleNoise = ["journal", "wall calendar", "calendar", "audio trilogy"];
  if (titleNoise.some((phrase) => candidateTitle.includes(phrase) && !targetTitle.includes(phrase))) score -= 28;

  score += Math.min(Number(doc.edition_count) || 0, 40) / 4;
  if (doc.cover_i) score += 8;

  return { ...doc, score: Number(score.toFixed(2)) };
}

function pickPreferredIsbn(isbns) {
  if (!Array.isArray(isbns)) return null;

  const normalized = isbns
    .map(normalizeIsbn)
    .filter(Boolean)
    .filter((isbn, index, array) => array.indexOf(isbn) === index);
  if (normalized.length === 0) return null;

  const isbn13 = normalized.filter((isbn) => isbn.length === 13);
  const englishMarket13 = isbn13.find((isbn) => /^9780/u.test(isbn)) ?? isbn13.find((isbn) => /^9781/u.test(isbn));
  if (englishMarket13) return englishMarket13;
  if (isbn13.length > 0) return isbn13[0];

  return normalized[0];
}

async function patchMatchedItems({ apiBaseUrl, apiToken, matches }) {
  const result = { patched: [], failed: [] };
  for (const match of matches) {
    const patch = {
      image_url: match.cover_url,
      metadata: match.metadata,
    };
    if (match.page_count && !match.progress_total) {
      patch.progress_total = match.page_count;
      patch.progress_unit = "page";
    }

    try {
      const response = await fetch(`${apiBaseUrl}/v1/shelf/${match.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(patch),
      });
      const bodyText = await response.text();
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}: ${bodyText.slice(0, 300)}`);
      }
      result.patched.push({
        id: match.id,
        title: match.title,
        match_method: match.match_method,
        cover_url: match.cover_url,
      });
      await delay(REQUEST_DELAY_MS);
    } catch (error) {
      result.failed.push({
        id: match.id,
        title: match.title,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

function shouldPatchMatch(match, minScore) {
  const score = Number(match.score ?? 100);
  if (score >= minScore) return true;

  return (
    score >= 58 &&
    match.metadata?.book_cover_source !== "goodreads_rss" &&
    isBadExistingGoodreadsCover(match)
  );
}

function isBadExistingGoodreadsCover(match) {
  if (!/goodreads|gr-assets|images-na\.ssl-images-amazon|images\.amazon/iu.test(match.existing_image_url ?? "")) {
    return false;
  }

  const currentBookId = String(match.existing_metadata?.goodreads_book_id ?? "");
  if (currentBookId && KNOWN_BAD_GOODREADS_BOOK_IDS.has(currentBookId)) return true;

  const currentReviewUrl = String(match.existing_metadata?.goodreads_review_url ?? "");
  if ([...KNOWN_BAD_GOODREADS_BOOK_IDS].some((id) => currentReviewUrl.includes(id))) return true;
  if ([...KNOWN_BAD_GOODREADS_BOOK_IDS].some((id) => (match.existing_image_url ?? "").includes(id))) return true;

  return false;
}

async function buildIsbnIndex(goodreadsExportDir) {
  const index = new Map();
  const files = [
    "goodreads-current-vs-imports-diff.csv",
    "goodreads-failed-retry-review.csv",
    "goodreads-import-failed-retry-with-isbns.csv",
    "goodreads-import-balaji-only.csv",
    "goodreads-import-clean-generalized-progress.csv",
    "goodreads-import-generalized-progress.csv",
    "goodreads-import-library-as-to-read.csv",
    "goodreads-import-want-to-read.csv",
  ];

  for (const file of files) {
    let rows = [];
    try {
      rows = parseCsv(await readFile(resolve(goodreadsExportDir, file), "utf8"));
    } catch {
      continue;
    }

    for (const row of rows) {
      const title = row.Title ?? row.source_title ?? row.raw_title ?? row.retry_title;
      const author = row.Author ?? row.source_author ?? row.raw_author ?? row.retry_author;
      const isbn = normalizeIsbn(row.ISBN ?? row.goodreads_isbn ?? row.source_isbn ?? row.isbn);
      if (!title || !isbn) continue;
      index.set(bookKey(title, author), isbn);

      const retryTitle = row.retry_title;
      const retryAuthor = row.retry_author;
      if (retryTitle) index.set(bookKey(retryTitle, retryAuthor), isbn);
    }
  }

  return index;
}

async function fetchExistingShelfItems(apiBaseUrl, apiToken) {
  const items = [];
  for (let offset = 0; ; offset += 1000) {
    const url = new URL(`${apiBaseUrl}/v1/shelf`);
    url.searchParams.set("limit", "1000");
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("include_unpublished", "true");

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`Failed to fetch shelf: ${response.status} ${response.statusText}: ${bodyText.slice(0, 300)}`);
    }

    const page = JSON.parse(bodyText);
    if (!Array.isArray(page)) throw new Error("Expected /v1/shelf to return an array.");
    items.push(...page);
    if (page.length < 1000) break;
  }
  return items;
}

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const bodyText = await response.text();
    return { response, bodyText };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchImageDimensions(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return readImageDimensions(Buffer.from(await response.arrayBuffer()));
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function isUsefulGoogleCover(dimensions) {
  if (!dimensions) return false;
  if (dimensions.width === 575 && dimensions.height === 750 && dimensions.byte_length < 20_000) return false;
  if (dimensions.width < 480 && dimensions.height < 650) return false;

  const ratio = dimensions.height / Math.max(dimensions.width, 1);
  return ratio > 0.75 && ratio < 2.0;
}

function readImageDimensions(buffer) {
  if (buffer.length < 24) return null;

  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.subarray(0, 8).equals(pngSignature)) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), byte_length: buffer.byteLength };
  }

  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);

    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
        byte_length: buffer.byteLength,
      };
    }

    offset += 2 + length;
  }

  return null;
}

function baseMatch(item, fields) {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    author: item.author ?? null,
    existing_image_url: item.image_url ?? null,
    existing_metadata: item.metadata ?? null,
    progress_total: item.progress_total ?? null,
    ...fields,
  };
}

function candidateSummary(candidate) {
  return {
    title: candidate.title,
    authors: candidate.author_name ?? [],
    year: candidate.first_publish_year ?? null,
    cover_id: candidate.cover_i ?? null,
    page_count: candidate.number_of_pages_median ?? null,
    score: candidate.score ?? null,
  };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        value += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value.replace(/\r$/u, ""));
      rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }
  if (value || row.length > 0) {
    row.push(value.replace(/\r$/u, ""));
    rows.push(row);
  }

  const [headers = [], ...body] = rows;
  return body
    .filter((cells) => cells.some((cell) => String(cell).trim()))
    .map((cells) =>
      Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])),
    );
}

async function loadEnvFiles(paths) {
  for (const filePath of paths) {
    try {
      await loadEnvFile(filePath);
    } catch {
      // Optional env files are expected to be absent in some environments.
    }
  }
}

async function loadEnvFile(filePath) {
  const text = await readFile(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
      process.env[key] = value;
    }
  }
}

function requireValue(flag, value) {
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parsePositiveInteger(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`Expected a positive integer, got ${value}`);
  }
  return number;
}

function parsePositiveNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`Expected a positive number, got ${value}`);
  }
  return number;
}

function parseShelfList(value) {
  const shelves = String(value ?? "")
    .split(",")
    .map((shelf) => shelf.trim())
    .filter(Boolean);
  if (shelves.length === 0) {
    throw new Error("Expected at least one Goodreads shelf.");
  }
  return shelves;
}

function isBook(item) {
  return item.type === "book" || item.drawer === "books" || getTag(item, "kind") === "book";
}

function getTag(item, key) {
  const tags = item.tags;
  if (!Array.isArray(tags)) return undefined;
  const prefix = `${key.toLowerCase()}:`;
  const match = tags.find((tag) => String(tag).toLowerCase().startsWith(prefix));
  return match ? String(match).slice(prefix.length) : undefined;
}

function bookKey(title, author) {
  return `${normalizeTitle(title)}::${normalizeAuthor(author)}`;
}

function cleanTitle(title) {
  return String(title ?? "")
    .replace(/\s+\([^)]*true epub[^)]*\)/giu, "")
    .replace(/\s+\([^)]*for true epub[^)]*\)/giu, "")
    .trim();
}

function cleanAuthor(author) {
  return String(author ?? "")
    .replace(/^/u, "")
    .replace(/\b\(author\)|\b\(illustrator\)/giu, "")
    .trim();
}

function normalizeTitle(title) {
  return cleanTitle(title)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeAuthor(author) {
  return cleanAuthor(author)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleTokenOverlap(left, right) {
  const leftTokens = new Set(left.split(/\s+/u).filter((token) => token.length > 2));
  const rightTokens = new Set(right.split(/\s+/u).filter((token) => token.length > 2));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) shared += 1;
  }
  return shared / Math.max(leftTokens.size, rightTokens.size);
}

function normalizeIsbn(value) {
  const digits = String(value ?? "").replace(/[^0-9X]/giu, "");
  if (digits.length === 10 || digits.length === 13) return digits;
  return "";
}

function normalizeApiBaseUrl(value) {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
