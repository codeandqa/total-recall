// =============================================================================
// TESTS FOR sandbox.js — AI model embedding generation
// =============================================================================

const fs = require("fs");
const path = require("path");

describe("sandbox.js", () => {
  let messageHandler;
  let mockPostMessage;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock window.parent.postMessage
    mockPostMessage = jest.fn();

    // Capture the message event listener
    const origAddEventListener = window.addEventListener;
    window.addEventListener = jest.fn((event, fn) => {
      if (event === "message") messageHandler = fn;
    });

    // We can't actually load transformers.js in tests, so we mock the import
    // and test the message handling logic
    let src = fs.readFileSync(path.join(__dirname, "..", "sandbox.js"), "utf-8");

    // Replace the dynamic import and model loading with a mock
    src = src.replace(
      /async function loadModel\(\)[\s\S]*?^}/m,
      `async function loadModel() {
        if (model || loading) return;
        model = async (text, opts) => ({ data: new Float32Array([0.1, 0.2, 0.3]) });
      }`
    );

    // Remove the auto-call to loadModel()
    src = src.replace(/^loadModel\(\);$/m, "");
    src = src.replace(/console\.\w+\([^)]*\);?/g, "");

    const fn = new Function("window", "console",
      src + "\nwindow._sandbox = { loadModel, embed, model };"
    );

    const mockWindow = {
      addEventListener: window.addEventListener,
      parent: { postMessage: mockPostMessage },
      _sandbox: null,
    };

    fn(mockWindow, { log: () => {}, error: () => {} });

    // Get the message handler and sandbox internals
    messageHandler = window.addEventListener.mock.calls
      .find(([evt]) => evt === "message")?.[1];

    window.addEventListener = origAddEventListener;
  });

  test("registers window message listener", () => {
    expect(messageHandler).toBeInstanceOf(Function);
  });

  test("handles EMBED messages", async () => {
    // Trigger model load first by handling an EMBED message
    await messageHandler({
      data: {
        type: "EMBED",
        eventId: 42,
        text: "Test text for embedding",
      },
    });

    // Should send back EMBED_DONE via parent.postMessage
    // (the mock model returns [0.1, 0.2, 0.3])
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "EMBED_DONE",
        eventId: 42,
      }),
      "*"
    );
  });

  test("handles EMBED_QUERY messages", async () => {
    await messageHandler({
      data: {
        type: "EMBED_QUERY",
        rid: "q_abc",
        text: "Search query",
      },
    });

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "QUERY_EMBED_DONE",
        rid: "q_abc",
      }),
      "*"
    );
  });

  test("ignores messages with no data", async () => {
    await expect(messageHandler({ data: null })).resolves.toBeUndefined;
    await expect(messageHandler({ data: {} })).resolves.toBeUndefined;
  });

  test("ignores messages with unknown type", async () => {
    mockPostMessage.mockClear();
    await messageHandler({ data: { type: "UNKNOWN" } });
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  test("sends error back when embed fails with no model", async () => {
    // Create a version where model stays null
    let src = fs.readFileSync(path.join(__dirname, "..", "sandbox.js"), "utf-8");
    src = src.replace(
      /async function loadModel\(\)[\s\S]*?^}/m,
      `async function loadModel() { /* intentionally do nothing */ }`
    );
    src = src.replace(/^loadModel\(\);$/m, "");
    src = src.replace(/console\.\w+\([^)]*\);?/g, "");

    let handler;
    const mockWin = {
      addEventListener: jest.fn((evt, fn) => { if (evt === "message") handler = fn; }),
      parent: { postMessage: mockPostMessage },
    };

    const fn = new Function("window", "console", src);
    fn(mockWin, { log: () => {}, error: () => {} });
    handler = mockWin.addEventListener.mock.calls.find(([e]) => e === "message")?.[1];

    mockPostMessage.mockClear();
    await handler({
      data: { type: "EMBED", eventId: 99, text: "test" },
    });

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "EMBED_DONE",
        eventId: 99,
        error: expect.any(String),
      }),
      "*"
    );
  });
});
