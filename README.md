# 🧠 Total Recall — AI-Powered Browser Memory

**Total Recall** is a Chrome extension that silently records everything you do in your browser and lets you search it using natural language AI — all running 100% locally on your machine. No accounts, no servers, no data ever leaves your computer.

Think of it as a photographic memory for your browser. Forgot where you saw that article? Can't find that spreadsheet? Just ask.

---

## Features

**Automatic Activity Capture** — Records page visits, clicks, text selections, search queries, form inputs, and Google Sheets edits. Runs silently in the background with no action required from you.

**AI-Powered Semantic Search** — Go beyond simple keyword matching. Search with natural language queries like "that article about climate change I read last week" or "spreadsheet comparing laptop prices" and find results by meaning, not just exact words.

**Topic Clustering** — Automatically groups your browsing activity into topics using k-means clustering on embedding vectors. See at a glance what subjects you've been exploring.

**AI Chat Assistant** — Open the side panel and have a conversation about your browsing history. Ask questions like "What did I research about React this morning?" and get a coherent summary powered by Claude or GPT.

**Search Term Highlighting** — Click any search result to re-open the page with your search terms highlighted in yellow, along with a navigation bar to jump between matches.

**100% Local and Private** — The AI model (all-MiniLM-L6-v2) runs entirely in your browser via WebAssembly. All data is stored in IndexedDB on your machine. Nothing is ever sent to any server (except the optional chat feature, which calls the LLM API you configure with your own key).

---

## Demo

Click the 🧠 icon to search your browsing memory:

```
┌─────────────────────────────────────────────┐
│  🧠 Total Recall                            │
│  Events: 1,247    Latest: 2m ago            │
│                                              │
│  [🔍 Search]  [🗂️ Topics]                   │
│                                              │
│  ┌───────────────────────────┬──────────┐   │
│  │ Search your browser memory│ [Search] │   │
│  └───────────────────────────┴──────────┘   │
│                                              │
│  [All] [Pages] [Clicks] [Selections] ...    │
│                                              │
│  📄 Machine Learning Guide        92% match │
│     medium.com/ml-guide              5m ago  │
│                                              │
│  📄 Neural Networks Explained      87% match │
│     towardsdatascience.com          12m ago  │
│                                              │
│  🔍 "deep learning tutorial"       81% match │
│     google.com                      18m ago  │
└─────────────────────────────────────────────┘
```

---

## Installation

### From Source (Developer Mode)

1. **Clone the repository**

   ```bash
   git clone https://github.com/YOUR_USERNAME/total-recall-chrome.git
   cd total-recall-chrome
   ```

2. **Load in Chrome**

   - Open Chrome and navigate to `chrome://extensions`
   - Turn ON **Developer mode** (toggle in the top-right corner)
   - Click **Load unpacked** and select the `total-recall-chrome` folder

3. **Pin the extension**

   Click the puzzle-piece icon in the Chrome toolbar and pin Total Recall for easy access.

That's it — the extension starts recording immediately.

### First-Time Setup

On first install, the AI model (~23 MB) downloads automatically in the background. This takes 30–60 seconds depending on your connection. During this time, searches use keyword matching as a fallback. Once the model loads, you'll see "AI semantic search" in the popup footer, confirming full semantic search is active. The model is cached locally, so subsequent launches are instant.

---

## How to Use

### Search

Click the 🧠 icon in your toolbar, type a natural language query, and press Enter.

**Example queries:**
- `that article about climate change`
- `spreadsheet with budget numbers`
- `amazon search for headphones`
- `form I filled out yesterday`
- `google sheets project plan`

Each result shows a **match percentage** with a detailed explanation of why it matched — hover over the score to see the full rationale. Click any result to re-open the page with your search terms highlighted.

Filter results by type using the tabs: Pages, Clicks, Selections, Searches, Inputs, Sheets.

### Topics

Switch to the **Topics** tab to see your browsing activity automatically grouped into clusters by semantic similarity. Each topic card shows a label derived from the most common words in that group, the number of events, and the domains involved. Click a topic to expand and see individual events.

### Chat

Click the **💬 Chat** button in the popup (or use the side panel) to have a conversation with an AI assistant about your browsing history. The assistant searches your stored events to answer questions like:

- "What articles did I read today?"
- "Summarize the pages I visited about React"
- "What was the name of that restaurant I looked up?"

**Requires an API key.** Click the gear icon in the side panel to configure your API provider (Anthropic or OpenAI) and paste your key. The key is stored locally and sent directly to the provider — it never touches any intermediate server.

---

## Architecture

