// =============================================================================
// DATABASE LAYER — Stores and retrieves events using IndexedDB
// =============================================================================
//
// IndexedDB is a database built into every browser. It stores data locally
// on the user's computer — nothing is sent to any server.
//
// Each "event" we store looks like this:
// {
//   id:        123,                    ← auto-generated unique number
//   type:      "pageview",             ← what happened (click, selection, etc.)
//   url:       "https://example.com",  ← where it happened
//   title:     "Example Page",         ← page title
//   timestamp: 1716681600000,          ← when (milliseconds since Jan 1 1970)
//   content:   "the full text...",     ← main text captured
//   context:   "Visited: Example...",  ← human-readable summary
//   metadata:  { ... },               ← extra details (element clicked, etc.)
//   embedding: [0.12, -0.45, ...],    ← AI-generated meaning vector (384 numbers)
// }
//
// The "embedding" is what makes smart search work. It's an array of 384
// numbers that represents the MEANING of the text. Similar meanings produce
// similar number patterns, so we can find related content mathematically.
//
// =============================================================================

const DB_NAME = "TotalRecallDB";
const DB_VERSION = 1;
const STORE = "events";

// ---------------------------------------------------------------------------
// OPEN DATABASE — creates it if this is the first time
// ---------------------------------------------------------------------------
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    // Called when the DB is brand new or needs a structure update
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, {
          keyPath: "id",
          autoIncrement: true,   // IDs are 1, 2, 3, ... automatically
        });

        // "Indexes" let us search and sort by specific fields quickly
        store.createIndex("type", "type");
        store.createIndex("url", "url");
        store.createIndex("timestamp", "timestamp");
        store.createIndex("title", "title");
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------------
// SAVE — store a new event in the database
// ---------------------------------------------------------------------------
async function saveEvent(event) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const rq = tx.objectStore(STORE).add(event);
    rq.onsuccess = () => resolve(rq.result);    // returns the new ID
    rq.onerror = () => reject(rq.error);
  });
}

// ---------------------------------------------------------------------------
// UPDATE — modify an existing event (used to attach embeddings)
// ---------------------------------------------------------------------------
async function updateEvent(id, changes) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);

    // Step 1: read the existing record
    const get = store.get(id);
    get.onsuccess = () => {
      if (!get.result) return reject(new Error("Event " + id + " not found"));

      // Step 2: merge in the changes and save
      const updated = Object.assign({}, get.result, changes);
      const put = store.put(updated);
      put.onsuccess = () => resolve(updated);
      put.onerror = () => reject(put.error);
    };
    get.onerror = () => reject(get.error);
  });
}

// ---------------------------------------------------------------------------
// GET ALL — return recent events, newest first
// ---------------------------------------------------------------------------
async function getAllEvents(limit) {
  limit = limit || 500;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const idx = tx.objectStore(STORE).index("timestamp");
    const out = [];

    // "prev" = go backwards through the timestamp index (newest first)
    const cursor = idx.openCursor(null, "prev");
    cursor.onsuccess = (e) => {
      const c = e.target.result;
      if (c && out.length < limit) {
        out.push(c.value);
        c.continue();
      } else {
        resolve(out);
      }
    };
    cursor.onerror = () => reject(cursor.error);
  });
}

// ---------------------------------------------------------------------------
// GET UNEMBEDDED — events that haven't been processed by the AI yet
// ---------------------------------------------------------------------------
async function getUnembeddedEvents(limit) {
  limit = limit || 50;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const out = [];

    const cursor = tx.objectStore(STORE).openCursor(null, "prev");
    cursor.onsuccess = (e) => {
      const c = e.target.result;
      if (c && out.length < limit) {
        if (!c.value.embedding) out.push(c.value);   // no embedding yet
        c.continue();
      } else {
        resolve(out);
      }
    };
    cursor.onerror = () => reject(cursor.error);
  });
}

// ---------------------------------------------------------------------------
// GET EMBEDDED — events that HAVE been processed (for search)
// ---------------------------------------------------------------------------
async function getEmbeddedEvents() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const out = [];

    const cursor = tx.objectStore(STORE).openCursor();
    cursor.onsuccess = (e) => {
      const c = e.target.result;
      if (c) {
        if (c.value.embedding && c.value.embedding.length > 0) out.push(c.value);
        c.continue();
      } else {
        resolve(out);
      }
    };
    cursor.onerror = () => reject(cursor.error);
  });
}

// ---------------------------------------------------------------------------
// COUNT — how many events are stored
// ---------------------------------------------------------------------------
async function countEvents() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const rq = tx.objectStore(STORE).count();
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}

// ---------------------------------------------------------------------------
// CLEAR — delete everything (for privacy / testing)
// ---------------------------------------------------------------------------
async function clearAllEvents() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const rq = tx.objectStore(STORE).clear();
    rq.onsuccess = () => resolve();
    rq.onerror = () => reject(rq.error);
  });
}

// ===========================================================================
// COSINE SIMILARITY — the math behind semantic search
// ===========================================================================
//
// Every text gets converted into an "embedding" — an array of 384 numbers.
// Think of it as a point in 384-dimensional space. Texts with similar
// meanings end up near each other in this space.
//
// Cosine similarity measures the angle between two of these points:
//   • 1.0  = identical meaning (pointing the same direction)
//   • 0.0  = completely unrelated (perpendicular)
//   • -1.0 = opposite meaning (pointing opposite directions)
//
// The formula is: dot(A,B) / (|A| * |B|)
//
// ===========================================================================
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;

  let dot = 0;    // sum of a[i] * b[i]
  let magA = 0;   // sum of a[i]^2
  let magB = 0;   // sum of b[i]^2

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);

  if (magA === 0 || magB === 0) return 0;
  return dot / (magA * magB);
}

// Export for testing (no effect in browser — module is undefined)
if (typeof module !== "undefined") {
  module.exports = {
    DB_NAME, DB_VERSION, STORE, openDB,
    saveEvent, updateEvent, getAllEvents, getUnembeddedEvents,
    getEmbeddedEvents, countEvents, clearAllEvents, cosineSimilarity,
  };
}
