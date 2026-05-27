const path = require("path");

// We need to mock chrome.runtime.sendMessage and onMessage before content.js loads
// content.js is loaded by `require` and runs side effects, so we mock carefully.

let content;

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();

  // Reset DOM
  document.body.innerHTML = "";
  document.title = "Test Page";

  // jsdom does not implement scrollIntoView
  Element.prototype.scrollIntoView = jest.fn();

  // jsdom does not compute layout, so offsetParent is always null.
  // walkTextNodes treats offsetParent===null as hidden. Patch HTMLElement
  // so that elements appended to the body report a non-null offsetParent.
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    get() {
      return this.parentNode === document ? null : this.parentNode;
    },
    configurable: true,
  });

  // Mock chrome.runtime.sendMessage to return a resolved promise
  chrome.runtime.sendMessage.mockReturnValue(Promise.resolve());

  jest.isolateModules(() => {
    content = require("../content.js");
  });
});

// === SETTINGS ===
describe("SETTINGS", () => {
  test("has required properties", () => {
    expect(content.SETTINGS).toBeDefined();
    expect(content.SETTINGS.TYPING_WAIT_MS).toBe(1000);
    expect(content.SETTINGS.PAGE_LOAD_WAIT_MS).toBe(2500);
    expect(content.SETTINGS.MAX_PAGE_TEXT).toBe(20000);
    expect(content.SETTINGS.MAX_CONTEXT).toBe(300);
    expect(content.SETTINGS.MIN_SELECT_LENGTH).toBe(3);
    expect(content.SETTINGS.SHEETS_INTERVAL_MS).toBe(30000);
  });
});

// === escapeRegex ===
describe("escapeRegex", () => {
  test("escapes special regex characters", () => {
    expect(content.escapeRegex("hello.world")).toBe("hello\\.world");
    expect(content.escapeRegex("a*b+c?")).toBe("a\\*b\\+c\\?");
    expect(content.escapeRegex("(test)")).toBe("\\(test\\)");
    expect(content.escapeRegex("[abc]")).toBe("\\[abc\\]");
    expect(content.escapeRegex("a{3}")).toBe("a\\{3\\}");
    expect(content.escapeRegex("x|y")).toBe("x\\|y");
    expect(content.escapeRegex("^start$")).toBe("\\^start\\$");
    expect(content.escapeRegex("back\\slash")).toBe("back\\\\slash");
  });

  test("leaves normal strings unchanged", () => {
    expect(content.escapeRegex("hello world")).toBe("hello world");
    expect(content.escapeRegex("simple123")).toBe("simple123");
  });

  test("handles empty string", () => {
    expect(content.escapeRegex("")).toBe("");
  });

  test("handles string with only special chars", () => {
    expect(content.escapeRegex(".*+?")).toBe("\\.\\*\\+\\?");
  });
});

// === extractPageText ===
describe("extractPageText", () => {
  test("extracts visible text from body", () => {
    document.body.innerHTML = "<p>Hello World</p>";
    const text = content.extractPageText();
    expect(text).toContain("Hello World");
  });

  test("removes script tags", () => {
    document.body.innerHTML = '<p>Visible</p><script>var x = "hidden";</script>';
    const text = content.extractPageText();
    expect(text).toContain("Visible");
    expect(text).not.toContain("hidden");
  });

  test("removes style tags", () => {
    document.body.innerHTML = "<p>Content</p><style>body { color: red; }</style>";
    const text = content.extractPageText();
    expect(text).not.toContain("color");
  });

  test("collapses whitespace", () => {
    document.body.innerHTML = "<p>Hello    World\n\n\tTest</p>";
    const text = content.extractPageText();
    expect(text).toBe("Hello World Test");
  });

  test("truncates to MAX_PAGE_TEXT", () => {
    const longText = "A".repeat(25000);
    document.body.innerHTML = `<p>${longText}</p>`;
    const text = content.extractPageText();
    expect(text.length).toBeLessThanOrEqual(content.SETTINGS.MAX_PAGE_TEXT);
  });

  test("handles empty body", () => {
    document.body.innerHTML = "";
    const text = content.extractPageText();
    expect(text).toBe("");
  });

  test("removes noscript elements", () => {
    document.body.innerHTML = "<p>Visible</p><noscript>Enable JS</noscript>";
    const text = content.extractPageText();
    expect(text).not.toContain("Enable JS");
  });

  test("removes aria-hidden elements", () => {
    document.body.innerHTML = '<p>Visible</p><div aria-hidden="true">Hidden</div>';
    const text = content.extractPageText();
    expect(text).not.toContain("Hidden");
  });
});

// === getContext ===
describe("getContext", () => {
  test("returns element text content", () => {
    const el = document.createElement("button");
    el.textContent = "Click Me";
    const ctx = content.getContext(el);
    expect(ctx).toBe("Click Me");
  });

  test("falls back to parent if element text is too short", () => {
    const parent = document.createElement("div");
    parent.textContent = "This is a longer parent context";
    const child = document.createElement("span");
    child.textContent = "Hi";
    parent.appendChild(child);
    document.body.appendChild(parent);
    const ctx = content.getContext(child);
    expect(ctx).toContain("longer parent context");
  });

  test("truncates to MAX_CONTEXT length", () => {
    const el = document.createElement("p");
    el.textContent = "A".repeat(500);
    const ctx = content.getContext(el);
    expect(ctx.length).toBeLessThanOrEqual(content.SETTINGS.MAX_CONTEXT);
  });

  test("handles element with no text", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const ctx = content.getContext(el);
    expect(ctx).toBe("");
  });

  test("collapses whitespace", () => {
    const el = document.createElement("p");
    el.textContent = "Hello   World\n\tTest";
    const ctx = content.getContext(el);
    expect(ctx).toBe("Hello World Test");
  });
});