```
  You browse the web
        │
        ▼
┌──────────────┐   events    ┌─────────────────┐   store    ┌───────────┐
│  content.js  │────────────▶│  background.js   │──────────▶│ IndexedDB │
│ (every page) │             │ (service worker) │           │ (local DB)│
└──────────────┘             └────────┬─────────┘           └───────────┘
                                      │ text
                                      ▼
                  ┌──────────────────────────────────┐
                  │  offscreen.js → sandbox.js       │
                  │  (transformers.js / ONNX Runtime) │
                  │  all-MiniLM-L6-v2 model          │
                  └──────────────────────────────────┘

  You search or chat
        │
        ▼
┌──────────────┐  search   ┌─────────────────┐
│  popup.js    │──────────▶│  background.js   │──▶ cosine similarity ──▶ results
│ (search UI)  │           │ (queries DB)     │
└──────────────┘           └─────────────────┘

┌──────────────┐  query    ┌─────────────────┐
│ sidepanel.js │──────────▶│  background.js   │──▶ results ──▶ LLM API ──▶ answer
│  (chat UI)   │           │ (context search) │
└──────────────┘           └─────────────────┘
```

### Data Flow

1. **Capture** — `content.js` is injected into every page. It listens for user actions (clicks, typing, selections, page loads, Google Sheets edits) and sends structured events to the background service worker.

2. **Store** — `background.js` receives events, deduplicates them, and stores them in IndexedDB via `db.js`. Each event includes the page URL, title, timestamp, text content, and contextual information.

3. **Embed** — Every 15 seconds, `background.js` checks for un-embedded events and sends their text to the sandboxed AI model. The model converts text into 384-dimensional vectors (embeddings) that capture semantic meaning. These vectors are stored back in IndexedDB alongside the event.

4. **Search** — When you search, your query is also converted to an embedding. `background.js` computes cosine similarity between your query vector and every stored event vector, returning the top 25 matches ranked by semantic relevance.

5. **Chat** — The side panel sends your question to `background.js` for context retrieval, then constructs a prompt with the top matching events and sends it to the configured LLM API (Anthropic Claude or OpenAI GPT).

---

## Project Structure

```
total-recall-chrome/
├── manifest.json          # Extension configuration, permissions, entry points
├── content.js             # Injected into every page — captures user activity
├── background.js          # Service worker — event processing, search, clustering
├── db.js                  # IndexedDB helper — all database read/write operations
├── offscreen.html/js      # Bridge to the sandboxed AI model
├── sandbox.html/js        # Runs transformers.js in a sandboxed iframe (CSP-safe)
├── popup.html/js/css      # Search UI with filter tabs and topic clusters
├── sidepanel.html/js/css  # AI chat interface (side panel)
├── icons/                 # Extension icons (16px, 48px, 128px)
├── tests/                 # Jest test suite (194 tests)
│   ├── setup.js           # Global Chrome API mocks
│   ├── db.test.js         # Database layer tests
│   ├── background.test.js # Service worker tests
│   ├── content.test.js    # Content script tests
│   ├── popup.test.js      # Popup UI tests
│   ├── sidepanel.test.js  # Chat UI tests
│   ├── offscreen.test.js  # Offscreen bridge tests
│   └── sandbox.test.js    # AI model interface tests
├── jest.config.js         # Test configuration with 80% coverage threshold
├── package.json           # Dev dependencies (Jest)
└── README.md              # You are here
```

---

## Tech Stack

