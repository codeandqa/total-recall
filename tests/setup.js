// =============================================================================
// GLOBAL TEST SETUP — Chrome API mocks and shared test utilities
// =============================================================================

// Mock chrome.runtime
const mockSendMessage = jest.fn().mockResolvedValue({});
const mockAddListener = jest.fn();
const mockRemoveListener = jest.fn();

// Mock chrome.storage.local
const storageData = {};
const mockStorageGet = jest.fn((keys, cb) => {
  if (typeof keys === "function") {
    keys(storageData);
    return;
  }
  const result = {};
  const keyArr = Array.isArray(keys) ? keys : [keys];
  keyArr.forEach((k) => {
    if (storageData[k] !== undefined) result[k] = storageData[k];
  });
  if (cb) cb(result);
  return Promise.resolve(result);
});
const mockStorageSet = jest.fn((data) => {
  Object.assign(storageData, data);
  return Promise.resolve();
});

// Mock chrome.tabs
const mockTabsCreate = jest.fn((opts, cb) => {
  const tab = { id: 1, ...opts };
  if (cb) cb(tab);
  return Promise.resolve(tab);
});
const mockTabsSendMessage = jest.fn().mockResolvedValue({});
const mockTabsOnUpdated = {
  addListener: jest.fn(),
  removeListener: jest.fn(),
};

// Mock chrome.alarms
const mockAlarmsCreate = jest.fn();
const mockAlarmsOnAlarm = { addListener: jest.fn() };

// Mock chrome.offscreen
const mockCreateDocument = jest.fn().mockResolvedValue(undefined);

// Mock chrome.sidePanel
const mockSidePanelOpen = jest.fn().mockResolvedValue(undefined);

// Assemble the global chrome object
global.chrome = {
  runtime: {
    sendMessage: mockSendMessage,
    onMessage: {
      addListener: mockAddListener,
      removeListener: mockRemoveListener,
    },
    getContexts: jest.fn().mockResolvedValue([]),
  },
  storage: {
    local: {
      get: mockStorageGet,
      set: mockStorageSet,
    },
  },
  tabs: {
    create: mockTabsCreate,
    sendMessage: mockTabsSendMessage,
    onUpdated: mockTabsOnUpdated,
  },
  alarms: {
    create: mockAlarmsCreate,
    onAlarm: mockAlarmsOnAlarm,
  },
  offscreen: {
    createDocument: mockCreateDocument,
  },
  sidePanel: {
    open: mockSidePanelOpen,
  },
};

// Mock window.close for popup tests
global.window.close = jest.fn();

// Mock confirm/alert
global.confirm = jest.fn(() => true);
global.alert = jest.fn();

// Mock fetch for API tests
global.fetch = jest.fn();

// Mock indexedDB for background.js / db.js
global.indexedDB = {
  open: jest.fn(function() {
    const mockDB = {
      transaction: jest.fn(() => ({
        objectStore: jest.fn(() => ({
          add: jest.fn((evt) => {
            evt.id = evt.id || 1;
            return { result: evt.id, set onsuccess(fn) { fn(); }, set onerror(fn) {} };
          }),
          put: jest.fn(() => ({ set onsuccess(fn) { fn(); }, set onerror(fn) {} })),
          get: jest.fn((id) => ({ result: null, set onsuccess(fn) { fn(); }, set onerror(fn) {} })),
          count: jest.fn(() => ({ result: 0, set onsuccess(fn) { fn(); }, set onerror(fn) {} })),
          clear: jest.fn(() => ({ set onsuccess(fn) { fn(); }, set onerror(fn) {} })),
          index: jest.fn(() => ({
            openCursor: jest.fn(() => ({
              set onsuccess(fn) { fn({ target: { result: null } }); },
              set onerror(fn) {},
            })),
          })),
          openCursor: jest.fn(() => ({
            set onsuccess(fn) { fn({ target: { result: null } }); },
            set onerror(fn) {},
          })),
        })),
      })),
    };
    return {
      result: mockDB,
      set onupgradeneeded(fn) { /* skip */ },
      set onsuccess(fn) { fn(); },
      set onerror(fn) {},
    };
  }),
};