// === describe (element descriptor) ===
describe("describe (element descriptor)", () => {
  test("returns tag name", () => {
    const el = document.createElement("button");
    expect(content.describe(el)).toBe("button");
  });

  test("includes id when present", () => {
    const el = document.createElement("div");
    el.id = "main";
    expect(content.describe(el)).toBe("div#main");
  });

  test("includes class names (up to 2)", () => {
    const el = document.createElement("a");
    el.className = "nav-link primary active";
    const desc = content.describe(el);
    expect(desc).toContain("a");
    expect(desc).toContain(".nav-link");
    expect(desc).toContain(".primary");
  });

  test("limits to 2 class names", () => {
    const el = document.createElement("div");
    el.className = "one two three four";
    const desc = content.describe(el);
    const classCount = (desc.match(/\./g) || []).length;
    expect(classCount).toBeLessThanOrEqual(2);
  });

  test("includes role when present", () => {
    const el = document.createElement("input");
    el.setAttribute("role", "searchbox");
    expect(content.describe(el)).toContain("[role=searchbox]");
  });

  test("handles element with id, class, and role", () => {
    const el = document.createElement("button");
    el.id = "submit";
    el.className = "primary";
    el.setAttribute("role", "button");
    const desc = content.describe(el);
    expect(desc).toBe("button#submit.primary[role=button]");
  });

  test("handles element with no attributes", () => {
    const el = document.createElement("span");
    expect(content.describe(el)).toBe("span");
  });
});

// === isGoogleSheets ===
describe("isGoogleSheets", () => {
  test("returns false for non-sheets URL", () => {
    expect(content.isGoogleSheets()).toBe(false);
  });
});

// === send ===
describe("send", () => {
  test("calls chrome.runtime.sendMessage with correct structure", () => {
    content.send("pageview", { content: "test" });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "content",
        event: expect.objectContaining({
          type: "pageview",
          content: "test",
        }),
      })
    );
  });
});

// === highlightTerms & removeHighlights ===
describe("highlightTerms", () => {
  test("wraps matching words in mark tags", () => {
    document.body.innerHTML = "<p>The machine learning tutorial is great</p>";
    content.highlightTerms("machine learning");
    const marks = document.querySelectorAll("mark.tr-highlight");
    expect(marks.length).toBeGreaterThanOrEqual(2);
  });

  test("skips short words (< 3 chars)", () => {
    document.body.innerHTML = "<p>I am the best</p>";
    content.highlightTerms("I am");
    const marks = document.querySelectorAll("mark.tr-highlight");
    expect(marks.length).toBe(0);
  });

  test("skips stop words", () => {
    document.body.innerHTML = "<p>the and for that this with from</p>";
    content.highlightTerms("the and for that this with from");
    const marks = document.querySelectorAll("mark.tr-highlight");
    expect(marks.length).toBe(0);
  });

  test("is case insensitive", () => {
    document.body.innerHTML = "<p>MACHINE Learning machine</p>";
    content.highlightTerms("machine");
    const marks = document.querySelectorAll("mark.tr-highlight");
    expect(marks.length).toBeGreaterThanOrEqual(2);
  });

  test("does nothing for empty query", () => {
    document.body.innerHTML = "<p>Some text here</p>";
    content.highlightTerms("");
    const marks = document.querySelectorAll("mark.tr-highlight");
    expect(marks.length).toBe(0);
  });
});

describe("removeHighlights", () => {
  test("removes all mark tags and restores text", () => {
    document.body.innerHTML = '<p>Hello <mark class="tr-highlight">World</mark> Test</p>';
    content.removeHighlights();
    const marks = document.querySelectorAll("mark.tr-highlight");
    expect(marks.length).toBe(0);
    expect(document.body.textContent).toContain("World");
  });

  test("does nothing when no highlights exist", () => {
    document.body.innerHTML = "<p>Hello World</p>";
    content.removeHighlights();
    expect(document.body.textContent).toContain("Hello World");
  });
});

// === walkTextNodes ===
describe("walkTextNodes", () => {
  test("visits all visible text nodes", () => {
    document.body.innerHTML = "<p>Hello</p><p>World</p>";
    const texts = [];
    content.walkTextNodes(document.body, (node) => texts.push(node.textContent));
    expect(texts).toContain("Hello");
    expect(texts).toContain("World");
  });

  test("skips script and style nodes", () => {
    document.body.innerHTML = '<p>Visible</p><script>var x = 1;</script><style>p{}</style>';
    const texts = [];
    content.walkTextNodes(document.body, (node) => texts.push(node.textContent));
    expect(texts).toContain("Visible");
    expect(texts.join("")).not.toContain("var x");
  });

  test("skips empty text nodes", () => {
    document.body.innerHTML = "<p>Text</p><p>   </p>";
    const texts = [];
    content.walkTextNodes(document.body, (node) => texts.push(node.textContent.trim()));
    expect(texts.filter(Boolean)).toEqual(["Text"]);
  });
});