| Technology | Purpose |
|---|---|
| **Chrome Extension Manifest V3** | Extension framework with service workers, content scripts, offscreen documents |
| **transformers.js** (Xenova/Hugging Face) | Browser-based ML inference via WebAssembly and ONNX Runtime |
| **all-MiniLM-L6-v2** | Sentence embedding model — converts text to 384-dimensional meaning vectors |
| **IndexedDB** | Browser-native local database — stores all events and embeddings on-device |
| **Cosine Similarity** | Vector comparison algorithm for semantic search ranking |
| **K-Means Clustering** | Groups semantically similar events into topic clusters |
| **Anthropic Claude / OpenAI GPT** | LLM APIs for the chat assistant (optional, requires user's own API key) |
| **Jest** | Testing framework with jsdom environment |

---

## Event Types Captured

| Event | What's Recorded |
|---|---|
| `pageview` | URL, page title, full text content (up to 20,000 chars) |
| `click` | Clicked element descriptor, surrounding context text |
| `selection` | The exact text highlighted by the user |
| `input` | Text typed into search bars and form fields |
| `search` | Search queries entered on search engines |
| `sheets_edit` | Google Sheets cell edits with cell reference and value |
| `sheets_select` | Google Sheets cell selections |
| `sheets_content` | Periodic snapshot of visible Google Sheets data |
| `tab_focus` | When you switch to a tab |
| `page_leave` | When you navigate away from a page |

---

## Running Tests

The project includes a comprehensive test suite with 194 tests across 7 test files, targeting 80%+ code coverage.

```bash
# Install dev dependencies
npm install

# Run tests with coverage report
npm test

# Run tests in watch mode (re-runs on file changes)
npm run test:watch

# Run tests with verbose output
npm run test:verbose
```

### Test Coverage

The Jest configuration enforces a minimum 80% threshold on branches, functions, lines, and statements across all 7 source files. Coverage is collected from: `db.js`, `background.js`, `content.js`, `popup.js`, `sidepanel.js`, `offscreen.js`, `sandbox.js`.

### Testing Approach

Since Chrome extension code relies on browser-specific APIs (`chrome.runtime`, `chrome.storage`, `chrome.tabs`, `IndexedDB`, `importScripts`), the test suite uses a comprehensive mocking strategy:

- **Chrome API mocks** — All `chrome.*` APIs are mocked globally in `tests/setup.js`
- **IndexedDB mock** — A synchronous mock that simulates the IndexedDB transaction pattern
- **Module isolation** — `jest.isolateModules()` ensures each test gets a fresh module instance
- **Conditional exports** — Source files export functions via `module.exports` only when running under Node.js (the `if (typeof module !== "undefined")` guard has zero effect in the browser)

---

## Privacy and Security

**All data stays on your machine.** Total Recall uses IndexedDB, which is a database built into your browser. No data is sent to any external server.

**The AI model runs locally.** The embedding model (all-MiniLM-L6-v2) runs via WebAssembly in a sandboxed iframe. It processes text entirely on your device.

**The chat feature is optional.** If you choose to use the AI chat, your API key is stored in `chrome.storage.local` and sent directly to the provider (Anthropic or OpenAI). The conversation context includes snippets from your browsing history — review the side panel to understand what's being sent.

**You own your data.** Click "Clear All Data" in the popup footer at any time to permanently delete everything.

**Permissions explained:**
- `storage` — Saving your settings (API key, preferences)
- `activeTab` / `tabs` — Reading the current tab's URL and title
- `offscreen` — Creating the hidden page where the AI model runs
- `alarms` — Scheduling periodic embedding jobs (every 15 seconds)
- `sidePanel` — The chat interface
- `<all_urls>` — Content script needs to run on every page to capture activity

---

## Configuration

### Chat API Settings

Open the side panel (click 💬 Chat in the popup) and click the gear icon:

| Setting | Description |
|---|---|
| **Provider** | `Anthropic` (Claude) or `OpenAI` (GPT) |
| **API Key** | Your personal API key from the provider |
| **Model** | Auto-detected (e.g., `claude-sonnet-4-20250514` or `gpt-4o`), or specify a custom model |

### Tunable Constants

These are defined at the top of their respective source files:

**content.js:**
- `TYPING_WAIT_MS` (1000) — Debounce delay before capturing typed input
- `PAGE_LOAD_WAIT_MS` (2500) — Wait time before extracting page text
- `MAX_PAGE_TEXT` (20000) — Maximum characters of page text to store
- `MAX_CONTEXT` (300) — Maximum characters of context per event
- `SHEETS_INTERVAL_MS` (30000) — Google Sheets capture interval

**background.js:**
- `BATCH_SIZE` (10) — Events to embed per batch
- `EMBED_INTERVAL_MIN` (0.25) — Embedding batch interval in minutes (15 seconds)

---

## Troubleshooting

**No results showing up?**
The AI model may still be downloading (~23 MB on first install). Wait 30–60 seconds and try again. The keyword fallback works immediately but finds results by exact word matches rather than meaning.

**Extension not capturing activity?**
Check that it's enabled at `chrome://extensions`. Refresh the page you want to capture. If you just installed, wait a few seconds for the content script to initialize.

**Slow first search?**
The model needs to load into memory the first time after each Chrome restart. Subsequent searches are fast.

**Chat not responding?**
Make sure you've configured a valid API key in the side panel settings (gear icon). Check that the API provider and model are correct.

**High memory usage?**
The AI model uses approximately 50–100 MB of RAM while loaded. This is expected. The model is only active in the offscreen document and doesn't affect your browsing tabs.

---

## Contributing

Contributions are welcome! Here's how to get started:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run the test suite to make sure nothing is broken (`npm test`)
5. Commit your changes (`git commit -m 'Add amazing feature'`)
6. Push to your branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

### Development Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/total-recall-chrome.git
cd total-recall-chrome

# Install dev dependencies
npm install

# Run tests in watch mode while developing
npm run test:watch
```

To test changes in Chrome, go to `chrome://extensions`, click the refresh icon on the Total Recall card, then reload any open tab.

### Ideas for Contributions

- **Export/import** — Let users export their browsing history and import it on another device
- **Date range filters** — Filter search results by time period
- **Firefox support** — Port to Firefox using WebExtensions APIs
- **Custom embedding models** — Allow users to swap in different models from Hugging Face
- **Dashboard** — A full-page view with browsing analytics and charts
- **Bookmarking** — Let users star/pin important events for quick access

---

## License

This project is open source under the [MIT License](LICENSE).

---

## Acknowledgments

- [transformers.js](https://github.com/xenova/transformers.js) by Xenova — for making ML inference possible in the browser
- [all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) by Sentence Transformers — the embedding model that powers semantic search
- Built as a hackathon project to demonstrate what's possible with fully local AI in browser extensions
