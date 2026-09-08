import Fuse from "./vendor/fuse.min.mjs";

const RECENT_COUNT = 12;
const MAX_RESULTS = 24;
const DEBOUNCE_MS = 250;

const resultsEl = document.getElementById("results");
const headingEl = document.getElementById("results-heading");
const formEl = document.getElementById("search-form");
const inputEl = document.getElementById("search-input");
const popularEl = document.getElementById("popular-searches");

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function cardHtml(p) {
  return `
    <a class="post-card" href="${p.link}" target="_blank" rel="noopener">
      <img class="post-thumb" src="${p.thumbnail ?? ""}" alt="" loading="lazy" referrerpolicy="no-referrer" />
      <div class="post-body">
        <h3 class="post-title">${escapeHtml(p.title)}</h3>
        <p class="post-summary">${escapeHtml(p.summary ?? "")}</p>
      </div>
    </a>`;
}

function logSearch(term) {
  fetch("/api/log-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ term }),
  }).catch(() => {});
}

function renderPopularSearches(items) {
  if (!items || items.length === 0) {
    popularEl.innerHTML = "";
    return;
  }
  popularEl.innerHTML =
    `<span class="popular-label">인기 검색어</span>` +
    items
      .map(
        (item, i) =>
          `<button type="button" class="popular-term" data-term="${escapeHtml(item.term)}"><span class="rank">${i + 1}</span>${escapeHtml(item.term)}</button>`
      )
      .join("");
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function buildSynonymExpander(synonymGroups) {
  return function expandQuery(term) {
    const expanded = new Set([term]);
    for (const group of synonymGroups) {
      const matchedInGroup = group.some(
        (g) => term.includes(g) || g.includes(term)
      );
      if (matchedInGroup) {
        for (const g of group) expanded.add(g);
      }
    }
    return [...expanded];
  };
}

async function main() {
  const [postsRes, synonymsRes] = await Promise.all([
    fetch("./data/posts.json"),
    fetch("./data/synonyms.json"),
  ]);
  const posts = await postsRes.json();
  const synonymGroups = await synonymsRes.json().catch(() => []);
  const expandQuery = buildSynonymExpander(synonymGroups);

  const fuse = new Fuse(posts, {
    keys: [
      { name: "title", weight: 0.4 },
      { name: "summary", weight: 0.3 },
      { name: "searchText", weight: 0.2 },
      { name: "category", weight: 0.1 },
    ],
    threshold: 0.35,
    ignoreLocation: true,
  });

  function showRecent() {
    headingEl.textContent = "최근 포스팅";
    resultsEl.innerHTML = posts.slice(0, RECENT_COUNT).map(cardHtml).join("");
  }

  function searchWithSynonyms(query) {
    const terms = expandQuery(query);
    const bestByPostId = new Map();
    for (const term of terms) {
      for (const r of fuse.search(term, { limit: MAX_RESULTS })) {
        const existing = bestByPostId.get(r.item.postId);
        if (!existing || r.score < existing.score) {
          bestByPostId.set(r.item.postId, r);
        }
      }
    }
    return [...bestByPostId.values()]
      .sort((a, b) => a.score - b.score)
      .slice(0, MAX_RESULTS)
      .map((r) => r.item);
  }

  function runSearch(query) {
    const trimmed = query.trim();
    if (trimmed === "") {
      showRecent();
      return;
    }

    const matches = searchWithSynonyms(trimmed);

    if (matches.length === 0) {
      headingEl.textContent = `"${trimmed}" 검색 결과 없음`;
      const emptyMsg = `<p class="empty-state">검색 결과가 없습니다. 대신 최근 포스팅을 보여드릴게요.</p>`;
      const recentCards = posts.slice(0, RECENT_COUNT).map(cardHtml).join("");
      resultsEl.innerHTML = emptyMsg + recentCards;
      return;
    }

    headingEl.textContent = `"${trimmed}" 검색 결과 (${matches.length}건)`;
    resultsEl.innerHTML = matches.map(cardHtml).join("");
  }

  showRecent();

  fetch("/api/top-searches")
    .then((res) => res.json())
    .then(renderPopularSearches)
    .catch(() => {});

  popularEl.addEventListener("click", (e) => {
    const button = e.target.closest(".popular-term");
    if (!button) return;
    const term = button.dataset.term;
    inputEl.value = term;
    runSearch(term);
    logSearch(term);
  });

  const debouncedSearch = debounce(runSearch, DEBOUNCE_MS);
  inputEl.addEventListener("input", () => debouncedSearch(inputEl.value));
  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    const trimmed = inputEl.value.trim();
    runSearch(inputEl.value);
    if (trimmed) logSearch(trimmed);
  });
}

main();
