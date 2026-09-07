import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const BLOG_ID = "spyoppa2";
const COUNT_PER_PAGE = 30;
const OUTPUT_PATH = path.join("data", "archive.json");

function buildUrl(page) {
  const params = new URLSearchParams({
    blogId: BLOG_ID,
    viewdate: "",
    currentPage: String(page),
    categoryNo: "0",
    parentCategoryNo: "",
    countPerPage: String(COUNT_PER_PAGE),
  });
  return `https://blog.naver.com/PostTitleListAsync.naver?${params.toString()}`;
}

async function fetchPage(page) {
  const res = await fetch(buildUrl(page), {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) {
    throw new Error(`페이지 ${page} 요청 실패: ${res.status}`);
  }
  const rawText = await res.text();
  // 네이버 API가 pagingHtml 안의 작은따옴표를 \' 로 잘못 이스케이프해서 내려줘서
  // 표준 JSON 파서가 실패한다. 유효하지 않은 \' 이스케이프만 걷어내고 파싱한다.
  const safeText = rawText.replace(/\\'/g, "'");
  return JSON.parse(safeText);
}

async function main() {
  const first = await fetchPage(1);
  const totalCount = Number(first.totalCount);
  const countPerPage = Number(first.countPerPage) || COUNT_PER_PAGE;
  const totalPages = Math.ceil(totalCount / countPerPage);

  console.log(`전체 포스팅 수: ${totalCount}건, 총 ${totalPages}페이지`);

  const allPosts = [...first.postList];

  for (let page = 2; page <= totalPages; page++) {
    const data = await fetchPage(page);
    allPosts.push(...data.postList);
    console.log(`  페이지 ${page}/${totalPages} 수집 (누적 ${allPosts.length}건)`);
    // 과도한 요청 방지용 딜레이
    await new Promise((r) => setTimeout(r, 300));
  }

  const posts = allPosts.map((item) => ({
    postId: item.logNo,
    title: decodeURIComponent(item.title.replace(/\+/g, " ")),
    link: `https://blog.naver.com/${BLOG_ID}/${item.logNo}`,
    category: item.categoryNo,
    addDate: item.addDate,
  }));

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(posts, null, 2), "utf-8");

  console.log(`아카이브 수집 완료: ${posts.length}건 → ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
