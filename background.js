// =============================================================================
// BACKGROUND SERVICE WORKER — The brain of the extension
// =============================================================================
//
// This runs invisibly in the background. Its three jobs:
//
//   1. RECEIVE events from content.js and save them to IndexedDB
//   2. MANAGE the offscreen document (hidden page running the AI model)
//   3. HANDLE search queries from the popup
//
// Data flow:
//   content.js → (message) → background.js → (save) → IndexedDB
//                                           → (embed) → offscreen.js
//   popup.js → (search query) → background.js → (cosine similarity) → results
//
// =============================================================================

// Load the shared database helper
importScripts("db.js");

// ---------------------------------------------------------------------------
// SETTINGS
// ---------------------------------------------------------------------------
const BATCH_SIZE = 10;          // Embed this many events at a time
const EMBED_INTERVAL_MIN = 0.25; // Run embedding every 15 seconds

// ---------------------------------------------------------------------------
// DEDUPLICATION — prevent saving the same event twice in a row
// ---------------------------------------------------------------------------
// When you click a button, the browser might fire several events within
// milliseconds. We keep a short memory of recent events and skip duplicates.
// ---------------------------------------------------------------------------
const recent = new Map();

function isDuplicate(evt) {
  const key = evt.type + "|" + evt.url;
  const now = Date.now();
  if (recent.has(key) && now - recent.get(key) < 2000) return true;
  recent.set(key, now);

  // Clean up old entries to prevent memory growth
  if (recent.size > 300) {
    const cutoff = now - 10000;
    for (const [k, t] of recent) {
      if (t < cutoff) recent.delete(k);
    }
  }
  return false;
}

// ===========================================================================
// MESSAGE ROUTER — listens for all messages and routes them
// ===========================================================================
chrome.runtime.onMessage.addListener((msg, sender, reply) => {

  // --- From content.js: a new event was captured ---
  if (msg.source === "content" && msg.event) {
    onEvent(msg.event);
    return false; // synchronous, no reply needed
  }

  // --- From popup.js: user wants to search ---
  if (msg.action === "SEARCH") {
    handleSearch(msg.query).then(reply);
    return true; // async reply
  }

  // --- From popup.js: request stats ---
  if (msg.action === "STATS") {
    getStats().then(reply);
    return true;
  }

  // --- From popup.js: clear all data ---
  if (msg.action === "CLEAR") {
    clearAllEvents().then(() => reply({ ok: true }));
    return true;
  }

  // --- From popup.js: open a page and highlight search terms ---
  if (msg.action === "OPEN_AND_HIGHLIGHT") {
    openAndHighlight(msg.url, msg.query);
    return false;
  }

  // --- From sidepanel.js: search history for chat context ---
  if (msg.action === "CHAT_SEARCH") {
    handleSearch(msg.query).then(reply);
    return true;
  }

  // --- From popup.js: open the side panel ---
  if (msg.action === "OPEN_SIDEPANEL") {
    chrome.sidePanel.open({ windowId: sender.tab?.windowId }).catch(() => {});
    return false;
  }

  // --- From popup.js: get topic clusters ---
  if (msg.action === "TOPICS") {
    getTopicClusters().then(reply);
    return true;
  }

  // --- From offscreen.js: embedding result for a stored event ---
  if (msg.action === "EMBED_DONE") {
    onEmbedDone(msg);
    return false;
  }

  // --- From offscreen.js: embedding result for a search query ---
  if (msg.action === "QUERY_EMBED_DONE") {
    // Handled by the Promise listener in handleSearch — nothing to do here
    return false;
  }
});

// ===========================================================================
// 1) SAVE EVENTS
// ===========================================================================
async function onEvent(evt) {
  try {
    // Ignore extension's own pages
    if (evt.url && evt.url.startsWith("chrome-extension://")) return;
    if (evt.url && evt.url.startsWith("chrome://")) return;

    // Skip duplicates
    if (isDuplicate(evt)) return;

    const id = await saveEvent(evt);
    console.log("[TR] Saved", evt.type, "→ id", id);
  } catch (err) {
    console.error("[TR] Save error:", err);
  }
}

