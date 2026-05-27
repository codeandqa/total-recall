// =============================================================================
// TESTS FOR offscreen.js — Message bridge between background and sandbox
// =============================================================================

const fs = require("fs");
const path = require("path");

describe("offscreen.js bridge", () => {
  let messageHandler;
  let postMessageHandler;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock sandbox iframe
    const mockIframe = {
      contentWindow: {
        postMessage: jest.fn(),
      },
      addEventListener: jest.fn((event, fn) => {
        if (event === "load") fn(); // Immediately fire load
      }),
    };

    document.getElementById = jest.fn((id) => {
      if (id === "sandbox") return mockIframe;
      return null;
    });

    // Capture chrome.runtime.onMessage listener
    chrome.runtime.onMessage.addListener = jest.fn((fn) => {
      messageHandler = fn;
    });

    // Capture window message listener
    const origAddEventListener = window.addEventListener;
    window.addEventListener = jest.fn((event, fn) => {
      if (event === "message") postMessageHandler = fn;
    });

    // Load offscreen.js
    let src = fs.readFileSync(path.join(__dirname, "..", "offscreen.js"), "utf-8");
    src = src.replace(/console\.\w+\([^)]*\);?/g, "");

    const fn = new Function("document", "chrome", "window", "console", src);
    fn(document, chrome, window, { log: () => {}, error: () => {}, warn: () => {} });

    window.addEventListener = origAddEventListener;
  });

  test("registers chrome.runtime.onMessage listener", () => {
    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalled();
    expect(messageHandler).toBeInstanceOf(Function);
  });

  test("registers window message listener", () => {
    expect(postMessageHandler).toBeInstanceOf(Function);
  });

  test("forwards EMBED messages from background to sandbox", () => {
    const sandbox = document.getElementById("sandbox");
    messageHandler(
      { target: "offscreen", action: "EMBED", eventId: 42, text: "test text" },
      {},
      jest.fn()
    );
    expect(sandbox.contentWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "EMBED",
        eventId: 42,
        text: "test text",
      }),
      "*"
    );
  });

  test("forwards EMBED_QUERY messages from background to sandbox", () => {
    const sandbox = document.getElementById("sandbox");
    messageHandler(
      { target: "offscreen", action: "EMBED_QUERY", rid: "q_123", text: "query" },
      {},
      jest.fn()
    );
    expect(sandbox.contentWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "EMBED_QUERY",
        rid: "q_123",
        text: "query",
      }),
      "*"
    );
  });

  test("ignores messages not targeted to offscreen", () => {
    const sandbox = document.getElementById("sandbox");
    messageHandler(
      { target: "other", action: "EMBED", text: "test" },
      {},
      jest.fn()
    );
    expect(sandbox.contentWindow.postMessage).not.toHaveBeenCalled();
  });

  test("forwards EMBED_DONE from sandbox to background", () => {
    postMessageHandler({
      data: {
        type: "EMBED_DONE",
        eventId: 42,
        embedding: [0.1, 0.2, 0.3],
      },
    });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "EMBED_DONE",
        eventId: 42,
        embedding: [0.1, 0.2, 0.3],
      })
    );
  });

  test("forwards QUERY_EMBED_DONE from sandbox to background", () => {
    postMessageHandler({
      data: {
        type: "QUERY_EMBED_DONE",
        rid: "q_123",
        embedding: [0.4, 0.5],
      },
    });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "QUERY_EMBED_DONE",
        rid: "q_123",
        embedding: [0.4, 0.5],
      })
    );
  });

  test("forwards EMBED_DONE errors from sandbox to background", () => {
    postMessageHandler({
      data: {
        type: "EMBED_DONE",
        eventId: 42,
        error: "Model not ready",
      },
    });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "EMBED_DONE",
        eventId: 42,
        error: "Model not ready",
      })
    );
  });

  test("handles MODEL_READY message without crashing", () => {
    expect(() => {
      postMessageHandler({ data: { type: "MODEL_READY" } });
    }).not.toThrow();
  });

  test("handles MODEL_ERROR message without crashing", () => {
    expect(() => {
      postMessageHandler({ data: { type: "MODEL_ERROR", error: "Failed" } });
    }).not.toThrow();
  });

  test("ignores messages with no data", () => {
    expect(() => postMessageHandler({ data: null })).not.toThrow();
    expect(() => postMessageHandler({ data: {} })).not.toThrow();
    expect(() => postMessageHandler({ data: { type: null } })).not.toThrow();
  });

  test("ignores messages with unknown type", () => {
    chrome.runtime.sendMessage.mockClear();
    postMessageHandler({ data: { type: "UNKNOWN_TYPE" } });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});
