# 0003: services/links split into modules

Status: accepted, 25 Nov 2026

## Context

`services/links.ts` had grown to ~900 lines holding five unrelated concerns:
HTML-to-Markdown extraction (pure, most of the tests), per-site handling of
posts, videos and PDFs (network), the link row and its reads, saving and
fetching, and reading state and stats (SQL). Changes to one meant reading all.

## Decision

`services/links/` with one module per concern, split along the dependency
direction so there are no cycles:

- `extract.ts`: a page's HTML as Markdown, titles, canonical URL. Pure.
- `urls.ts`: `normalizeUrl`, `isSingleUrl`, `arxivId`, `linkKind`. Pure.
- `nonarticles.ts`: posts (FixTweet, X oEmbed), videos (oEmbed), PDFs, arXiv.
- `store.ts`: `LinkRow`, `presentLink`, `getLink`, `listLinks`, `linkTags`.
- `fetch.ts`: `saveLink`, `fetchArticle`, enrichment.
- `state.ts`: progress, read/archive, star/tag/title, note.
- `stats.ts`: `readingStats`, `readingOnDay`.
- `index.ts` re-exports them all, so `import … from "../services/links"`
  keeps working for routes and tests.

Code moved verbatim; the only edits are imports, `describeNonArticle` being
exported (fetch.ts calls it), and stray doc comments re-attached to the
functions they describe. Every existing test passes without change.

## Consequences

- New callers may import a module directly (`services/links/extract`); the
  modules import each other, never the index, to keep the graph acyclic.
- Highlights stay in `services/highlights.ts`; search stays in documents.
