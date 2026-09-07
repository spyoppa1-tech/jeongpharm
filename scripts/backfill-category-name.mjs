import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const BLOG_ID = "spyoppa2";
const DETAIL_PATH = path.join("data", "posts-summarized.json");

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

function extractCategoryName(html) {
  return html.match(/categoryName = '([^']*)'/)?.[1] ?? null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const posts = JSON.parse(await readFile(DETAIL_PATH, "utf-8"));
  let updated = 0;

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    try {
      const res = await fetch(buildPostViewUrl(post.postId), {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      const html = await res.text();
      const categoryName = extractCategoryName(html);
      if (categoryName) {
        post.categoryName = categoryName;
        updated++;
      }
    } catch (err) {
      console.warn(`  실패 [${post.postId}]: ${err.message}`);
    }
    if ((i + 1) % 30 === 0) {
      console.log(`진행: ${i + 1}/${posts.length}`);
    }
    await sleep(200);
  }

  await writeFile(DETAIL_PATH, JSON.stringify(posts, null, 2), "utf-8");
  console.log(`완료: ${updated}/${posts.length}건에 categoryName 추가`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
