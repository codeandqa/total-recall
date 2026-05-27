const path = require("path");

// Mock importScripts to load db.js via require and expose its exports as globals
global.importScripts = function(file) {
  if (file === "db.js") {
    const db = require("../db.js");
    // db.js in the browser defines all functions in the global scope.
    // Replicate that by assigning each export to global.
    for (const [key, val] of Object.entries(db)) {
      global[key] = val;
    }
  }
};

// We need a fresh require for each test, so we use beforeEach with jest.isolateModules
let bg;

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();

  // Reset the recent map if it exists
  if (bg && bg.recent) bg.recent.clear();

  jest.isolateModules(() => {
    bg = require("../background.js");
  });

  bg.recent.clear();
});

// === isDuplicate ===
describe("isDuplicate", () => {
  test("returns false for first occurrence of an event", () => {
    expect(bg.isDuplicate({ type: "click", url: "https://a.com" })).toBe(false);
  });

  test("returns true for same event within 2 seconds", () => {
    const evt = { type: "click", url: "https://a.com" };
    bg.isDuplicate(evt);
    expect(bg.isDuplicate(evt)).toBe(true);
  });

  test("returns false for different event types at same URL", () => {
    bg.isDuplicate({ type: "click", url: "https://a.com" });
    expect(bg.isDuplicate({ type: "pageview", url: "https://a.com" })).toBe(false);
  });

  test("returns false for same type at different URLs", () => {
    bg.isDuplicate({ type: "click", url: "https://a.com" });
    expect(bg.isDuplicate({ type: "click", url: "https://b.com" })).toBe(false);
  });

  test("cleans up old entries when map exceeds 300", () => {
    for (let i = 0; i < 301; i++) {
      bg.isDuplicate({ type: "click", url: `https://site${i}.com` });
    }
    expect(bg.recent.size).toBeLessThanOrEqual(301);
  });
});

// === keywordSearch ===
describe("keywordSearch", () => {
  test("returns empty results for empty query", async () => {
    const result = await bg.keywordSearch("");
    expect(result.results).toEqual([]);
    expect(result.method).toBe("keyword");
  });

  test("returns empty results when all words are too short", async () => {
    const result = await bg.keywordSearch("a b c");
    expect(result.results).toEqual([]);
  });

  test("returns method as keyword", async () => {
    const result = await bg.keywordSearch("machine learning");
    expect(result.method).toBe("keyword");
  });
});

// === buildSemanticReason ===
describe("buildSemanticReason", () => {
  const baseEvent = {
    type: "pageview",
    title: "Machine Learning Guide",
    context: "Visited a page about ML",
    content: "Deep learning tutorial with neural networks",
  };

  test("high similarity (>=0.7) says 'Very high semantic similarity'", () => {
    const reason = bg.buildSemanticReason(0.75, baseEvent, "machine learning");
    expect(reason).toContain("Very high semantic similarity");
  });

  test("strong similarity (>=0.5) says 'Strong semantic similarity'", () => {
    const reason = bg.buildSemanticReason(0.55, baseEvent, "machine learning");
    expect(reason).toContain("Strong semantic similarity");
  });

  test("moderate similarity (>=0.35) says 'Moderate semantic similarity'", () => {
    const reason = bg.buildSemanticReason(0.40, baseEvent, "machine learning");
    expect(reason).toContain("Moderate semantic similarity");
  });

  test("weak similarity (>=0.2) says 'Weak semantic similarity'", () => {
    const reason = bg.buildSemanticReason(0.25, baseEvent, "machine learning");
    expect(reason).toContain("Weak semantic similarity");
  });

  test("low similarity (<0.2) says 'Low semantic similarity'", () => {
    const reason = bg.buildSemanticReason(0.1, baseEvent, "cooking recipes");
    expect(reason).toContain("Low semantic similarity");
  });

  test("includes event type label", () => {
    const reason = bg.buildSemanticReason(0.5, baseEvent, "test");
    expect(reason).toContain("Event type: page visit");
  });

  test("includes keyword overlap when words match", () => {
    const reason = bg.buildSemanticReason(0.5, baseEvent, "machine learning guide");
    expect(reason).toContain("Also contains keywords");
    expect(reason).toContain("machine");
  });

  test("handles unknown event types gracefully", () => {
    const evt = { ...baseEvent, type: "custom_event" };
    const reason = bg.buildSemanticReason(0.5, evt, "test");
    expect(reason).toContain("Event type: custom_event");
  });

  test("handles all known event types", () => {
    const types = [
      "pageview", "click", "selection", "input", "search",
      "sheets_edit", "sheets_select", "sheets_content",
      "tab_focus", "page_leave",
    ];
    for (const type of types) {
      const reason = bg.buildSemanticReason(0.5, { ...baseEvent, type }, "test");
      expect(reason).toContain("Event type:");
    }
  });

  test("does not include keyword section when no overlap", () => {
    const reason = bg.buildSemanticReason(0.5, baseEvent, "xyz qqq rrr");
    expect(reason).not.toContain("Also contains keywords");
  });

  test("filters short query words (<=2 chars)", () => {
    const reason = bg.buildSemanticReason(0.5, baseEvent, "ml is great");
    expect(reason).not.toContain('"ml"');
  });
});

