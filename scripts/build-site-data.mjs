import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const INPUT_PATH = path.join("data", "posts-summarized.json");
const OUTPUT_PATH = path.join("public", "data", "posts.json");
const SEARCH_TEXT_LIMIT = 500;

function toMobileThumbnail(ogImage) {
  if (!ogImage) return null;
  return ogImage.replace(/([?&])type=[^&]*/, "$1type=w300");
}

async function main() {
  const posts = JSON.parse(await readFile(INPUT_PATH, "utf-8"));

  const siteData = posts.map((p) => ({
    postId: p.postId,
    title: p.title,
    link: p.link,
    thumbnail: toMobileThumbnail(p.ogImage),
    summary: p.summary,
    category: p.category,
    addDate: p.addDate,
    searchText: (p.bodyText || "").slice(0, SEARCH_TEXT_LIMIT),
  }));

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(siteData), "utf-8");

  console.log(`사이트 데이터 생성 완료: ${siteData.length}건 → ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
