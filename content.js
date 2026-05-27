// =============================================================================
// CONTENT SCRIPT — Runs on every web page you visit
// =============================================================================
//
// HOW IT WORKS:
// Chrome injects this script into every page you open. It quietly watches
// for user actions (clicks, typing, selecting text, etc.) and sends each
// event to background.js for storage and AI embedding.
//
// WHAT IT CAPTURES:
//   - Page load    → full text content of the page
//   - Clicks       → what you clicked and nearby text
//   - Selections   → text you highlight with your mouse
//   - Typing       → what you type into search bars and forms
//   - Google Sheets → cell edits, cell selections, visible data
//   - Navigation   → when you switch tabs or leave a page
//
// =============================================================================

// ---------------------------------------------------------------------------
// SETTINGS — adjust these to balance capture detail vs. performance
// ---------------------------------------------------------------------------
const SETTINGS = {
  TYPING_WAIT_MS: 1000,       // Wait 1 second after typing stops to capture
  PAGE_LOAD_WAIT_MS: 2500,    // Wait 2.5s for page to settle before capture
  MAX_PAGE_TEXT: 20000,        // Max characters of page text to save
  MAX_CONTEXT: 300,            // Max characters of context per event
  MIN_SELECT_LENGTH: 3,        // Ignore selections shorter than this
  SHEETS_INTERVAL_MS: 30000,   // Capture Google Sheets data every 30 seconds
};

// ---------------------------------------------------------------------------
// SEND EVENT — delivers a captured event to background.js
// ---------------------------------------------------------------------------
// This function packages up event data and sends it via Chrome's messaging
// system to the background service worker, which saves it to the database.
// ---------------------------------------------------------------------------
function send(type, data) {
  chrome.runtime.sendMessage({
    source: "content",
    event: {
      type,
      url: location.href,
      title: document.title,
      timestamp: Date.now(),
      ...data,
    },
  }).catch(() => {
    // Silently ignore — happens when extension context is invalidated
    // (e.g., during extension reload or update)
  });
}

// ---------------------------------------------------------------------------
// EXTRACT PAGE TEXT — gets clean, readable text from the page
// ---------------------------------------------------------------------------
// We clone the body so we don't modify the live page, remove elements
// that don't contain useful text (scripts, styles, images), then extract
// and clean up the remaining text content.
// ---------------------------------------------------------------------------
function extractPageText() {
  const clone = document.body.cloneNode(true);

  // Remove elements that are noise, not content
  const noise = "script, style, noscript, svg, img, video, audio, canvas, iframe, [aria-hidden='true']";
  clone.querySelectorAll(noise).forEach((el) => el.remove());

  // Get text, collapse multiple spaces/newlines into single spaces
  let text = (clone.textContent || "").replace(/\s+/g, " ").trim();
  return text.slice(0, SETTINGS.MAX_PAGE_TEXT);
}

// ---------------------------------------------------------------------------
// GET CONTEXT — grabs text near a clicked element to provide context
// ---------------------------------------------------------------------------
function getContext(el) {
  // Start with the element's own text
  let text = (el.textContent || el.value || el.alt || "").replace(/\s+/g, " ").trim();

  // If too short, try the parent element for more context
  if (text.length < 15 && el.parentElement) {
    text = (el.parentElement.textContent || "").replace(/\s+/g, " ").trim();
  }

  return text.slice(0, SETTINGS.MAX_CONTEXT);
}

// ---------------------------------------------------------------------------
// DESCRIBE ELEMENT — creates a short CSS-like description of an element
// ---------------------------------------------------------------------------
// Example outputs: "button#submit.primary", "a.nav-link", "input[role=searchbox]"
// ---------------------------------------------------------------------------
function describe(el) {
  const tag = (el.tagName || "?").toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const cls =
    el.className && typeof el.className === "string"
      ? "." + el.className.split(" ").filter(Boolean).slice(0, 2).join(".")
      : "";
  const role = el.getAttribute?.("role") ? `[role=${el.getAttribute("role")}]` : "";
  return `${tag}${id}${cls}${role}`;
}

// ===========================================================================
//  1) PAGE LOAD — capture full page text after it settles
// ===========================================================================
setTimeout(() => {
  const text = extractPageText();
  if (text.length > 50) {
    send("pageview", {
      content: text,
      context: `Visited: ${document.title}`,
    });
  }
}, SETTINGS.PAGE_LOAD_WAIT_MS);

