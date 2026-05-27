// =============================================================================
// OFFSCREEN BRIDGE — Connects background.js ↔ sandbox.html
// =============================================================================
//
// This script acts as a translator between two worlds:
//
//   background.js (can use chrome.* APIs, can't load CDN scripts)
//       ↕  chrome.runtime.sendMessage / onMessage
//   offscreen.js (THIS FILE — bridge)
//       ↕  window.postMessage
//   sandbox.html (can load CDN scripts, can't use chrome.* APIs)
//
// Messages flow like this:
//   1. background.js sends "EMBED" or "EMBED_QUERY" via chrome.runtime
//   2. This script forwards it to sandbox.html via postMessage
//   3. sandbox.html runs the AI model and sends back the result
//   4. This script forwards the result to background.js via chrome.runtime
//
// =============================================================================

// Get reference to the sandbox iframe
const sandbox = document.getElementById("sandbox");

// Wait for the iframe to finish loading before sending messages
let sandboxReady = false;

sandbox.addEventListener("load", () => {
  sandboxReady = true;
  console.log("[TR-Bridge] Sandbox iframe loaded");
});

// ===========================================================================
// DIRECTION 1: background.js → sandbox.html
// ===========================================================================
// Listen for chrome.runtime messages from background.js and forward
// them to the sandbox iframe via postMessage.
// ===========================================================================
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.target !== "offscreen") return;

  if (msg.action === "EMBED" || msg.action === "EMBED_QUERY") {
    if (!sandboxReady) {
      console.warn("[TR-Bridge] Sandbox not ready yet, skipping");
      return;
    }

    // Forward to sandbox, translating "action" to "type" for postMessage
    sandbox.contentWindow.postMessage({
      type: msg.action,         // "EMBED" or "EMBED_QUERY"
      eventId: msg.eventId,     // ID of the stored event (for EMBED)
      rid: msg.rid,             // Request ID (for EMBED_QUERY)
      text: msg.text,           // The text to embed
    }, "*");
  }
});

// ===========================================================================
// DIRECTION 2: sandbox.html → background.js
// ===========================================================================
// Listen for postMessage results from the sandbox and forward them
// to background.js via chrome.runtime.sendMessage.
// ===========================================================================
window.addEventListener("message", (e) => {
  const msg = e.data;
  if (!msg || !msg.type) return;

  // Forward embedding results back to background.js
  if (msg.type === "EMBED_DONE") {
    chrome.runtime.sendMessage({
      action: "EMBED_DONE",
      eventId: msg.eventId,
      embedding: msg.embedding,
      error: msg.error,
    });
  }

  if (msg.type === "QUERY_EMBED_DONE") {
    chrome.runtime.sendMessage({
      action: "QUERY_EMBED_DONE",
      rid: msg.rid,
      embedding: msg.embedding,
      error: msg.error,
    });
  }

  if (msg.type === "MODEL_READY") {
    console.log("[TR-Bridge] AI model is ready in sandbox!");
  }

  if (msg.type === "MODEL_ERROR") {
    console.error("[TR-Bridge] AI model failed:", msg.error);
  }
});

console.log("[TR-Bridge] Offscreen bridge loaded");
