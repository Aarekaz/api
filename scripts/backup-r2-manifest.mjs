import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = join("backups", timestamp);
const output = join(backupDir, "api-media-manifest.json");
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const bucketName = process.env.R2_BUCKET_NAME ?? "api-media";

if (!accountId || !apiToken) {
  console.error(
    "Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN. " +
      "Both are required to list R2 objects through the Cloudflare API."
  );
  process.exit(1);
}

const objects = [];
let cursor;

do {
  const url = new URL(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucketName}/objects`
  );
  url.searchParams.set("per_page", "1000");
  if (cursor) url.searchParams.set("cursor", cursor);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
    },
  });

  const body = await response.json();
  if (!response.ok || body.success === false) {
    console.error(
      `Failed to list R2 objects: ${response.status} ${response.statusText}`
    );
    console.error(JSON.stringify(body.errors ?? body, null, 2));
    process.exit(1);
  }

  objects.push(...(Array.isArray(body.result) ? body.result : []));
  cursor = body.result_info?.is_truncated ? body.result_info?.cursor : undefined;
} while (cursor);

await mkdir(backupDir, { recursive: true });
await writeFile(
  output,
  `${JSON.stringify({ bucket: bucketName, generated_at: new Date().toISOString(), objects }, null, 2)}\n`
);

console.log(`R2 manifest written to ${output} (${objects.length} objects)`);
