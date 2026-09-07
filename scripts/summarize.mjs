import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadEnv } from "./lib/load-env.mjs";

await loadEnv();

const INPUT_PATH = path.join("data", "posts-detail.json");
const OUTPUT_PATH = path.join("data", "posts-summarized.json");
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const DELAY_MS = Number(process.env.GEMINI_DELAY_MS) || 4200;
const BODY_CHAR_LIMIT = 3000;

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error(
    "GEMINI_API_KEY가 설정되어 있지 않습니다. .env 파일에 GEMINI_API_KEY=발급받은키 형태로 추가하세요."
  );
  process.exit(1);
}

function buildPrompt(post) {
  const body = post.bodyText.slice(0, BODY_CHAR_LIMIT);
  return `다음은 약국 블로그 포스팅 본문입니다. 검색 결과 카드에 바로 넣을 수 있도록, 마크다운·제목·굵은글씨·목록 없이 순수 한글 문장 2~3개로만 핵심을 요약하세요. 광고성 문구나 인사말은 빼고 정보 위주로 작성하고, 다른 설명 없이 요약 문장만 출력하세요.\n\n제목: ${post.title}\n\n본문:\n${body}`;
}

async function summarizeOne(post, retries = 3) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt(post) }] }],
        generationConfig: { maxOutputTokens: 2000 },
      }),
    });
    if (res.status === 503 && attempt < retries) {
      await sleep(3000 * attempt);
      continue;
    }
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 300)}`);
    }
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error(`요약 결과 없음: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return text.trim();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const fullPosts = JSON.parse(await readFile(INPUT_PATH, "utf-8"));
  const limit = Number(process.env.LIMIT) || fullPosts.length;
  const posts = fullPosts.slice(0, limit);

  let existing = [];
  try {
    existing = JSON.parse(await readFile(OUTPUT_PATH, "utf-8"));
  } catch {
    // 첫 실행이면 결과 파일이 없을 수 있음
  }
  const doneIds = new Set(existing.map((p) => p.postId));
  const results = [...existing];

  const todo = posts.filter((p) => !doneIds.has(p.postId));
  console.log(`전체 ${posts.length}건 중 ${todo.length}건 요약 진행 (기존 완료 ${doneIds.size}건 스킵)`);

  for (let i = 0; i < todo.length; i++) {
    const post = todo[i];
    try {
      const summary = await summarizeOne(post);
      results.push({ ...post, summary });
    } catch (err) {
      console.warn(`  실패 [${post.postId}] ${post.title}: ${err.message}`);
    }

    if ((i + 1) % 10 === 0 || i === todo.length - 1) {
      await writeFile(OUTPUT_PATH, JSON.stringify(results, null, 2), "utf-8");
      console.log(`진행: ${i + 1}/${todo.length} (중간 저장 완료)`);
    }
    await sleep(DELAY_MS);
  }

  await writeFile(OUTPUT_PATH, JSON.stringify(results, null, 2), "utf-8");
  console.log(`완료: 총 ${results.length}건 → ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
