import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadEnv } from "./lib/load-env.mjs";

await loadEnv();

const INPUT_PATH = path.join("data", "posts-summarized.json");
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const DELAY_MS = Number(process.env.GEMINI_DELAY_MS) || 4200;
const BODY_CHAR_LIMIT = 3000;
const ALREADY_SHORT_LEN = 40;
const MAX_LEN = 35;

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("GEMINI_API_KEY가 설정되어 있지 않습니다.");
  process.exit(1);
}

function buildPrompt(post) {
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callGemini(text, retries = 3) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
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
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 300)}`);
    }
    const data = await res.json();
    const text2 = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text2) throw new Error("요약 결과 없음");
    return text2.trim();
  }
}

async function summarizeShort(post) {
  let summary = await callGemini(buildPrompt(post));
  let pass = 1;
  while (summary && summary.length > MAX_LEN && pass < 3) {
    await sleep(DELAY_MS);
    summary = await callGemini(buildShortenPrompt(summary));
    pass++;
  }
  return summary;
}

async function main() {
  const posts = JSON.parse(await readFile(INPUT_PATH, "utf-8"));
  const todo = posts.filter((p) => !p.summary || p.summary.length > ALREADY_SHORT_LEN);

  console.log(`전체 ${posts.length}건 중 ${todo.length}건 재요약 진행 (이미 짧은 요약 ${posts.length - todo.length}건 스킵)`);

  for (let i = 0; i < todo.length; i++) {
    const post = todo[i];
    try {
      post.summary = await summarizeShort(post);
    } catch (err) {
      console.warn(`  실패 [${post.postId}] ${post.title}: ${err.message}`);
    }

    if ((i + 1) % 10 === 0 || i === todo.length - 1) {
      await writeFile(INPUT_PATH, JSON.stringify(posts, null, 2), "utf-8");
      console.log(`진행: ${i + 1}/${todo.length} (중간 저장 완료)`);
    }
    await sleep(DELAY_MS);
  }

  await writeFile(INPUT_PATH, JSON.stringify(posts, null, 2), "utf-8");
  console.log(`완료`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
