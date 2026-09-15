/**
 * Not ffmpeg work -- no video surgery here, just fetching and zipping. Kept
 * out of video.mjs because that file's own header comment already frames it
 * as specifically the ffmpeg half of this service; this is the other kind of
 * thing "Convex genuinely cannot do": Convex actions can't shell out or
 * stream a zip archive, and influencer training needs its 10-50 reference
 * photos as one `images_data_url` zip, not a list of URLs.
 */

import { ZipArchive } from "archiver";

/** Content-type -> file extension, so the zip's members open naturally with any tool. */
const EXT_BY_CONTENT_TYPE = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/**
 * Fetches every URL and returns one zip archive, in the same order the URLs
 * were given (not fetch-completion order) -- deterministic naming, since a
 * caller may care about which image is which later.
 */
export async function packImages(imageUrls) {
  if (!imageUrls?.length) throw new Error("at least one image URL is required");

  const fetched = await Promise.all(
    imageUrls.map(async (url, i) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`failed to fetch training image ${i}: ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      const ext = EXT_BY_CONTENT_TYPE[res.headers.get("content-type") ?? ""] ?? "jpg";
      return { buffer, name: `img_${String(i).padStart(3, "0")}.${ext}` };
    }),
  );

  const archive = new ZipArchive({ zlib: { level: 6 } });
  const chunks = [];
  archive.on("data", (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    archive.on("end", resolve);
    archive.on("error", reject);
  });

  for (const { buffer, name } of fetched) {
    archive.append(buffer, { name });
  }
  await archive.finalize();
  await done;

  return Buffer.concat(chunks);
}