// ===========================================================================
//  2) CLICKS — capture what the user clicks on
// ===========================================================================
// We use { capture: true } so we catch clicks before any page JS can
// stop them, and { passive: true } so we don't slow down the page.
// ===========================================================================
document.addEventListener(
  "click",
  (e) => {
    const el = e.target;
    const ctx = getContext(el);
    const desc = describe(el);

    send("click", {
      content: ctx,
      context: `Clicked ${desc}: "${ctx.slice(0, 100)}"`,
      metadata: {
        element: desc,
        text: (el.textContent || "").slice(0, 120).trim(),
        href: el.href || el.closest?.("a")?.href || null,
      },
    });
  },
  { capture: true, passive: true }
);

// ===========================================================================
//  3) TEXT SELECTION — capture text the user highlights
// ===========================================================================
// We listen for mouseup because that's when a selection is finalized.
// A short delay lets the browser finish setting window.getSelection().
// ===========================================================================
document.addEventListener("mouseup", () => {
  setTimeout(() => {
    const sel = window.getSelection()?.toString().trim();
    if (sel && sel.length >= SETTINGS.MIN_SELECT_LENGTH) {
      send("selection", {
        content: sel.slice(0, 2000),
        context: `Selected: "${sel.slice(0, 120)}"`,
        metadata: { selectedText: sel.slice(0, 2000) },
      });
    }
  }, 150);
});

// ===========================================================================
//  4) TYPING — capture form inputs and searches (debounced)
// ===========================================================================
// Instead of recording every keystroke, we wait until the user stops
// typing for 1 second, then capture the final value. This is called
// "debouncing" — it reduces noise and improves performance.
// ===========================================================================
const timers = new Map();

document.addEventListener(
  "input",
  (e) => {
    const el = e.target;
    const tag = (el.tagName || "").toLowerCase();

    // Only capture text-like inputs, not checkboxes/sliders/etc.
    const textTypes = ["text", "search", "email", "url", "tel", "number", ""];
    if (tag !== "textarea" && !(tag === "input" && textTypes.includes(el.type))) return;

    // Clear any previous timer for this element
    if (timers.has(el)) clearTimeout(timers.get(el));

    // Start a new timer
    timers.set(
      el,
      setTimeout(() => {
        const val = (el.value || "").trim();
        if (val.length < 2) return;

        // Detect whether this is a search box
        const isSearch =
          el.type === "search" ||
          /search|query|q\b/i.test(el.name || "") ||
          el.getAttribute("role") === "searchbox" ||
          /search/i.test(el.placeholder || "") ||
          /search/i.test(el.getAttribute("aria-label") || "");

        const evtType = isSearch ? "search" : "input";
        const desc = describe(el);

        send(evtType, {
          content: val,
          context: `${isSearch ? "Searched for" : "Typed in " + desc}: "${val.slice(0, 120)}"`,
          metadata: {
            element: desc,
            inputType: el.type || "text",
            placeholder: el.placeholder || null,
            isSearch,
          },
        });

        timers.delete(el);
      }, SETTINGS.TYPING_WAIT_MS)
    );
  },
  { capture: true, passive: true }
);

// ===========================================================================
//  5) GOOGLE SHEETS — special handling for spreadsheet interactions
// ===========================================================================
// Google Sheets doesn't use normal HTML inputs. It renders everything on
// a canvas and uses custom DOM elements. We watch for changes in the
// formula bar and name box, plus periodically snapshot visible cell data.
// ===========================================================================
function isGoogleSheets() {
  return (
    location.hostname === "docs.google.com" &&
    location.pathname.includes("/spreadsheets/")
  );
}

