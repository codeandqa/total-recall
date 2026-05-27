// =============================================================================
// SANDBOX SCRIPT — Runs the transformers.js AI model
// =============================================================================
//
// WHY A SANDBOX?
// Chrome MV3 forbids extension pages from loading external scripts.
// But sandbox pages have relaxed security rules and CAN load from CDN.
// The tradeoff: sandbox pages can't use chrome.* APIs. So we communicate
// with the rest of the extension via window.postMessage().
//
// WHAT THIS DOES:
//   1. Loads transformers.js from Hugging Face CDN
//   2. Downloads the all-MiniLM-L6-v2 embedding model (~23 MB, cached)
//   3. Listens for text via postMessage
//   4. Converts text to a 384-number embedding vector
//   5. Sends the result back via postMessage
//
// =============================================================================

let model = null;
let loading = false;

// ---------------------------------------------------------------------------
// LOAD THE AI MODEL
// ---------------------------------------------------------------------------
async function loadModel() {
  if (model || loading) return;
  loading = true;

  try {
    console.log("[TR-Sandbox] Loading transformers.js from CDN...");

    // Dynamic import — this is why we need the sandbox (CDN import)
    const tf = await import(
      "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2"
    );

    console.log("[TR-Sandbox] Downloading AI model (first time ≈ 30-60s)...");

    // Create a feature-extraction pipeline with the embedding model
    model = await tf.pipeline(
      "feature-extraction",          // Task: convert text to vectors
      "Xenova/all-MiniLM-L6-v2",    // Model: small but effective
      { quantized: true }            // Use compressed version
    );

    loading = false;
    console.log("[TR-Sandbox] AI model ready!");

    // Tell the parent (offscreen.js) that we're ready
    window.parent.postMessage({ type: "MODEL_READY" }, "*");
  } catch (err) {
    loading = false;
    console.error("[TR-Sandbox] Model load failed:", err);
    window.parent.postMessage({ type: "MODEL_ERROR", error: err.message }, "*");
  }
}

// Start loading immediately
loadModel();

// ---------------------------------------------------------------------------
// GENERATE EMBEDDING — convert text to a number vector
// ---------------------------------------------------------------------------
async function embed(text) {
  if (!model) {
    await loadModel();
    if (!model) throw new Error("AI model not available");
  }

  // Truncate to ~1000 chars (model has a token limit)
  const output = await model(text.slice(0, 1000), {
    pooling: "mean",     // Average all word vectors into one
    normalize: true,     // Unit length (required for cosine similarity)
  });

  return Array.from(output.data);
}

// ---------------------------------------------------------------------------
// LISTEN for messages from offscreen.js (parent window)
// ---------------------------------------------------------------------------
window.addEventListener("message", async (e) => {
  const msg = e.data;
  if (!msg || !msg.type) return;

  // --- Embed text for a stored event ---
  if (msg.type === "EMBED") {
    try {
      const vec = await embed(msg.text);
      window.parent.postMessage({
        type: "EMBED_DONE",
        eventId: msg.eventId,
        embedding: vec,
      }, "*");
    } catch (err) {
      window.parent.postMessage({
        type: "EMBED_DONE",
        eventId: msg.eventId,
        error: err.message,
      }, "*");
    }
  }

  // --- Embed text for a search query ---
  if (msg.type === "EMBED_QUERY") {
    try {
      const vec = await embed(msg.text);
      window.parent.postMessage({
        type: "QUERY_EMBED_DONE",
        rid: msg.rid,
        embedding: vec,
      }, "*");
    } catch (err) {
      window.parent.postMessage({
        type: "QUERY_EMBED_DONE",
        rid: msg.rid,
        error: err.message,
      }, "*");
    }
  }
});

console.log("[TR-Sandbox] Sandbox loaded. Model loading in background...");
