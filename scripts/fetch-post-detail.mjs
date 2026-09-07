import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const BLOG_ID = "spyoppa2";
const ARCHIVE_PATH = path.join("data", "archive.json");
const OUTPUT_PATH = path.join("data", "posts-detail.json");
const REQUEST_DELAY_MS = 300;

function buildPostViewUrl(postId) {
  const params = new URLSearchParams({
    blogId: BLOG_ID,
    logNo: postId,
    redirect: "Dlog",
    widgetTypeCall: "true",
    noTrackingCode: "true",
    directAccess: "false",
  });
  return `https://blog.naver.com/PostView.naver?${params.toString()}`;
}

function extractMeta(html, property) {
  const re = new RegExp(`<meta property="${property}" content="([^"]*)"`);
  return html.match(re)?.[1] ?? null;
}

function extractBodyText(html) {
  const idx = html.indexOf("se-main-container");
  if (idx === -1) return "";
  const container = html.slice(idx, idx + 200_000);
  return container
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchPostDetail(postId) {
  const res = await fetch(buildPostViewUrl(postId), {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const html = await res.text();
  return {
    ogTitle: extractMeta(html, "og:title"),
    ogImage: extractMeta(html, "og:image"),
    ogDescription: extractMeta(html, "og:description"),
    bodyText: extractBodyText(html),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const fullArchive = JSON.parse(await readFile(ARCHIVE_PATH, "utf-8"));
  const limit = Number(process.env.LIMIT) || fullArchive.length;
  const archive = fullArchive.slice(0, limit);

  const results = [];
  const failures = [];

  for (let i = 0; i < archive.length; i++) {
    const post = archive[i];
    try {
      const detail = await fetchPostDetail(post.postId);
      results.push({ ...post, ...detail });
    } catch (err) {
      console.warn(`  실패 [${post.postId}]: ${err.message}`);
      failures.push({ postId: post.postId, title: post.title, error: err.message });
    }

    if ((i + 1) % 20 === 0 || i === archive.length - 1) {
      console.log(`진행: ${i + 1}/${archive.length}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  await writeFile(OUTPUT_PATH, JSON.stringify(results, null, 2), "utf-8");
  console.log(`완료: 성공 ${results.length}건 / 실패 ${failures.length}건 → ${OUTPUT_PATH}`);
  if (failures.length > 0) {
    console.log("실패 목록:", failures);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
