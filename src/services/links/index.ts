// Read later. A saved link is a `link` document (so it syncs, searches and
// backs up like everything else) plus a `links` row with the URL and reading
// state. The article's readable text is fetched once and stored as the
// document's Markdown body, so it reads offline and full-text search covers it.
//
//   extract.ts      a page's HTML as the reader's Markdown (pure)
//   nonarticles.ts  posts, videos and PDFs from the place that knows best
//   urls.ts         a URL's clean form and what kind of page it is
//   store.ts        the link row, how replies show it, the list and tag reads
//   fetch.ts        saving a link and fetching its page
//   state.ts        progress, read, stars, tags, title, note
//   stats.ts        reading over time
//
// Callers import from here; the modules import each other directly.

export * from "./extract";
export * from "./nonarticles";
export * from "./urls";
export * from "./store";
export * from "./fetch";
export * from "./state";
export * from "./stats";