if (isGoogleSheets()) {
  const sheetName = () => document.title.replace(" - Google Sheets", "").trim();

  // --- Watch the formula bar for cell edits ---
  const watchFormulaBar = () => {
    const bar = document.querySelector(
      "#t-formula-bar-input, .cell-input, .formulabar-input"
    );
    if (!bar) return null;

    const obs = new MutationObserver(() => {
      const val = (bar.textContent || "").trim();
      if (val.length > 0) {
        send("sheets_edit", {
          content: val,
          context: `Edited cell in "${sheetName()}": "${val.slice(0, 100)}"`,
          metadata: { sheet: sheetName(), cellValue: val },
        });
      }
    });

    obs.observe(bar, { childList: true, subtree: true, characterData: true });
    return obs;
  };

  // --- Watch the name box for cell selection changes (like "A1", "B2:D5") ---
  const watchNameBox = () => {
    const box = document.querySelector(
      "#t-name-box .cell-input, .jfk-textinput, .name-box-input, input[aria-label='Name Box']"
    );
    if (!box) return null;

    const obs = new MutationObserver(() => {
      const ref = (box.value || box.textContent || "").trim();
      if (/^[A-Z]+\d+/.test(ref)) {
        send("sheets_select", {
          content: ref,
          context: `Selected cell ${ref} in "${sheetName()}"`,
          metadata: { sheet: sheetName(), cell: ref },
        });
      }
    });

    obs.observe(box, { childList: true, subtree: true, attributes: true });
    return obs;
  };

  // --- Periodically snapshot visible cell data ---
  const snapshotCells = () => {
    const cells = document.querySelectorAll(".cell-inner, td[data-cell]");
    if (cells.length === 0) return;

    const values = [];
    cells.forEach((c) => {
      const t = (c.textContent || "").trim();
      if (t) values.push(t);
    });

    if (values.length > 0) {
      send("sheets_content", {
        content: values.join(" | ").slice(0, SETTINGS.MAX_PAGE_TEXT),
        context: `Sheet data in "${sheetName()}" (${values.length} cells)`,
        metadata: { sheet: sheetName(), cellCount: values.length },
      });
    }
  };

  // Start observing after Sheets finishes rendering
  setTimeout(() => {
    watchFormulaBar();
    watchNameBox();
    snapshotCells();

    // Re-snapshot every 30 seconds while the tab is active
    setInterval(() => {
      if (document.visibilityState === "visible") snapshotCells();
    }, SETTINGS.SHEETS_INTERVAL_MS);
  }, 5000);
}

// ===========================================================================
//  6) TAB FOCUS — know when the user switches back to this tab
// ===========================================================================
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    send("tab_focus", {
      content: document.title,
      context: `Returned to: "${document.title}"`,
    });
  }
});

// ===========================================================================
//  7) PAGE LEAVE — capture when the user navigates away
// ===========================================================================
window.addEventListener("beforeunload", () => {
  send("page_leave", {
    content: document.title,
    context: `Left: "${document.title}"`,
  });
});

// ===========================================================================
//  8) HIGHLIGHT — when a user opens a search result, highlight matching words
// ===========================================================================
// background.js sends a HIGHLIGHT message with the search query.
// We split the query into words and wrap every occurrence in the page
// with a bright yellow <mark> tag, then scroll to the first one.
// ===========================================================================
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.action === "HIGHLIGHT" && msg.query) {
    highlightTerms(msg.query);
    reply({ ok: true });
  }
  return false;
});