// ===========================================================================
// 2) OFFSCREEN DOCUMENT — manages the hidden page running the AI model
// ===========================================================================
// Chrome MV3 service workers can't load heavy libraries directly.
// So we create an "offscreen document" — a hidden web page where
// transformers.js can run with full browser APIs available.
// ===========================================================================
async function ensureOffscreen() {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    if (contexts.length > 0) return; // Already running

    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification: "Run transformers.js AI model for text embeddings",
    });
    console.log("[TR] Offscreen document created");
  } catch (err) {
    if (!err.message?.includes("already exists")) {
      console.error("[TR] Offscreen error:", err);
    }
  }
}

// ===========================================================================
// 3) EMBEDDING PIPELINE — periodically process un-embedded events
// ===========================================================================
async function runEmbeddingBatch() {
  try {
    await ensureOffscreen();

    const batch = await getUnembeddedEvents(BATCH_SIZE);
    if (batch.length === 0) return;

    console.log("[TR] Embedding", batch.length, "events...");

    for (const evt of batch) {
      // Combine title + context + content for a richer embedding
      const text = [evt.title, evt.context, (evt.content || "").slice(0, 2000)]
        .filter(Boolean)
        .join(" — ");

      if (text.length < 5) {
        // Too short to embed meaningfully — mark as done with empty vector
        await updateEvent(evt.id, { embedding: [] });
        continue;
      }

      chrome.runtime.sendMessage({
        action: "EMBED",
        target: "offscreen",
        eventId: evt.id,
        text: text,
      });
    }
  } catch (err) {
    console.error("[TR] Embedding batch error:", err);
  }
}

// Handle embedding results from offscreen.js
async function onEmbedDone(msg) {
  try {
    if (msg.error) {
      console.error("[TR] Embed error for", msg.eventId, ":", msg.error);
      return;
    }
    await updateEvent(msg.eventId, { embedding: Array.from(msg.embedding) });
    console.log("[TR] Embedded event", msg.eventId);
  } catch (err) {
    console.error("[TR] Error storing embedding:", err);
  }
}

// ===========================================================================
// 4) SEARCH — find events matching a natural language query
// ===========================================================================
async function handleSearch(query) {
  try {
    await ensureOffscreen();

    // Step 1: Get an embedding for the search query
    const qEmbed = await getQueryEmbedding(query);

    if (!qEmbed) {
      // AI model not ready yet — fall back to keyword search
      return keywordSearch(query);
    }

    // Step 2: Get all events that have embeddings
    const events = await getEmbeddedEvents();

    // Step 3: Score each event by how similar its meaning is to the query
    const scored = events.map((e) => {
      const raw = cosineSimilarity(qEmbed, e.embedding);
      // Clamp to 0-1 range (cosine sim can occasionally be slightly negative)
      const score = Math.max(0, Math.min(1, raw));

      // Build a human-readable reason for the match score
      const reason = buildSemanticReason(score, e, query);

      return {
        id: e.id,
        type: e.type,
        url: e.url,
        title: e.title,
        timestamp: e.timestamp,
        content: (e.content || "").slice(0, 300),
        context: e.context,
        metadata: e.metadata,
        score: score,
        reason: reason,
      };
    });

    // Step 4: Sort by score, return the top 25
    scored.sort((a, b) => b.score - a.score);

    return { results: scored.slice(0, 25), method: "semantic" };
  } catch (err) {
    console.error("[TR] Search error:", err);
    return keywordSearch(query);
  }
}

