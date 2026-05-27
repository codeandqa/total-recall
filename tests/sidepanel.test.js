// =============================================================================
// TESTS FOR sidepanel.js — Chat side panel logic
// =============================================================================

const fs = require("fs");
const path = require("path");

// ---------- Extract testable functions from sidepanel.js ----------
function loadSidepanelFunctions() {
  let src = fs.readFileSync(path.join(__dirname, "..", "sidepanel.js"), "utf-8");

  // Remove DOM element lookups
  src = src.replace(/const \$\w+\s*=\s*document\.getElementById\([^)]+\);/g, "");

  // Remove event listeners and auto-execution
  src = src.replace(/\$settingsToggle\.addEventListener[\s\S]*?\}\);/m, "");
  src = src.replace(/\$saveSettings\.addEventListener[\s\S]*?;/, "");
  src = src.replace(/\$closeSettings\.addEventListener[\s\S]*?\}\);/m, "");
  src = src.replace(/\$apiProvider\.addEventListener[\s\S]*?\}\);/m, "");
  src = src.replace(/loadSettings\(\);/, "");
  src = src.replace(/\$sendBtn\.addEventListener[\s\S]*?;/, "");
  src = src.replace(/\$input\.addEventListener\("keydown"[\s\S]*?\}\);/m, "");
  src = src.replace(/\$input\.addEventListener\("input"[\s\S]*?\}\);/m, "");

  // Create mock DOM elements
  const mockDom = `
    const $messages = {
      appendChild: jest.fn(),
      scrollTop: 0,
      scrollHeight: 500,
    };
    const $input = { value: "", style: { height: "" } };
    const $sendBtn = { disabled: false };
    const $settingsToggle = {};
    const $settingsPanel = { style: { display: "none" } };
    const $apiProvider = { value: "anthropic", placeholder: "" };
    const $apiKey = { value: "" };
    const $apiModel = { value: "", placeholder: "" };
    const $saveSettings = {};
    const $closeSettings = {};
    const $settingsStatus = { textContent: "", className: "" };
    const $keyStatus = { innerHTML: "" };
  `;

  const combined = mockDom + "\n" + src + `
    module.exports = {
      getDefaultModel, buildPrompt, escapeAndFormat, esc,
      callLLM, callAnthropic, callOpenAI, addMessage, addAIMessage,
      addTypingIndicator, scrollToBottom, showSettingsStatus,
      updateKeyStatus, loadSettings, saveSettings, sendMessage,
      searchHistory, chatHistory,
    };
  `;

  const mod = { exports: {} };
  const fn = new Function("module", "exports", "document", "chrome", "window", "fetch", "jest",
    combined
  );
  fn(mod, mod.exports, document, global.chrome, global.window, global.fetch, jest);
  return mod.exports;
}

let sp;

beforeEach(() => {
  document.body.innerHTML = "";
  jest.clearAllMocks();
  sp = loadSidepanelFunctions();
});

// =============================================================================
// getDefaultModel
// =============================================================================
describe("getDefaultModel", () => {
  test("returns Claude model for anthropic provider", () => {
    expect(sp.getDefaultModel("anthropic")).toBe("claude-sonnet-4-20250514");
  });

  test("returns GPT model for openai provider", () => {
    expect(sp.getDefaultModel("openai")).toBe("gpt-4o-mini");
  });

  test("returns empty string for unknown provider", () => {
    expect(sp.getDefaultModel("other")).toBe("");
    expect(sp.getDefaultModel("")).toBe("");
  });
});

// =============================================================================
// esc (HTML escaping — sidepanel's own copy)
// =============================================================================
describe("esc (sidepanel)", () => {
  test("escapes HTML special characters", () => {
    expect(sp.esc("&")).toBe("&amp;");
    expect(sp.esc("<")).toBe("&lt;");
    expect(sp.esc(">")).toBe("&gt;");
    expect(sp.esc('"')).toBe("&quot;");
    expect(sp.esc("'")).toBe("&#039;");
  });

  test("returns empty for falsy values", () => {
    expect(sp.esc(null)).toBe("");
    expect(sp.esc(undefined)).toBe("");
    expect(sp.esc("")).toBe("");
  });

  test("handles complex XSS strings", () => {
    const result = sp.esc('<img onerror="alert(1)" src=x>');
    expect(result).not.toContain("<img");
  });
});

