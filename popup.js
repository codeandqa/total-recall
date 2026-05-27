// =============================================================================
// POPUP SCRIPT — The search UI you see when you click the extension icon
// =============================================================================
//
// This script handles:
//   1. Loading stats (event count, last event time)
//   2. Sending search queries to background.js
//   3. Rendering results as interactive cards
//   4. Filtering results by event type
//   5. Clearing all stored data
//
// =============================================================================

// ---------------------------------------------------------------------------
// ELEMENT REFERENCES — grab all the HTML elements we need to control
// ---------------------------------------------------------------------------
const $q = document.getElementById("q");            // Search input
const $go = document.getElementById("go");           // Search button
const $results = document.getElementById("results"); // Results container
const $empty = document.getElementById("empty");     // Empty state message
const $status = document.getElementById("status");   // Loading indicator
const $statusMsg = document.getElementById("status-msg");
const $statCount = document.getElementById("stat-count");
const $statLast = document.getElementById("stat-last");
const $method = document.getElementById("method");
const $clear = document.getElementById("clear");
const $filters = document.getElementById("filters");
const $openChat = document.getElementById("open-chat");
const $viewToggle = document.querySelectorAll(".view-btn");
const $searchView = document.getElementById("search-view");
const $topicsView = document.getElementById("topics-view");
const $topicsList = document.getElementById("topics-list");
const $topicsLoading = document.getElementById("topics-loading");
const $topicsEmpty = document.getElementById("topics-empty");

// Current search results (stored for filtering)
let currentResults = [];
let activeFilter = "all";
let topicsLoaded = false;

// ===========================================================================
// OPEN CHAT SIDE PANEL — click the chat button to open it
// ===========================================================================
$openChat.addEventListener("click", async () => {
  // The side panel can be opened from the background script
  // We send a message and also try the direct API
  try {
    await chrome.runtime.sendMessage({ action: "OPEN_SIDEPANEL" });
  } catch {
    // Fallback: try opening directly (works in some Chrome versions)
    try {
      await chrome.sidePanel.open({});
    } catch { /* ignore */ }
  }
  // Close the popup
  window.close();
});

// ===========================================================================
// LOAD STATS — runs when the popup opens
// ===========================================================================
(async function loadStats() {
  try {
    const stats = await chrome.runtime.sendMessage({ action: "STATS" });
    $statCount.textContent = (stats.total || 0).toLocaleString();
    $statLast.textContent = stats.lastTime ? timeAgo(stats.lastTime) : "none yet";
  } catch {
    $statCount.textContent = "—";
    $statLast.textContent = "—";
  }
})();

// ===========================================================================
// SEARCH — send query to background, display results
// ===========================================================================
async function search() {
  const query = $q.value.trim();
  if (!query) return;

  // Show loading state
  $go.disabled = true;
  showStatus("Searching your memory...");
  $empty.style.display = "none";
  $filters.classList.remove("visible");
  clearCards();

  try {
    const res = await chrome.runtime.sendMessage({ action: "SEARCH", query });

    hideStatus();
    $go.disabled = false;

    if (!res?.results?.length) {
      showEmpty(query);
      return;
    }

    currentResults = res.results;
    activeFilter = "all";

    // Show search method
    $method.textContent =
      res.method === "semantic"
        ? "AI semantic search"
        : "Keyword search (AI model loading...)";

    // Show filters and render results
    $filters.classList.add("visible");
    resetFilterButtons();
    renderResults(currentResults);

  } catch (err) {
    hideStatus();
    $go.disabled = false;
    $statusMsg.textContent = "Error: " + err.message;
    $status.classList.add("visible");
  }
}

// Trigger search on button click or Enter
$go.addEventListener("click", search);
$q.addEventListener("keydown", (e) => { if (e.key === "Enter") search(); });

// ===========================================================================
// FILTER TABS — let users filter results by event type
// ===========================================================================
$filters.addEventListener("click", (e) => {
  const btn = e.target.closest(".filter-btn");
  if (!btn) return;

  activeFilter = btn.dataset.type;
  resetFilterButtons();
  btn.classList.add("active");

  const filtered =
    activeFilter === "all"
      ? currentResults
      : currentResults.filter((r) => {
          if (activeFilter === "sheets") {
            return r.type.startsWith("sheets_");
          }
          return r.type === activeFilter;
        });

  clearCards();
  if (filtered.length === 0) {
    $results.innerHTML =
      '<div class="empty"><h3>No results for this filter</h3></div>';
  } else {
    renderResults(filtered);
  }
});

