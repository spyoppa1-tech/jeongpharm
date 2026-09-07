import { XMLParser } from "fast-xml-parser";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const BLOG_ID = "spyoppa2";
const RSS_URL = `https://rss.blog.naver.com/${BLOG_ID}.xml`;
const OUTPUT_PATH = path.join("data", "posts.json");

function extractPostId(link) {
  const match = link.match(/blog\.naver\.com\/[^/]+\/(\d+)/);
  return match ? match[1] : null;
}

function toCleanLink(link) {
  return link.split("?")[0];
}

async function main() {
  const res = await fetch(RSS_URL, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) {
    throw new Error(`RSS fetch failed: ${res.status} ${res.statusText}`);
  }
  const xml = await res.text();

  const parser = new XMLParser({
    isArray: (name) => name === "item",
  });
  const parsed = parser.parse(xml);

  const items = parsed?.rss?.channel?.item ?? [];
  if (items.length === 0) {
    console.warn("경고: RSS에서 item을 찾지 못했습니다. 블로그 ID 또는 RSS 구조를 확인하세요.");
  }

  const posts = items.map((item) => {
    const link = toCleanLink(item.link);
    return {
      postId: extractPostId(link),
      title: item.title,
      link,
      pubDate: item.pubDate,
      category: item.category ?? null,
      tags: item.tag
        ? String(item.tag)
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : [],

      rssDescription: item.description ?? "",
    };
  });

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(posts, null, 2), "utf-8");

  console.log(`수집 완료: ${posts.length}건 → ${OUTPUT_PATH}`);
  if (posts.length >= 50) {
    console.log(
      "참고: 네이버 RSS는 최근 글 위주(약 50건)로만 제공됩니다. 과거 전체 아카이브는 별도 수집이 필요합니다(계획서 8장 리스크 참고)."
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