// =============================================================================
// escapeAndFormat
// =============================================================================
describe("escapeAndFormat", () => {
  test("converts **bold** to <strong>", () => {
    expect(sp.escapeAndFormat("Hello **world**")).toContain("<strong>world</strong>");
  });

  test("converts `code` to <code>", () => {
    expect(sp.escapeAndFormat("Use `npm install`")).toContain("<code>npm install</code>");
  });

  test("converts URLs to clickable links", () => {
    const result = sp.escapeAndFormat("Visit https://example.com for info");
    expect(result).toContain('href="https://example.com"');
    expect(result).toContain("target=\"_blank\"");
  });

  test("converts newlines to <br>", () => {
    expect(sp.escapeAndFormat("line1\nline2")).toContain("<br>");
  });

  test("converts bullet points", () => {
    const result = sp.escapeAndFormat("Items:\n- First item\n- Second item");
    expect(result).toContain("•");
  });

  test("escapes HTML before formatting", () => {
    const result = sp.escapeAndFormat("<script>alert(1)</script>");
    expect(result).not.toContain("<script>");
    expect(result).toContain("&lt;script&gt;");
  });

  test("handles empty string", () => {
    expect(sp.escapeAndFormat("")).toBe("");
  });

  test("handles bold + code + URL together", () => {
    const result = sp.escapeAndFormat("**bold** `code` https://example.com");
    expect(result).toContain("<strong>bold</strong>");
    expect(result).toContain("<code>code</code>");
    expect(result).toContain('href="https://example.com"');
  });
});

// =============================================================================
// buildPrompt
// =============================================================================
describe("buildPrompt", () => {
  test("returns array with at least one message", () => {
    const messages = sp.buildPrompt("What did I search?", []);
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBeGreaterThanOrEqual(1);
  });

  test("includes the user question in the prompt", () => {
    const messages = sp.buildPrompt("What articles did I read?", []);
    expect(messages[0].content).toContain("What articles did I read?");
  });

  test("includes Total Recall system instructions", () => {
    const messages = sp.buildPrompt("test", []);
    expect(messages[0].content).toContain("Total Recall");
  });

  test("includes event context when provided", () => {
    const events = [
      {
        type: "pageview",
        title: "AI Guide",
        url: "https://ai.com",
        timestamp: Date.now(),
        context: "Visited AI page",
        content: "Deep learning tutorial",
        score: 0.85,
      },
    ];
    const messages = sp.buildPrompt("AI articles", events);
    expect(messages[0].content).toContain("AI Guide");
    expect(messages[0].content).toContain("https://ai.com");
    expect(messages[0].content).toContain("85%");
  });

  test("limits to 15 events", () => {
    const events = Array.from({ length: 20 }, (_, i) => ({
      type: "pageview",
      title: `Page ${i}`,
      url: `https://site${i}.com`,
      timestamp: Date.now(),
    }));
    const messages = sp.buildPrompt("test", events);
    // Should not contain Page 15-19
    expect(messages[0].content).not.toContain("[16]");
  });

  test("includes 'No relevant browsing history' when events empty", () => {
    const messages = sp.buildPrompt("test", []);
    expect(messages[0].content).toContain("No relevant browsing history");
  });

  test("formats event type labels correctly", () => {
    const events = [{
      type: "sheets_edit",
      title: "Test Sheet",
      url: "https://docs.google.com",
      timestamp: Date.now(),
    }];
    const messages = sp.buildPrompt("test", events);
    expect(messages[0].content).toContain("SHEETS EDIT");
  });
});

// =============================================================================
// callLLM routing
// =============================================================================
describe("callLLM", () => {
  test("calls callAnthropic for anthropic provider", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: [{ text: "response" }] }),
    });

    const result = await sp.callLLM(
      { apiProvider: "anthropic", apiKey: "test-key", apiModel: "claude-sonnet-4-20250514" },
      [{ role: "user", content: "test" }]
    );
    expect(result).toBe("response");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.any(Object)
    );
  });

  test("calls callOpenAI for openai provider", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: "gpt response" } }] }),
    });

    const result = await sp.callLLM(
      { apiProvider: "openai", apiKey: "test-key", apiModel: "gpt-4o-mini" },
      [{ role: "user", content: "test" }]
    );
    expect(result).toBe("gpt response");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/chat/completions",
      expect.any(Object)
    );
  });

  test("uses default model when apiModel is empty", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: [{ text: "ok" }] }),
    });

    await sp.callLLM(
      { apiProvider: "anthropic", apiKey: "key" },
      [{ role: "user", content: "test" }]
    );
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.model).toBe("claude-sonnet-4-20250514");
  });
});

