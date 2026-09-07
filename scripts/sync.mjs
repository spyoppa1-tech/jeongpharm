import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadEnv } from "./lib/load-env.mjs";

await loadEnv();

const BLOG_ID = "spyoppa2";
const COUNT_PER_PAGE = 30;
const ARCHIVE_PATH = path.join("data", "archive.json");
const DETAIL_PATH = path.join("data", "posts-detail.json");
const SUMMARY_PATH = path.join("data", "posts-summarized.json");

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_DELAY_MS = Number(process.env.GEMINI_DELAY_MS) || 4200;
const BODY_CHAR_LIMIT = 3000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function buildArchiveUrl(page) {
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

async function fetchArchivePage(page) {
  const res = await fetch(buildArchiveUrl(page), {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`아카이브 페이지 ${page} 요청 실패: ${res.status}`);
  const safeText = (await res.text()).replace(/\\'/g, "'");
  return JSON.parse(safeText);
}

function toArchiveEntry(item) {
  return {
    postId: item.logNo,
    title: decodeURIComponent(item.title.replace(/\+/g, " ")),
    link: `https://blog.naver.com/${BLOG_ID}/${item.logNo}`,
    category: item.categoryNo,
    addDate: item.addDate,
  };
}

async function detectNewPosts(knownIds) {
  const newEntries = [];
  let page = 1;
  while (true) {
    const data = await fetchArchivePage(page);
    for (const item of data.postList) {
      if (knownIds.has(item.logNo)) {
        return newEntries; // 이미 알고 있는 글을 만나면 그 이전(더 최신)까지가 신규 글
      }
      newEntries.push(toArchiveEntry(item));
    }
    const totalPages = Math.ceil(Number(data.totalCount) / Number(data.countPerPage));
    if (page >= totalPages) return newEntries;
    page++;
  }
}

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

function extractCategoryName(html) {
  return html.match(/categoryName = '([^']*)'/)?.[1] ?? null;
}

async function fetchPostDetail(postId) {
  const res = await fetch(buildPostViewUrl(postId), {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`본문 요청 실패: HTTP ${res.status}`);
  const html = await res.text();
  return {
    ogTitle: extractMeta(html, "og:title"),
    ogImage: extractMeta(html, "og:image"),
    ogDescription: extractMeta(html, "og:description"),
    bodyText: extractBodyText(html),
    categoryName: extractCategoryName(html),
  };
}

const SUMMARY_MAX_LEN = 35;

function buildSummaryPrompt(post) {
  const body = post.bodyText.slice(0, BODY_CHAR_LIMIT);
  return `다음은 약국 블로그 포스팅의 본문입니다.

이 포스팅의 핵심 내용을 한국어 기준 24~28자 사이의 완성된 문장 1개로 요약하세요.
엄격한 규칙:
- 반드시 28자를 넘기지 마세요 (공백 포함 글자 수 기준). 28자를 넘으면 실패로 간주합니다.
- 짧더라도 주어와 서술어를 갖춘 완전한 문장이어야 하고 마침표(.)로 끝나야 합니다
- 마크다운, 따옴표, 부가 설명, 글자수 표시 없이 요약 문장 하나만 출력하세요

예시(26자): 임산부는 안전한 완하제를 복용해야 한다.

제목: ${post.title}

본문:
${body}`;
}

function buildShortenPrompt(sentence) {
  return `다음 문장의 핵심 의미는 유지하면서 한국어 기준 35자 이내로 더 줄이세요. 반드시 주어와 서술어를 갖춘 완전한 문장이어야 하고 마침표(.)로 끝나야 합니다. 다른 설명 없이 줄인 문장만 출력하세요.\n\n문장: ${sentence}`;
}

async function callGemini(text, retries = 3) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: { maxOutputTokens: 2000 },
      }),
    });
    if (res.status === 503 && attempt < retries) {
      await sleep(3000 * attempt);
      continue;
    }
    if (!res.ok) throw new Error(`Gemini 요청 실패: HTTP ${res.status}`);
    const data = await res.json();
    const text2 = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text2) throw new Error("Gemini 응답에 요약 텍스트 없음");
    return text2.trim();
  }
}

async function summarize(post) {
  let summary = await callGemini(buildSummaryPrompt(post));
  let pass = 1;
  while (summary && summary.length > SUMMARY_MAX_LEN && pass < 3) {
    await sleep(4200);
    summary = await callGemini(buildShortenPrompt(summary));
    pass++;
  }
  return summary;
}

async function main() {
  const archive = await readJson(ARCHIVE_PATH, []);
  const knownIds = new Set(archive.map((p) => p.postId));

  console.log("신규 포스팅 확인 중...");
  const newEntries = await detectNewPosts(knownIds);

  if (newEntries.length === 0) {
    console.log("새 포스팅 없음. 최신 상태입니다.");
    return;
  }

  console.log(`신규 포스팅 ${newEntries.length}건 발견`);

  const updatedArchive = [...newEntries, ...archive];
  await writeFile(ARCHIVE_PATH, JSON.stringify(updatedArchive, null, 2), "utf-8");

  const details = await readJson(DETAIL_PATH, []);
  const summaries = await readJson(SUMMARY_PATH, []);
  const newDetails = [];

  for (const entry of newEntries) {
    console.log(`  본문/썸네일 수집: ${entry.title}`);
    try {
      const detail = await fetchPostDetail(entry.postId);
      newDetails.push({ ...entry, ...detail });
    } catch (err) {
      console.warn(`    실패: ${err.message}`);
    }
    await sleep(300);
  }
  await writeFile(DETAIL_PATH, JSON.stringify([...newDetails, ...details], null, 2), "utf-8");

  if (!GEMINI_API_KEY) {
    console.warn("GEMINI_API_KEY가 없어 요약은 건너뜁니다. .env 설정 후 scripts/summarize.mjs를 실행하세요.");
    return;
  }

  const newSummaries = [];
  for (const post of newDetails) {
    console.log(`  요약 생성: ${post.title}`);
    try {
      const summary = await summarize(post);
      newSummaries.push({ ...post, summary });
    } catch (err) {
      console.warn(`    실패: ${err.message}`);
    }
    await sleep(GEMINI_DELAY_MS);
  }
  await writeFile(SUMMARY_PATH, JSON.stringify([...newSummaries, ...summaries], null, 2), "utf-8");

  console.log(`동기화 완료: 신규 ${newEntries.length}건 반영 (본문 ${newDetails.length}건, 요약 ${newSummaries.length}건)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
