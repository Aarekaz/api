/**
 * The requests the website (anuragd.me) makes: GETs of the routes in its
 * contract (src/__tests__/contracts/website-openapi.snapshot.json, the copy of
 * anurag.me/contracts/api-openapi.json) plus the few it reads outside it
 * (wrapped and traffic for a year, status, what's playing, WHOOP). These are
 * all SITE_TOKEN may do (middleware/auth.ts); a test checks every contract
 * path is here. Adding a route the website reads means adding it here too.
 */
const SITE_PATHS: RegExp[] = [
  /^\/v1\/(profile|projects|posts|photos|experience|education|skills|now|uses|settings|shelf|github|wakatime|wakatime\/hourly)$/,
  /^\/v1\/(status|music\/now)$/,
  /^\/v1\/(wrapped|traffic)\/\d{4}$/,
  /^\/v1\/health\/whoop\/[a-z-]+(\/[\w-]+)?$/,
];

const trimmed = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);

/** A path the website reads (whatever the method): its errors keep the website's old shape. */
export function isSitePath(path: string): boolean {
  const p = trimmed(path);
  return SITE_PATHS.some((re) => re.test(p));
}

/** A request the website's token may make: a GET or HEAD of a path it reads. */
export function isSiteRead(method: string, path: string): boolean {
  return (method === "GET" || method === "HEAD") && isSitePath(path);
}