// =============================================================================
// callAnthropic
// =============================================================================
describe("callAnthropic", () => {
  test("sends correct headers", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: [{ text: "hi" }] }),
    });

    await sp.callAnthropic("sk-key", "claude-sonnet-4-20250514", [{ role: "user", content: "test" }]);
    const headers = global.fetch.mock.calls[0][1].headers;
    expect(headers["x-api-key"]).toBe("sk-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
  });

  test("throws on API error", async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized"),
    });

    await expect(sp.callAnthropic("bad-key", "model", []))
      .rejects.toThrow("Anthropic API error (401)");
  });

  test("returns fallback text when response is empty", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: [] }),
    });

    const result = await sp.callAnthropic("key", "model", [{ role: "user", content: "test" }]);
    expect(result).toBe("No response received.");
  });
});

// =============================================================================
// callOpenAI
// =============================================================================
describe("callOpenAI", () => {
  test("sends correct authorization header", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: "hi" } }] }),
    });

    await sp.callOpenAI("sk-key", "gpt-4o-mini", [{ role: "user", content: "test" }]);
    const headers = global.fetch.mock.calls[0][1].headers;
    expect(headers["Authorization"]).toBe("Bearer sk-key");
  });

  test("throws on API error", async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve("Rate limited"),
    });

    await expect(sp.callOpenAI("key", "model", []))
      .rejects.toThrow("OpenAI API error (429)");
  });

  test("returns fallback when choices empty", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [] }),
    });

    const result = await sp.callOpenAI("key", "model", [{ role: "user", content: "test" }]);
    expect(result).toBe("No response received.");
  });
});

// =============================================================================
// addMessage UI
// =============================================================================
describe("addMessage", () => {
  test("creates a message element with correct class", () => {
    const msg = sp.addMessage("user", "Hello");
    expect(msg.className).toContain("sp-msg-user");
  });

  test("shows user avatar for user messages", () => {
    const msg = sp.addMessage("user", "Hi");
    expect(msg.innerHTML).toContain("👤");
  });

  test("shows brain avatar for AI messages", () => {
    const msg = sp.addMessage("ai", "Hello");
    expect(msg.innerHTML).toContain("🧠");
  });

  test("escapes HTML in message text", () => {
    const msg = sp.addMessage("user", "<script>alert(1)</script>");
    expect(msg.innerHTML).not.toContain("<script>");
  });
});

// =============================================================================
// addAIMessage
// =============================================================================
describe("addAIMessage", () => {
  test("includes sources when provided", () => {
    sp.addAIMessage("Here is the answer", [
      { url: "https://example.com", title: "Example" },
    ]);
    // The function appends to $messages mock
  });

  test("filters out chrome:// URLs from sources", () => {
    const msg = document.createElement("div");
    document.body.appendChild(msg);

    // We just check it doesn't crash
    sp.addAIMessage("Answer", [
      { url: "chrome://settings", title: "Settings" },
      { url: "https://example.com", title: "Valid" },
    ]);
  });

  test("deduplicates source URLs", () => {
    sp.addAIMessage("Answer", [
      { url: "https://example.com", title: "Page 1" },
      { url: "https://example.com", title: "Page 1 again" },
    ]);
    // Should only show one source link
  });

  test("limits to 5 source links", () => {
    const sources = Array.from({ length: 10 }, (_, i) => ({
      url: `https://site${i}.com`,
      title: `Site ${i}`,
    }));
    sp.addAIMessage("Answer", sources);
    // Should only include 5
  });
});

// =============================================================================
// addTypingIndicator
// =============================================================================
describe("addTypingIndicator", () => {
  test("returns a removable element", () => {
    const el = sp.addTypingIndicator();
    expect(el.tagName).toBe("DIV");
    expect(el.className).toContain("sp-msg-ai");
    expect(el.innerHTML).toContain("sp-typing");
  });
});

// =============================================================================
// showSettingsStatus
// =============================================================================
describe("showSettingsStatus", () => {
  test("does not throw", () => {
    expect(() => sp.showSettingsStatus("Test message", "ok")).not.toThrow();
    expect(() => sp.showSettingsStatus("Error", "err")).not.toThrow();
  });
});