// ---------------------------------------------------------------------------
// Get embedding for the search query from offscreen.js
// ---------------------------------------------------------------------------
function getQueryEmbedding(query) {
  return new Promise((resolve) => {
    const rid = "q_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);

    const listener = (msg) => {
      if (msg.action === "QUERY_EMBED_DONE" && msg.rid === rid) {
        chrome.runtime.onMessage.removeListener(listener);
        resolve(msg.error ? null : Array.from(msg.embedding));
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    chrome.runtime.sendMessage({
      action: "EMBED_QUERY",
      target: "offscreen",
      rid: rid,
      text: query,
    });

    // If the model doesn't respond in 30 seconds, give up and use keywords
    setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      resolve(null);
    }, 30000);
  });
}

// ---------------------------------------------------------------------------
// FALLBACK: keyword search (works even before AI model loads)
// ---------------------------------------------------------------------------
async function keywordSearch(query) {
  const events = await getAllEvents(500);
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return { results: [], method: "keyword" };

  // Maximum possible raw score: each word can score 1.5 (1 for content + 0.5 for title)
  const maxRaw = words.length * 1.5;

  const scored = events.map((e) => {
    const blob = [e.title, e.content, e.context, e.url].join(" ").toLowerCase();
    const titleLower = (e.title || "").toLowerCase();

    let rawScore = 0;
    const matchedWords = [];
    const titleMatches = [];

    for (const w of words) {
      if (blob.includes(w)) {
        rawScore += 1;
        matchedWords.push(w);
        if (titleLower.includes(w)) {
          rawScore += 0.5;
          titleMatches.push(w);
        }
      }
    }

    // Normalize score to 0–1 range
    const score = rawScore / maxRaw;

    // Build reason
    const parts = [];
    if (matchedWords.length > 0) {
      parts.push(`Matched ${matchedWords.length}/${words.length} keywords: "${matchedWords.join('", "')}"`);
    }
    if (titleMatches.length > 0) {
      parts.push(`Title contains: "${titleMatches.join('", "')}"`);
    }
    const reason = parts.join(". ") + ".";

    return {
      id: e.id,
      type: e.type,
      url: e.url,
      title: e.title,
      timestamp: e.timestamp,
      content: (e.content || "").slice(0, 300),
      context: e.context,
      metadata: e.metadata,
      score: score,
      reason: reason,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return {
    results: scored.filter((e) => e.score > 0).slice(0, 25),
    method: "keyword",
  };
}

// ---------------------------------------------------------------------------
// BUILD REASON — explain why a semantic search result scored as it did
// ---------------------------------------------------------------------------
function buildSemanticReason(score, event, query) {
  const parts = [];

  // Describe what the AI similarity means
  if (score >= 0.7) {
    parts.push("Very high semantic similarity — the meaning closely matches your query");
  } else if (score >= 0.5) {
    parts.push("Strong semantic similarity — the content is closely related to your query");
  } else if (score >= 0.35) {
    parts.push("Moderate semantic similarity — the content shares some meaning with your query");
  } else if (score >= 0.2) {
    parts.push("Weak semantic similarity — loosely related to your query");
  } else {
    parts.push("Low semantic similarity — only distantly related");
  }

  // Add what was matched against
  const typeLabels = {
    pageview: "page visit",
    click: "click action",
    selection: "text selection",
    input: "form input",
    search: "search query",
    sheets_edit: "Google Sheets edit",
    sheets_select: "Google Sheets cell selection",
    sheets_content: "Google Sheets data",
    tab_focus: "tab switch",
    page_leave: "page navigation",
  };
  const typeLabel = typeLabels[event.type] || event.type;
  parts.push(`Event type: ${typeLabel}`);

  // Check for direct keyword overlap as a bonus signal
  const queryWords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const eventText = [event.title, event.context, event.content].join(" ").toLowerCase();
  const overlapping = queryWords.filter((w) => eventText.includes(w));
  if (overlapping.length > 0) {
    parts.push(`Also contains keywords: "${overlapping.join('", "')}"`);
  }

  return parts.join(". ") + ".";
}

// ===========================================================================
// 5) STATS — summary for the popup header
// ===========================================================================
async function getStats() {
  const total = await countEvents();
  const latest = await getAllEvents(1);
  return {
    total: total,
    lastTime: latest.length > 0 ? latest[0].timestamp : null,
  };
}

// ===========================================================================
// 6) OPEN PAGE AND HIGHLIGHT — opens a URL and highlights search terms
// ===========================================================================
// When the user clicks a search result, we:
//   1. Open the page in a new tab
//   2. Wait for it to finish loading
//   3. Send the search query to the content script on that tab
//   4. The content script wraps matching words in yellow <mark> tags
// ===========================================================================
function openAndHighlight(url, query) {
  chrome.tabs.create({ url: url }, (tab) => {
    if (!query || !tab) return;

    // Wait for the tab to finish loading before sending the highlight message
    const listener = (tabId, changeInfo) => {
      if (tabId === tab.id && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);

        // Small delay to let the content script initialize
        setTimeout(() => {
          chrome.tabs.sendMessage(tab.id, {
            action: "HIGHLIGHT",
            query: query,
          }).catch(() => {
            // Content script might not be ready — retry once
            setTimeout(() => {
              chrome.tabs.sendMessage(tab.id, {
                action: "HIGHLIGHT",
                query: query,
              }).catch(() => {}); // Give up silently
            }, 1500);
          });
        }, 500);
      }
    };

    chrome.tabs.onUpdated.addListener(listener);

    // Safety timeout — stop listening after 15 seconds
    setTimeout(() => chrome.tabs.onUpdated.removeListener(listener), 15000);
  });
}

// ===========================================================================
// 7) TOPIC CLUSTERING — group events by semantic similarity
// ===========================================================================
// Uses a simplified k-means algorithm on the embedding vectors.
// Groups similar pages/events together and labels each cluster
// with the most representative title from that group.
// ===========================================================================
async function getTopicClusters() {
  const events = await getEmbeddedEvents();

  // Only cluster pageviews and meaningful events (not tab_focus etc.)
  const meaningful = events.filter(
    (e) => e.embedding.length > 0 &&
           ["pageview", "search", "selection", "sheets_content", "sheets_edit", "input"].includes(e.type)
  );

  if (meaningful.length < 3) {
    return { clusters: [], message: "Not enough data yet — keep browsing!" };
  }

  // Choose number of clusters: roughly sqrt(n), min 3, max 10
  const k = Math.min(10, Math.max(3, Math.round(Math.sqrt(meaningful.length))));

  // Run k-means
  const assignments = kMeans(meaningful.map((e) => e.embedding), k, 15);

  // Group events by cluster
  const groups = {};
  meaningful.forEach((event, i) => {
    const c = assignments[i];
    if (!groups[c]) groups[c] = [];
    groups[c].push(event);
  });

  // Build cluster summaries
  const clusters = Object.values(groups)
    .filter((g) => g.length >= 1)
    .map((group) => {
      // Sort by timestamp (newest first)
      group.sort((a, b) => b.timestamp - a.timestamp);

      // Label: use the most common domain or most descriptive title
      const label = pickClusterLabel(group);

      // Collect unique domains
      const domains = [...new Set(group.map((e) => {
        try { return new URL(e.url).hostname; } catch { return "unknown"; }
      }))].slice(0, 5);

      return {
        label: label,
        count: group.length,
        domains: domains,
        latest: group[0].timestamp,
        events: group.slice(0, 8).map((e) => ({
          id: e.id,
          type: e.type,
          title: e.title,
          url: e.url,
          context: e.context,
          timestamp: e.timestamp,
        })),
      };
    })
    .sort((a, b) => b.count - a.count); // Biggest clusters first

  return { clusters };
}

// --- Pick a readable label for a cluster ---
function pickClusterLabel(events) {
  // Count title word frequencies (skip very common words)
  const stopWords = new Set(["the", "and", "for", "you", "that", "this", "with", "from",
    "are", "was", "has", "have", "will", "can", "not", "but", "all", "your", "one",
    "our", "out", "new", "how", "its", "get", "about", "been", "more", "when", "who",
    "may", "than", "them", "had", "what", "each", "make", "like", "just", "into",
    "also", "use", "two", "way", "google", "home", "page", "search", "http", "https",
    "www", "com", "org", "net"]);

  const wordCounts = {};
  events.forEach((e) => {
    const title = (e.title || "").toLowerCase();
    title.split(/\s+/).forEach((w) => {
      w = w.replace(/[^a-z0-9]/g, "");
      if (w.length > 2 && !stopWords.has(w)) {
        wordCounts[w] = (wordCounts[w] || 0) + 1;
      }
    });
  });

  // Get top 2-3 words as the label
  const topWords = Object.entries(wordCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([w]) => w.charAt(0).toUpperCase() + w.slice(1));

  if (topWords.length > 0) return topWords.join(", ");

  // Fallback to first event title
  return events[0]?.title?.slice(0, 40) || "Misc";
}

// --- K-Means clustering algorithm ---
function kMeans(vectors, k, maxIter) {
  const n = vectors.length;
  const dim = vectors[0].length;

  // Initialize centroids by picking k random vectors
  const centroidIdxs = new Set();
  while (centroidIdxs.size < k) {
    centroidIdxs.add(Math.floor(Math.random() * n));
  }
  let centroids = [...centroidIdxs].map((i) => [...vectors[i]]);

  let assignments = new Array(n).fill(0);

  for (let iter = 0; iter < maxIter; iter++) {
    // Assign each vector to nearest centroid
    const newAssignments = vectors.map((vec) => {
      let bestDist = Infinity;
      let bestC = 0;
      for (let c = 0; c < centroids.length; c++) {
        let dist = 0;
        for (let d = 0; d < dim; d++) {
          const diff = vec[d] - centroids[c][d];
          dist += diff * diff;
        }
        if (dist < bestDist) {
          bestDist = dist;
          bestC = c;
        }
      }
      return bestC;
    });

    // Check for convergence
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (newAssignments[i] !== assignments[i]) { changed = true; break; }
    }
    assignments = newAssignments;
    if (!changed) break;

    // Recompute centroids
    const sums = Array.from({ length: k }, () => new Float64Array(dim));
    const counts = new Array(k).fill(0);

    for (let i = 0; i < n; i++) {
      const c = assignments[i];
      counts[c]++;
      for (let d = 0; d < dim; d++) {
        sums[c][d] += vectors[i][d];
      }
    }

    centroids = sums.map((s, c) => {
      if (counts[c] === 0) return centroids[c]; // Keep old if empty
      return Array.from(s).map((v) => v / counts[c]);
    });
  }

  return assignments;
}

// ===========================================================================
// 8) SCHEDULING — run embedding batch every 15 seconds using Chrome alarms
// ===========================================================================
// Chrome MV3 service workers can be terminated at any time. Alarms survive
// this and wake the worker back up, ensuring embeddings keep processing.
// ===========================================================================
chrome.alarms.create("embed", {
  delayInMinutes: EMBED_INTERVAL_MIN,
  periodInMinutes: EMBED_INTERVAL_MIN,
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "embed") runEmbeddingBatch();
});

// Also run once shortly after startup
setTimeout(() => runEmbeddingBatch(), 5000);

console.log("[TR] Background service worker ready");

// Export for testing (no effect in browser — module is undefined)
if (typeof module !== "undefined") {
  module.exports = {
    isDuplicate, onEvent, handleSearch, keywordSearch, buildSemanticReason,
    getStats, kMeans, pickClusterLabel, getTopicClusters, onEmbedDone,
    ensureOffscreen, runEmbeddingBatch, openAndHighlight, recent,
  };
}