function highlightTerms(query) {
  // Split query into meaningful words (3+ chars)
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    // Remove very common words that would highlight too much
    .filter((w) => !["the", "and", "for", "that", "this", "with", "from", "was", "are", "have", "has"].includes(w));

  if (words.length === 0) return;

  // Remove any previous highlights first
  removeHighlights();

  // Inject the highlight styles (only once)
  if (!document.getElementById("tr-highlight-style")) {
    const style = document.createElement("style");
    style.id = "tr-highlight-style";
    style.textContent = `
      mark.tr-highlight {
        background: linear-gradient(120deg, #ffe066 0%, #ffcc02 100%);
        color: #1a1a1a;
        padding: 1px 3px;
        border-radius: 3px;
        box-shadow: 0 1px 3px rgba(0,0,0,0.15);
        font-weight: inherit;
        font-style: inherit;
      }
      #tr-highlight-bar {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        z-index: 2147483647;
        background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
        color: #e0e0f0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        padding: 8px 16px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        box-shadow: 0 2px 12px rgba(0,0,0,0.3);
        border-bottom: 2px solid #7c3aed;
      }
      #tr-highlight-bar .tr-info {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      #tr-highlight-bar .tr-count {
        color: #a78bfa;
        font-weight: 600;
      }
      #tr-highlight-bar .tr-nav-btn {
        background: #7c3aed;
        color: white;
        border: none;
        border-radius: 5px;
        padding: 4px 10px;
        margin: 0 3px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
      }
      #tr-highlight-bar .tr-nav-btn:hover {
        background: #6d28d9;
      }
      #tr-highlight-bar .tr-close {
        background: transparent;
        color: #8888a0;
        border: 1px solid #3a3a5e;
        border-radius: 5px;
        padding: 4px 10px;
        cursor: pointer;
        font-size: 12px;
      }
      #tr-highlight-bar .tr-close:hover {
        color: #f87171;
        border-color: #f87171;
      }
    `;
    document.head.appendChild(style);
  }

  // Walk through all text nodes in the page and highlight matching words
  const regex = new RegExp("(" + words.map(escapeRegex).join("|") + ")", "gi");
  let matchCount = 0;

  walkTextNodes(document.body, (textNode) => {
    const text = textNode.textContent;
    if (!regex.test(text)) return;
    regex.lastIndex = 0; // Reset regex state

    // Split text by matches and create a fragment with <mark> tags
    const frag = document.createDocumentFragment();
    let lastIdx = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
      // Add text before the match
      if (match.index > lastIdx) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx, match.index)));
      }

      // Add the highlighted match
      const mark = document.createElement("mark");
      mark.className = "tr-highlight";
      mark.textContent = match[0];
      frag.appendChild(mark);
      matchCount++;

      lastIdx = regex.lastIndex;
    }

    // Add remaining text after last match
    if (lastIdx < text.length) {
      frag.appendChild(document.createTextNode(text.slice(lastIdx)));
    }

    // Replace the original text node with our fragment
    textNode.parentNode.replaceChild(frag, textNode);
  });

  if (matchCount === 0) return;

  // Show the highlight bar at the top of the page
  showHighlightBar(matchCount, words);

  // Scroll to the first highlight
  const firstMark = document.querySelector("mark.tr-highlight");
  if (firstMark) {
    firstMark.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

// ---------------------------------------------------------------------------
// HIGHLIGHT BAR — fixed bar at top showing match count + prev/next buttons
// ---------------------------------------------------------------------------
let currentHighlightIdx = 0;

function showHighlightBar(count, words) {
  // Remove existing bar if any
  const existing = document.getElementById("tr-highlight-bar");
  if (existing) existing.remove();

  const bar = document.createElement("div");
  bar.id = "tr-highlight-bar";
  bar.innerHTML = `
    <div class="tr-info">
      <span>🧠 Total Recall:</span>
      <span class="tr-count">${count} matches</span>
      <span>for "${words.join(", ")}"</span>
    </div>
    <div>
      <button class="tr-nav-btn" id="tr-prev">Prev</button>
      <span id="tr-pos">1 / ${count}</span>
      <button class="tr-nav-btn" id="tr-next">Next</button>
      <button class="tr-close" id="tr-dismiss">Clear</button>
    </div>
  `;

  document.body.prepend(bar);
  currentHighlightIdx = 0;

  // Wire up buttons
  document.getElementById("tr-prev").addEventListener("click", () => navigateHighlight(-1));
  document.getElementById("tr-next").addEventListener("click", () => navigateHighlight(1));
  document.getElementById("tr-dismiss").addEventListener("click", () => {
    removeHighlights();
    bar.remove();
  });
}

function navigateHighlight(direction) {
  const marks = document.querySelectorAll("mark.tr-highlight");
  if (marks.length === 0) return;

  currentHighlightIdx = (currentHighlightIdx + direction + marks.length) % marks.length;
  marks[currentHighlightIdx].scrollIntoView({ behavior: "smooth", block: "center" });

  // Update position display
  const pos = document.getElementById("tr-pos");
  if (pos) pos.textContent = `${currentHighlightIdx + 1} / ${marks.length}`;
}

// ---------------------------------------------------------------------------
// REMOVE HIGHLIGHTS — cleans up all <mark> tags and restores original text
// ---------------------------------------------------------------------------
function removeHighlights() {
  document.querySelectorAll("mark.tr-highlight").forEach((mark) => {
    const text = document.createTextNode(mark.textContent);
    mark.parentNode.replaceChild(text, mark);
  });
  // Merge adjacent text nodes back together
  document.body.normalize();
}

// ---------------------------------------------------------------------------
// WALK TEXT NODES — iterates through all visible text on the page
// ---------------------------------------------------------------------------
function walkTextNodes(root, callback) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      // Skip script, style, and already-highlighted nodes
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" ||
          tag === "TEXTAREA" || tag === "INPUT" || tag === "MARK") {
        return NodeFilter.FILTER_REJECT;
      }
      // Skip hidden elements
      if (parent.offsetParent === null && tag !== "BODY" && tag !== "HTML") {
        return NodeFilter.FILTER_REJECT;
      }
      // Skip empty text
      if (node.textContent.trim().length === 0) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  // Collect nodes first (modifying DOM during walk causes issues)
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(callback);
}

// ---------------------------------------------------------------------------
// ESCAPE REGEX — safely use user input in a regular expression
// ---------------------------------------------------------------------------
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

console.log("[Total Recall] Content script active on:", location.href);

// Export for testing (no effect in browser — module is undefined)
if (typeof module !== "undefined") {
  module.exports = {
    SETTINGS, send, extractPageText, getContext, describe,
    isGoogleSheets, highlightTerms, removeHighlights, walkTextNodes,
    escapeRegex, showHighlightBar, navigateHighlight,
  };
}
