const path = require("path");

let popup;

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();

  // Set up minimal DOM that popup.js expects
  document.body.innerHTML = `
    <input id="q" type="text" />
    <button id="go">Search</button>
    <div id="results"></div>
    <div id="empty"></div>
    <div id="status"><span id="status-msg"></span></div>
    <span id="stat-count"></span>
    <span id="stat-last"></span>
    <span id="method"></span>
    <button id="clear"></button>
    <div id="filters">
      <button class="filter-btn active" data-type="all">All</button>
    </div>
    <button id="open-chat"></button>
    <button class="view-btn active" data-view="search">Search</button>
    <button class="view-btn" data-view="topics">Topics</button>
    <div id="search-view"></div>
    <div id="topics-view" style="display:none;"></div>
    <div id="topics-list"></div>
    <div id="topics-loading" style="display:none;"></div>
    <div id="topics-empty" style="display:none;"></div>
  `;

  // Mock chrome.runtime.sendMessage for the loadStats IIFE
  chrome.runtime.sendMessage.mockResolvedValue({ total: 42, lastTime: Date.now() });

  jest.isolateModules(() => {
    popup = require("../popup.js");
  });
});

// === timeAgo ===
describe("timeAgo", () => {
  test("returns 'just now' for recent timestamps", () => {
    expect(popup.timeAgo(Date.now() - 5000)).toBe("just now");
  });

  test("returns minutes ago for timestamps < 1 hour", () => {
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    expect(popup.timeAgo(fiveMinAgo)).toBe("5m ago");
  });

  test("returns hours ago for timestamps < 1 day", () => {
    const threeHoursAgo = Date.now() - 3 * 3600 * 1000;
    expect(popup.timeAgo(threeHoursAgo)).toBe("3h ago");
  });

  test("returns days ago for timestamps < 1 week", () => {
    const twoDaysAgo = Date.now() - 2 * 86400 * 1000;
    expect(popup.timeAgo(twoDaysAgo)).toBe("2d ago");
  });

  test("returns formatted date for timestamps > 1 week", () => {
    const twoWeeksAgo = Date.now() - 14 * 86400 * 1000;
    const result = popup.timeAgo(twoWeeksAgo);
    expect(result).toMatch(/\w{3}\s+\d{1,2}/);
  });

  test("handles current timestamp", () => {
    expect(popup.timeAgo(Date.now())).toBe("just now");
  });

  test("handles exactly 60 seconds ago", () => {
    const result = popup.timeAgo(Date.now() - 60000);
    expect(result).toBe("1m ago");
  });

  test("handles exactly 1 hour ago", () => {
    const result = popup.timeAgo(Date.now() - 3600000);
    expect(result).toBe("1h ago");
  });

  test("handles exactly 1 day ago", () => {
    const result = popup.timeAgo(Date.now() - 86400000);
    expect(result).toBe("1d ago");
  });
});

// === shortUrl ===
describe("shortUrl", () => {
  test("extracts hostname from URL", () => {
    expect(popup.shortUrl("https://example.com")).toContain("example.com");
  });

  test("includes truncated path", () => {
    expect(popup.shortUrl("https://example.com/very/long/path/to/something"))
      .toContain("example.com");
  });

  test("returns empty string for null/undefined", () => {
    expect(popup.shortUrl(null)).toBe("");
    expect(popup.shortUrl(undefined)).toBe("");
    expect(popup.shortUrl("")).toBe("");
  });

  test("handles invalid URLs by slicing", () => {
    expect(popup.shortUrl("not-a-url")).toBe("not-a-url");
  });

  test("truncates long paths to 25 chars", () => {
    const url = "https://example.com/a/very/very/very/very/long/path/that/goes/on";
    const result = popup.shortUrl(url);
    expect(result.length).toBeLessThan(url.length);
  });

  test("handles URL with no path", () => {
    const result = popup.shortUrl("https://example.com");
    expect(result).toBe("example.com");
  });

  test("handles URL with just /", () => {
    const result = popup.shortUrl("https://example.com/");
    expect(result).toBe("example.com");
  });
});

// === esc (HTML escaping) ===
describe("esc", () => {
  test("escapes ampersands", () => {
    expect(popup.esc("a & b")).toBe("a &amp; b");
  });

  test("escapes less-than", () => {
    expect(popup.esc("<script>")).toBe("&lt;script&gt;");
  });

  test("escapes greater-than", () => {
    expect(popup.esc("a > b")).toBe("a &gt; b");
  });

  test("escapes double quotes", () => {
    expect(popup.esc('say "hello"')).toBe("say &quot;hello&quot;");
  });

  test("escapes single quotes", () => {
    expect(popup.esc("it's")).toBe("it&#039;s");
  });

  test("returns empty string for null/undefined/empty", () => {
    expect(popup.esc(null)).toBe("");
    expect(popup.esc(undefined)).toBe("");
    expect(popup.esc("")).toBe("");
  });

  test("handles string with all special chars", () => {
    expect(popup.esc('&<>"\''))
      .toBe("&amp;&lt;&gt;&quot;&#039;");
  });

  test("leaves normal text unchanged", () => {
    expect(popup.esc("Hello World 123")).toBe("Hello World 123");
  });

  test("handles XSS attempt", () => {
    const xss = '<img src=x onerror=alert("XSS")>';
    const escaped = popup.esc(xss);
    expect(escaped).not.toContain("<img");
  });
});