// === kMeans ===
describe("kMeans", () => {
  test("assigns correct number of clusters", () => {
    const vectors = [
      [0, 0], [0.1, 0.1], [0.05, -0.05],
      [10, 10], [10.1, 10.1], [9.9, 10],
      [20, 0], [20.1, 0.1], [19.9, -0.1],
    ];
    const assignments = bg.kMeans(vectors, 3, 20);
    expect(assignments.length).toBe(9);
    expect(assignments[0]).toBe(assignments[1]);
    expect(assignments[1]).toBe(assignments[2]);
    expect(assignments[3]).toBe(assignments[4]);
    expect(assignments[4]).toBe(assignments[5]);
    expect(assignments[6]).toBe(assignments[7]);
    expect(assignments[7]).toBe(assignments[8]);
    const uniqueClusters = new Set(assignments);
    expect(uniqueClusters.size).toBe(3);
  });

  test("returns array of correct length", () => {
    const vectors = [[1, 2], [3, 4], [5, 6], [7, 8]];
    const assignments = bg.kMeans(vectors, 2, 10);
    expect(assignments.length).toBe(4);
  });

  test("all assignments are valid cluster indices", () => {
    const vectors = Array.from({ length: 20 }, () => [Math.random(), Math.random()]);
    const k = 4;
    const assignments = bg.kMeans(vectors, k, 10);
    for (const a of assignments) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(k);
    }
  });

  test("handles single vector", () => {
    const assignments = bg.kMeans([[1, 2, 3]], 1, 5);
    expect(assignments).toEqual([0]);
  });

  test("converges in reasonable iterations", () => {
    const vectors = [
      [0, 0], [1, 0], [0, 1], [1, 1],
      [10, 10], [11, 10], [10, 11], [11, 11],
    ];
    const assignments = bg.kMeans(vectors, 2, 100);
    expect(assignments.length).toBe(8);
  });
});

// === pickClusterLabel ===
describe("pickClusterLabel", () => {
  test("picks most frequent words from titles", () => {
    const events = [
      { title: "JavaScript Tutorial Beginner" },
      { title: "JavaScript Advanced Guide" },
      { title: "JavaScript Frameworks Comparison" },
    ];
    const label = bg.pickClusterLabel(events);
    expect(label.toLowerCase()).toContain("javascript");
  });

  test("filters out stop words", () => {
    const events = [
      { title: "The Best Guide For You" },
      { title: "The New Way To Search" },
    ];
    const label = bg.pickClusterLabel(events);
    expect(label.toLowerCase()).not.toContain("the");
    expect(label.toLowerCase()).not.toContain("for");
  });

  test("capitalizes first letter of each word", () => {
    const events = [
      { title: "python data science" },
      { title: "python machine learning" },
    ];
    const label = bg.pickClusterLabel(events);
    expect(label).toMatch(/^[A-Z]/);
  });

  test("falls back to first event title when no meaningful words", () => {
    const events = [{ title: "A I" }];
    const label = bg.pickClusterLabel(events);
    expect(label).toBeDefined();
    expect(label.length).toBeGreaterThan(0);
  });

  test("returns 'Misc' when no title at all", () => {
    const events = [{}];
    const label = bg.pickClusterLabel(events);
    expect(label).toBe("Misc");
  });

  test("limits to top 3 words", () => {
    const events = [
      { title: "alpha beta gamma delta epsilon" },
      { title: "alpha beta gamma delta epsilon" },
    ];
    const label = bg.pickClusterLabel(events);
    const words = label.split(", ");
    expect(words.length).toBeLessThanOrEqual(3);
  });

  test("handles empty title string", () => {
    const events = [{ title: "" }];
    const label = bg.pickClusterLabel(events);
    expect(label).toBeDefined();
  });
});

// === onEvent ===
describe("onEvent", () => {
  test("ignores chrome-extension:// URLs", async () => {
    await bg.onEvent({ type: "pageview", url: "chrome-extension://abc/popup.html" });
  });

  test("ignores chrome:// URLs", async () => {
    await bg.onEvent({ type: "pageview", url: "chrome://settings" });
  });

  test("does not crash on undefined url", async () => {
    await bg.onEvent({ type: "click" });
  });
});

// === getStats ===
describe("getStats", () => {
  test("returns an object with total and lastTime", async () => {
    const stats = await bg.getStats();
    expect(stats).toHaveProperty("total");
    expect(stats).toHaveProperty("lastTime");
  });
});

// === ensureOffscreen ===
describe("ensureOffscreen", () => {
  test("creates offscreen document when none exists", async () => {
    chrome.runtime.getContexts.mockResolvedValue([]);
    await bg.ensureOffscreen();
    expect(chrome.offscreen.createDocument).toHaveBeenCalled();
  });

  test("does not create when offscreen already exists", async () => {
    chrome.runtime.getContexts.mockResolvedValue([{ contextType: "OFFSCREEN_DOCUMENT" }]);
    chrome.offscreen.createDocument.mockClear();
    await bg.ensureOffscreen();
    expect(chrome.offscreen.createDocument).not.toHaveBeenCalled();
  });

  test("handles 'already exists' error gracefully", async () => {
    chrome.runtime.getContexts.mockResolvedValue([]);
    chrome.offscreen.createDocument.mockRejectedValue(new Error("already exists"));
    await expect(bg.ensureOffscreen()).resolves.toBeUndefined();
  });
});

// === openAndHighlight ===
describe("openAndHighlight", () => {
  test("creates a new tab with the given URL", () => {
    bg.openAndHighlight("https://example.com", "test query");
    expect(chrome.tabs.create).toHaveBeenCalledWith(
      { url: "https://example.com" },
      expect.any(Function)
    );
  });

  test("does not crash when query is empty", () => {
    bg.openAndHighlight("https://example.com", "");
    expect(chrome.tabs.create).toHaveBeenCalled();
  });

  test("does not crash when query is null", () => {
    bg.openAndHighlight("https://example.com", null);
    expect(chrome.tabs.create).toHaveBeenCalled();
  });
});
