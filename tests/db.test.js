// =============================================================================
// TESTS FOR db.js — IndexedDB wrapper and cosine similarity
// =============================================================================

// Since db.js uses global functions (designed for importScripts), we load it
// by evaluating the file content and extracting the functions.
const fs = require("fs");
const path = require("path");

// ---------- Load db.js source as module-like exports ----------
const dbSource = fs.readFileSync(path.join(__dirname, "..", "db.js"), "utf-8");

// We can't run the full IndexedDB code in jest-jsdom easily without fake-indexeddb,
// so we extract and test the pure functions (cosineSimilarity) directly,
// and test the DB functions by mocking IndexedDB.

// Extract cosineSimilarity by evaluating in a controlled scope
let cosineSimilarity;
{
  const module = { exports: {} };
  const fn = new Function(
    "module", "exports", "indexedDB",
    dbSource + "\nmodule.exports = { cosineSimilarity, DB_NAME, DB_VERSION, STORE };"
  );
  fn(module, module.exports, {});
  cosineSimilarity = module.exports.cosineSimilarity;
}

// =============================================================================
// COSINE SIMILARITY TESTS
// =============================================================================
describe("cosineSimilarity", () => {
  test("returns 1.0 for identical vectors", () => {
    const v = [1, 2, 3, 4, 5];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  test("returns 0 for orthogonal vectors", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  test("returns -1 for opposite vectors", () => {
    const a = [1, 2, 3];
    const b = [-1, -2, -3];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  test("returns 0 when either vector is null", () => {
    expect(cosineSimilarity(null, [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], null)).toBe(0);
  });

  test("returns 0 when either vector is undefined", () => {
    expect(cosineSimilarity(undefined, [1])).toBe(0);
    expect(cosineSimilarity([1], undefined)).toBe(0);
  });

  test("returns 0 when vectors have different lengths", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  test("returns 0 for zero vector", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  test("returns 0 when both vectors are zero", () => {
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  test("handles single-dimension vectors", () => {
    expect(cosineSimilarity([5], [3])).toBeCloseTo(1.0, 5);
    expect(cosineSimilarity([5], [-3])).toBeCloseTo(-1.0, 5);
  });

  test("handles large vectors (384 dims like MiniLM)", () => {
    const a = Array.from({ length: 384 }, (_, i) => Math.sin(i));
    const b = Array.from({ length: 384 }, (_, i) => Math.cos(i));
    const result = cosineSimilarity(a, b);
    expect(result).toBeGreaterThanOrEqual(-1);
    expect(result).toBeLessThanOrEqual(1);
  });

  test("is symmetric: cosine(a,b) === cosine(b,a)", () => {
    const a = [0.3, -0.7, 0.5, 0.1];
    const b = [0.8, 0.2, -0.4, 0.6];
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 10);
  });

  test("similar vectors have high similarity", () => {
    const a = [1, 2, 3, 4];
    const b = [1.1, 2.05, 2.95, 4.1]; // slightly different
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.99);
  });

  test("dissimilar vectors have low similarity", () => {
    const a = [1, 0, 0, 0];
    const b = [0, 0, 0, 1];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  test("handles empty arrays", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  test("handles negative values correctly", () => {
    const a = [-0.5, 0.3, -0.8];
    const b = [-0.5, 0.3, -0.8];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });
});

// =============================================================================
// IndexedDB FUNCTION TESTS (with mock)
// =============================================================================
// Since jest-jsdom doesn't include a real IndexedDB, we test the DB functions
// through a mock-based approach to verify the logic flows.

describe("db.js IndexedDB functions", () => {
  let openDB, saveEvent, updateEvent, getAllEvents, getUnembeddedEvents,
      getEmbeddedEvents, countEvents, clearAllEvents;

  beforeEach(() => {
    // Create a mock IndexedDB that tracks calls
    const mockStore = {
      _data: [],
      _autoId: 1,
      add: jest.fn(function (event) {
        const id = this._autoId++;
        event.id = id;
        this._data.push({ ...event });
        return { result: id, set onsuccess(fn) { fn(); }, set onerror(fn) {} };
      }),
      put: jest.fn(function (event) {
        const idx = this._data.findIndex((e) => e.id === event.id);
        if (idx >= 0) this._data[idx] = { ...event };
        return { result: event, set onsuccess(fn) { fn(); }, set onerror(fn) {} };
      }),
      get: jest.fn(function (id) {
        const found = this._data.find((e) => e.id === id);
        const req = { result: found || null };
        setTimeout(() => req.onsuccess?.(), 0);
        return req;
      }),
      count: jest.fn(function () {
        return {
          result: this._data.length,
          set onsuccess(fn) { fn(); },
          set onerror(fn) {},
        };
      }),
      clear: jest.fn(function () {
        this._data = [];
        return { set onsuccess(fn) { fn(); }, set onerror(fn) {} };
      }),
      index: jest.fn(() => ({
        openCursor: jest.fn(() => {
          let idx = 0;
          const sorted = [...mockStore._data].sort((a, b) => b.timestamp - a.timestamp);
          return {
            set onsuccess(fn) {
              const advance = () => {
                if (idx < sorted.length) {
                  fn({
                    target: {
                      result: {
                        value: sorted[idx],
                        continue: () => { idx++; advance(); },
                      },
                    },
                  });
                } else {
                  fn({ target: { result: null } });
                }
              };
              advance();
            },
            set onerror(fn) {},
          };
        }),
      })),
      openCursor: jest.fn(() => {
        let idx = 0;
        return {
          set onsuccess(fn) {
            const advance = () => {
              if (idx < mockStore._data.length) {
                fn({
                  target: {
                    result: {
                      value: mockStore._data[idx],
                      continue: () => { idx++; advance(); },
                    },
                  },
                });
              } else {
                fn({ target: { result: null } });
              }
            };
            advance();
          },
          set onerror(fn) {},
        };
      }),
    };

    const mockDB = {
      transaction: jest.fn(() => ({
        objectStore: jest.fn(() => mockStore),
      })),
    };

    const mockIndexedDB = {
      open: jest.fn(() => ({
        set onupgradeneeded(fn) {},
        set onsuccess(fn) { fn(); },
        set onerror(fn) {},
        result: mockDB,
      })),
    };

    // Re-evaluate db.js with our mock
    const src = fs.readFileSync(path.join(__dirname, "..", "db.js"), "utf-8");
    const mod = { exports: {} };
    const fn = new Function(
      "module", "exports", "indexedDB",
      src + "\nmodule.exports = { openDB, saveEvent, updateEvent, getAllEvents, getUnembeddedEvents, getEmbeddedEvents, countEvents, clearAllEvents, cosineSimilarity };"
    );
    fn(mod, mod.exports, mockIndexedDB);
    ({ openDB, saveEvent, updateEvent, getAllEvents, getUnembeddedEvents,
       getEmbeddedEvents, countEvents, clearAllEvents } = mod.exports);
  });

  test("openDB returns a database object", async () => {
    const db = await openDB();
    expect(db).toBeDefined();
    expect(db.transaction).toBeDefined();
  });

  test("saveEvent calls add on the object store", async () => {
    const evt = { type: "pageview", url: "https://example.com", timestamp: Date.now() };
    const id = await saveEvent(evt);
    expect(id).toBeDefined();
  });

  test("countEvents returns a number", async () => {
    const count = await countEvents();
    expect(typeof count).toBe("number");
  });

  test("clearAllEvents resolves without error", async () => {
    await expect(clearAllEvents()).resolves.toBeUndefined();
  });
});