// === makeCard ===
describe("makeCard", () => {
  test("creates a div element with class 'card'", () => {
    const card = popup.makeCard({
      type: "pageview",
      title: "Test Page",
      url: "https://example.com",
      timestamp: Date.now(),
      score: 0.85,
      reason: "Good match",
      context: "Visited the page",
    });
    expect(card.className).toBe("card");
    expect(card.tagName).toBe("DIV");
  });

  test("displays score as percentage", () => {
    const card = popup.makeCard({
      type: "pageview", title: "Test", url: "https://example.com",
      timestamp: Date.now(), score: 0.85, reason: "Good match",
    });
    expect(card.innerHTML).toContain("85% match");
  });

  test("clamps score to max 99%", () => {
    const card = popup.makeCard({
      type: "pageview", title: "Test", url: "https://example.com",
      timestamp: Date.now(), score: 1.0, reason: "Perfect match",
    });
    expect(card.innerHTML).toContain("99% match");
  });

  test("handles null score gracefully", () => {
    const card = popup.makeCard({
      type: "pageview", title: "Test", url: "https://example.com",
      timestamp: Date.now(), score: null,
    });
    expect(card.innerHTML).not.toContain("% match");
  });

  test("shows correct emoji for each event type", () => {
    const types = { pageview: "📄", click: "👆", selection: "✂️", input: "⌨️", search: "🔍" };
    for (const [type, emoji] of Object.entries(types)) {
      const card = popup.makeCard({ type, title: "Test", timestamp: Date.now() });
      expect(card.innerHTML).toContain(emoji);
    }
  });

  test("escapes title to prevent XSS", () => {
    const card = popup.makeCard({
      type: "pageview", title: '<script>alert("xss")</script>', timestamp: Date.now(),
    });
    expect(card.innerHTML).not.toContain("<script>");
  });

  test("uses 'Untitled' when title is missing", () => {
    const card = popup.makeCard({ type: "pageview", timestamp: Date.now() });
    expect(card.innerHTML).toContain("Untitled");
  });

  test("uses fallback emoji for unknown type", () => {
    const card = popup.makeCard({ type: "custom_type", title: "Test", timestamp: Date.now() });
    expect(card.innerHTML).toContain("📌");
  });

  test("replaces underscores in type label", () => {
    const card = popup.makeCard({ type: "sheets_edit", title: "Test", timestamp: Date.now() });
    expect(card.innerHTML).toContain("sheets edit");
  });
});

// === makeTopicCard ===
describe("makeTopicCard", () => {
  test("creates a topic card with label and event count", () => {
    const card = popup.makeTopicCard({
      label: "Machine Learning",
      events: [
        { type: "pageview", title: "ML Article", url: "https://ml.com", timestamp: Date.now() },
        { type: "pageview", title: "AI Guide", url: "https://ai.com", timestamp: Date.now() },
      ],
    });
    expect(card.className).toBe("topic-card");
    expect(card.innerHTML).toContain("Machine Learning");
    expect(card.innerHTML).toContain("2 events");
  });

  test("extracts domains from event URLs", () => {
    const card = popup.makeTopicCard({
      label: "Test",
      events: [
        { type: "pageview", title: "A", url: "https://example.com/page1", timestamp: Date.now() },
        { type: "pageview", title: "B", url: "https://other.org/page2", timestamp: Date.now() },
      ],
    });
    expect(card.querySelector(".topic-domains").textContent).toContain("example.com");
    expect(card.querySelector(".topic-domains").textContent).toContain("other.org");
  });

  test("shows 'various pages' when no URLs", () => {
    const card = popup.makeTopicCard({
      label: "Test",
      events: [{ type: "search", title: "Query", timestamp: Date.now() }],
    });
    expect(card.querySelector(".topic-domains").textContent).toContain("various pages");
  });

  test("toggles expanded class on header click", () => {
    const card = popup.makeTopicCard({
      label: "Test",
      events: [{ type: "pageview", title: "A", url: "https://a.com", timestamp: Date.now() }],
    });
    const header = card.querySelector(".topic-header");
    header.click();
    expect(card.classList.contains("expanded")).toBe(true);
    header.click();
    expect(card.classList.contains("expanded")).toBe(false);
  });

  test("limits to 4 unique domains", () => {
    const events = Array.from({ length: 10 }, (_, i) => ({
      type: "pageview", title: `Page ${i}`, url: `https://site${i}.com/page`, timestamp: Date.now(),
    }));
    const card = popup.makeTopicCard({ label: "Test", events });
    const domainText = card.querySelector(".topic-domains").textContent;
    const domainCount = domainText.split(",").length;
    expect(domainCount).toBeLessThanOrEqual(4);
  });
});
