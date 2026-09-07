const BLOG_ID = "spyoppa2";
const COUNT_PER_PAGE = 30;
const BODY_CHAR_LIMIT = 3000;
const SEARCH_TEXT_LIMIT = 500;

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
      if (knownIds.has(item.logNo)) return newEntries;
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

async function fetchPostDetail(postId) {
  const res = await fetch(buildPostViewUrl(postId), {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`본문 요청 실패: HTTP ${res.status}`);
  const html = await res.text();
  return {
    ogImage: extractMeta(html, "og:image"),
    bodyText: extractBodyText(html),
  };
}

function toMobileThumbnail(ogImage) {
  if (!ogImage) return null;
  return ogImage.replace(/([?&])type=[^&]*/, "$1type=w300");
}

function buildSummaryPrompt(entry, bodyText) {
  const body = bodyText.slice(0, BODY_CHAR_LIMIT);
  return `다음은 약국 블로그 포스팅 본문입니다. 검색 결과 카드에 바로 넣을 수 있도록, 마크다운·제목·굵은글씨·목록 없이 순수 한글 문장 2~3개로만 핵심을 요약하세요. 광고성 문구나 인사말은 빼고 정보 위주로 작성하고, 다른 설명 없이 요약 문장만 출력하세요.\n\n제목: ${entry.title}\n\n본문:\n${body}`;
}

async function summarize(entry, bodyText, env, retries = 3) {
  const model = env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildSummaryPrompt(entry, bodyText) }] }],
        generationConfig: { maxOutputTokens: 2000 },
      }),
    });
    if (res.status === 503 && attempt < retries) {
      await new Promise((r) => setTimeout(r, 3000 * attempt));
      continue;
    }
    if (!res.ok) throw new Error(`Gemini 요청 실패: HTTP ${res.status}`);
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini 응답에 요약 텍스트 없음");
    return text.trim();
  }
}

async function runSync(env) {
  const archive = (await env.POSTS_KV.get("archive", "json")) ?? [];
  const posts = (await env.POSTS_KV.get("posts", "json")) ?? [];
  const knownIds = new Set(archive.map((p) => p.postId));

  const newEntries = await detectNewPosts(knownIds);
  if (newEntries.length === 0) {
    return { newCount: 0, titles: [] };
  }

  const newSiteEntries = [];
  for (const entry of newEntries) {
    try {
      const detail = await fetchPostDetail(entry.postId);
      const summary = await summarize(entry, detail.bodyText, env);
      newSiteEntries.push({
        postId: entry.postId,
        title: entry.title,
        link: entry.link,
        thumbnail: toMobileThumbnail(detail.ogImage),
        summary,
        category: entry.category,
        addDate: entry.addDate,
        searchText: detail.bodyText.slice(0, SEARCH_TEXT_LIMIT),
      });
    } catch (err) {
      newSiteEntries.push({
        postId: entry.postId,
        title: entry.title,
        link: entry.link,
        thumbnail: null,
        summary: null,
        category: entry.category,
        addDate: entry.addDate,
        searchText: "",
        error: String(err.message ?? err),
      });
    }
  }

  await env.POSTS_KV.put("archive", JSON.stringify([...newEntries, ...archive]));
  await env.POSTS_KV.put("posts", JSON.stringify([...newSiteEntries, ...posts]));

  return { newCount: newEntries.length, titles: newEntries.map((e) => e.title) };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/data/posts.json") {
      const posts = await env.POSTS_KV.get("posts", "text");
      if (posts) {
        return new Response(posts, {
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      return env.ASSETS.fetch(request);
    }

    if (url.pathname === "/api/refresh") {
      const key = url.searchParams.get("key") ?? request.headers.get("x-admin-key");
      if (!env.ADMIN_REFRESH_KEY || key !== env.ADMIN_REFRESH_KEY) {
        return new Response("Unauthorized", { status: 401 });
      }
      try {
        const result = await runSync(env);
        return new Response(JSON.stringify(result), {
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err.message ?? err) }), {
          status: 500,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSync(env));
  },
};