function resetFilterButtons() {
  $filters.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
}

// ===========================================================================
// RENDER RESULTS — build result cards
// ===========================================================================
function renderResults(list) {
  for (const item of list) {
    $results.appendChild(makeCard(item));
  }
}

function makeCard(r) {
  const card = document.createElement("div");
  card.className = "card";

  // Score display (percentage, clamped 0-99)
  const pct = r.score != null ? Math.min(99, Math.max(0, Math.round(r.score * 100))) : null;
  const reason = esc(r.reason || "No rationale available");
  const scoreHtml = pct != null
    ? `<span class="card-score has-tooltip" data-tooltip="${reason}">${pct}% match</span>`
    : "";

  // Context text
  const ctx = esc(r.context || (r.content || "").slice(0, 150));

  // Type badge with emoji
  const emojis = {
    pageview: "📄", click: "👆", selection: "✂️", input: "⌨️",
    search: "🔍", sheets_edit: "📊", sheets_select: "📊",
    sheets_content: "📊", tab_focus: "🔀", page_leave: "👋",
  };
  const emoji = emojis[r.type] || "📌";
  const typeLabel = r.type.replace(/_/g, " ");

  card.innerHTML = `
    <div class="card-top">
      <span class="card-title">${esc(r.title || "Untitled")}</span>
      ${scoreHtml}
    </div>
    <div class="card-context">${ctx}</div>
    <div class="card-bottom">
      <span class="badge badge-${r.type}">${emoji} ${typeLabel}</span>
      <span>${timeAgo(r.timestamp)}</span>
      <span class="card-url" title="${esc(r.url || "")}">${shortUrl(r.url)}</span>
    </div>
  `;

  // Click card to open the page and highlight search terms
  card.addEventListener("click", () => {
    if (r.url) {
      const query = $q.value.trim();
      chrome.runtime.sendMessage({
        action: "OPEN_AND_HIGHLIGHT",
        url: r.url,
        query: query,
      });
    }
  });

  return card;
}

// ===========================================================================
// UI HELPERS
// ===========================================================================
function showStatus(msg) {
  $statusMsg.textContent = msg;
  $status.classList.add("visible", "active");
}

function hideStatus() {
  $status.classList.remove("visible", "active");
}

function clearCards() {
  $results.querySelectorAll(".card, .empty").forEach((el) => el.remove());
}

function showEmpty(query) {
  $results.innerHTML = `
    <div class="empty">
      <div class="big-icon">🤷</div>
      <h3>Nothing found</h3>
      <p>
        No results for <code>${esc(query)}</code>.<br />
        Browse some pages first, or try different words.<br />
        <small>If the AI model is still loading, try again in 30 seconds.</small>
      </p>
    </div>`;
}

// ===========================================================================
// CLEAR ALL DATA
// ===========================================================================
$clear.addEventListener("click", async () => {
  if (!confirm("Permanently delete all recorded browser activity?")) return;
  try {
    await chrome.runtime.sendMessage({ action: "CLEAR" });
    $statCount.textContent = "0";
    $statLast.textContent = "none yet";
    clearCards();
    $empty.style.display = "block";
    $filters.classList.remove("visible");
    $method.textContent = "Data cleared";
  } catch (err) {
    alert("Error: " + err.message);
  }
});

// ===========================================================================
// VIEW TOGGLE — switch between Search and Topics
// ===========================================================================
$viewToggle.forEach((btn) => {
  btn.addEventListener("click", () => {
    const view = btn.dataset.view;

    // Update button states
    $viewToggle.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    if (view === "search") {
      $searchView.style.display = "";
      $topicsView.style.display = "none";
      $results.style.display = "";
      $empty.style.display = "";
    } else {
      $searchView.style.display = "none";
      $topicsView.style.display = "";
      $results.style.display = "none";
      $empty.style.display = "none";
      if (!topicsLoaded) loadTopics();
    }
  });
});

// ===========================================================================
// TOPICS — fetch clusters and render them
// ===========================================================================
async function loadTopics() {
  $topicsLoading.style.display = "flex";
  $topicsEmpty.style.display = "none";
  $topicsList.innerHTML = "";

  try {
    const data = await chrome.runtime.sendMessage({ action: "TOPICS" });
    $topicsLoading.style.display = "none";

    if (!data?.clusters?.length) {
      $topicsEmpty.style.display = "block";
      return;
    }

    topicsLoaded = true;

    // Sort clusters: biggest first
    const sorted = data.clusters.sort((a, b) => b.events.length - a.events.length);

    for (const cluster of sorted) {
      $topicsList.appendChild(makeTopicCard(cluster));
    }
  } catch (err) {
    $topicsLoading.style.display = "none";
    $topicsList.innerHTML =
      `<div class="topics-empty"><h3>Error loading topics</h3><p>${esc(err.message)}</p></div>`;
  }
}

function makeTopicCard(cluster) {
  const card = document.createElement("div");
  card.className = "topic-card";

  // Collect unique domains
  const domains = [...new Set(
    cluster.events
      .filter((e) => e.url)
      .map((e) => { try { return new URL(e.url).hostname; } catch { return ""; } })
      .filter(Boolean)
  )].slice(0, 4);

  const domainsText = domains.length > 0 ? domains.join(", ") : "various pages";

  // Header (always visible)
  const header = document.createElement("div");
  header.className = "topic-header";
  header.innerHTML = `
    <span class="topic-label">${esc(cluster.label)}</span>
    <div class="topic-meta">
      <span class="topic-count">${cluster.events.length} events</span>
      <span class="topic-arrow">▶</span>
    </div>
  `;

  // Domains subtitle
  const domainsEl = document.createElement("div");
  domainsEl.className = "topic-domains";
  domainsEl.textContent = domainsText;

  // Expandable events list
  const eventsEl = document.createElement("div");
  eventsEl.className = "topic-events";

  const emojis = {
    pageview: "📄", click: "👆", selection: "✂️", input: "⌨️",
    search: "🔍", sheets_edit: "📊", sheets_select: "📊",
    sheets_content: "📊", tab_focus: "🔀", page_leave: "👋",
  };

  // Show up to 20 events per cluster
  for (const evt of cluster.events.slice(0, 20)) {
    const emoji = emojis[evt.type] || "📌";
    const row = document.createElement("div");
    row.className = "topic-event";
    row.innerHTML = `
      <span class="topic-event-emoji">${emoji}</span>
      <div class="topic-event-info">
        <div class="topic-event-title">${esc(evt.title || "Untitled")}</div>
        <div class="topic-event-url">${shortUrl(evt.url)}</div>
      </div>
      <span class="topic-event-time">${timeAgo(evt.timestamp)}</span>
    `;
    // Click to open the page
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      if (evt.url) {
        chrome.runtime.sendMessage({
          action: "OPEN_AND_HIGHLIGHT",
          url: evt.url,
          query: "",
        });
      }
    });
    eventsEl.appendChild(row);
  }

  // Toggle expand/collapse on header click
  header.addEventListener("click", () => {
    card.classList.toggle("expanded");
  });

  card.appendChild(header);
  card.appendChild(domainsEl);
  card.appendChild(eventsEl);
  return card;
}

// ===========================================================================
// UTILITY FUNCTIONS
// ===========================================================================

// "3 minutes ago", "2 hours ago", "Jan 15"
function timeAgo(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return Math.floor(sec / 60) + "m ago";
  if (sec < 86400) return Math.floor(sec / 3600) + "h ago";
  if (sec < 604800) return Math.floor(sec / 86400) + "d ago";
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// "docs.google.com/spreadshee..."
function shortUrl(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    const path = u.pathname.length > 1 ? u.pathname.slice(0, 25) + "…" : "";
    return u.hostname + path;
  } catch {
    return url.slice(0, 35);
  }
}

// Prevent XSS by escaping HTML special characters
function esc(s) {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// Export for testing (no effect in browser — module is undefined)
if (typeof module !== "undefined") {
  module.exports = {
    timeAgo, shortUrl, esc, makeCard, showStatus, hideStatus,
    clearCards, showEmpty, renderResults, makeTopicCard, loadTopics,
    search, resetFilterButtons,
  };
}
