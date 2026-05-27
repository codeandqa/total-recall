// =============================================================================
// SIDE PANEL CHAT — Ask questions about your browsing history
// =============================================================================
//
// HOW IT WORKS:
//   1. User types a question ("What articles did I read about AI?")
//   2. We send the question to background.js which searches IndexedDB
//   3. background.js returns the top matching events (with semantic search)
//   4. We build a prompt with those events as context
//   5. We call the LLM API (Anthropic or OpenAI) with the prompt
//   6. We stream the response back into the chat
//
// The user's API key is stored in chrome.storage.local and sent
// directly to the provider — it never touches our servers.
//
// =============================================================================

// ---------------------------------------------------------------------------
// ELEMENT REFERENCES
// ---------------------------------------------------------------------------
const $messages = document.getElementById("messages");
const $input = document.getElementById("chat-input");
const $sendBtn = document.getElementById("send-btn");
const $settingsToggle = document.getElementById("settings-toggle");
const $settingsPanel = document.getElementById("settings-panel");
const $apiProvider = document.getElementById("api-provider");
const $apiKey = document.getElementById("api-key");
const $apiModel = document.getElementById("api-model");
const $saveSettings = document.getElementById("save-settings");
const $closeSettings = document.getElementById("close-settings");
const $settingsStatus = document.getElementById("settings-status");
const $keyStatus = document.getElementById("key-status");

// Conversation history for multi-turn chat
let chatHistory = [];

// ===========================================================================
// SETTINGS — Load / Save API configuration
// ===========================================================================
async function loadSettings() {
  const data = await chrome.storage.local.get(["apiProvider", "apiKey", "apiModel"]);
  if (data.apiProvider) $apiProvider.value = data.apiProvider;
  if (data.apiKey) $apiKey.value = data.apiKey;
  if (data.apiModel) $apiModel.value = data.apiModel;

  updateKeyStatus();
}

async function saveSettings() {
  const provider = $apiProvider.value;
  const key = $apiKey.value.trim();
  const model = $apiModel.value.trim();

  if (!key) {
    showSettingsStatus("Please enter an API key", "err");
    return;
  }

  await chrome.storage.local.set({
    apiProvider: provider,
    apiKey: key,
    apiModel: model || getDefaultModel(provider),
  });

  showSettingsStatus("Settings saved!", "ok");
  updateKeyStatus();
  setTimeout(() => {
    $settingsPanel.style.display = "none";
  }, 800);
}

function getDefaultModel(provider) {
  if (provider === "anthropic") return "claude-sonnet-4-20250514";
  if (provider === "openai") return "gpt-4o-mini";
  return "";
}

function showSettingsStatus(msg, type) {
  $settingsStatus.textContent = msg;
  $settingsStatus.className = "sp-settings-status " + type;
}

function updateKeyStatus() {
  chrome.storage.local.get(["apiProvider", "apiKey"], (data) => {
    if (data.apiKey) {
      const provider = data.apiProvider === "anthropic" ? "Claude" : "GPT";
      $keyStatus.innerHTML = `<span class="ready">Connected to ${provider}</span>`;
    } else {
      $keyStatus.innerHTML = `<span class="warn">No API key — click the gear icon to set up</span>`;
    }
  });
}

// Settings panel toggle
$settingsToggle.addEventListener("click", () => {
  const visible = $settingsPanel.style.display !== "none";
  $settingsPanel.style.display = visible ? "none" : "block";
});

$saveSettings.addEventListener("click", saveSettings);
$closeSettings.addEventListener("click", () => {
  $settingsPanel.style.display = "none";
});

// Update model placeholder when provider changes
$apiProvider.addEventListener("change", () => {
  $apiModel.placeholder = getDefaultModel($apiProvider.value);
});

// Load settings on start
loadSettings();

// ===========================================================================
// CHAT — Send messages and get responses
// ===========================================================================
async function sendMessage() {
  const text = $input.value.trim();
  if (!text) return;

  // Check for API key
  const settings = await chrome.storage.local.get(["apiProvider", "apiKey", "apiModel"]);
  if (!settings.apiKey) {
    $settingsPanel.style.display = "block";
    showSettingsStatus("Please add your API key first", "err");
    return;
  }

  // Add user message to UI
  addMessage("user", text);
  $input.value = "";
  $input.style.height = "auto";
  $sendBtn.disabled = true;

  // Show typing indicator
  const typingEl = addTypingIndicator();

  try {
    // Step 1: Search browsing history for relevant context
    const searchResults = await searchHistory(text);

    // Step 2: Build the prompt with context
    const prompt = buildPrompt(text, searchResults);

    // Step 3: Call the LLM API
    const response = await callLLM(settings, prompt);

    // Remove typing indicator
    typingEl.remove();

    // Step 4: Display the response with sources
    addAIMessage(response, searchResults);

    // Add to conversation history
    chatHistory.push({ role: "user", content: text });
    chatHistory.push({ role: "assistant", content: response });

    // Keep history manageable (last 10 exchanges)
    if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);

  } catch (err) {
    typingEl.remove();
    addMessage("ai", `Sorry, something went wrong: ${err.message}. Check your API key in settings.`);
  }

  $sendBtn.disabled = false;
}

// Trigger send
$sendBtn.addEventListener("click", sendMessage);
$input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-resize textarea
$input.addEventListener("input", () => {
  $input.style.height = "auto";
  $input.style.height = Math.min($input.scrollHeight, 120) + "px";
});

// ===========================================================================
// SEARCH HISTORY — ask background.js for relevant events
// ===========================================================================
async function searchHistory(query) {
  try {
    const res = await chrome.runtime.sendMessage({ action: "CHAT_SEARCH", query });
    return res?.results || [];
  } catch {
    return [];
  }
}

// ===========================================================================
// BUILD PROMPT — create a rich prompt with browsing context
// ===========================================================================
function buildPrompt(userQuestion, events) {
  // Format each event into a readable context block
  const contextBlocks = events.slice(0, 15).map((e, i) => {
    const time = new Date(e.timestamp).toLocaleString();
    const type = e.type.replace(/_/g, " ");
    let block = `[${i + 1}] ${type.toUpperCase()} — ${time}`;
    block += `\n    Title: ${e.title || "Untitled"}`;
    block += `\n    URL: ${e.url || "unknown"}`;
    if (e.context) block += `\n    Action: ${e.context}`;
    if (e.content) block += `\n    Content: ${e.content.slice(0, 500)}`;
    if (e.score != null) block += `\n    Relevance: ${Math.round(e.score * 100)}%`;
    return block;
  }).join("\n\n");

  const systemPrompt = `You are Total Recall, an AI assistant with access to the user's browsing history. You help users remember and understand their past browser activity.

RULES:
- Answer based ONLY on the browsing history provided below. Do not make up information.
- If the history doesn't contain what the user is asking about, say so honestly.
- Be specific — mention page titles, URLs, timestamps, and what the user did.
- Keep answers concise but informative.
- When referencing a page, include its title and URL so the user can revisit it.
- Format your response nicely with clear structure when listing multiple items.
- If the user asks about something time-specific ("yesterday", "this morning"), use the timestamps.

BROWSING HISTORY (most relevant results):
${contextBlocks || "No relevant browsing history found for this query."}`;

  // Build messages array with conversation history
  const messages = [{ role: "user", content: systemPrompt + "\n\nUser question: " + userQuestion }];

  // Add recent chat history for context
  if (chatHistory.length > 0) {
    // Prepend conversation context
    const historyContext = chatHistory.slice(-6).map(
      (m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`
    ).join("\n");
    messages[0].content += `\n\nPrevious conversation:\n${historyContext}\n\nNew question: ${userQuestion}`;
  }

  return messages;
}

// ===========================================================================
// CALL LLM — send to Anthropic or OpenAI API
// ===========================================================================
async function callLLM(settings, messages) {
  const provider = settings.apiProvider || "anthropic";
  const apiKey = settings.apiKey;
  const model = settings.apiModel || getDefaultModel(provider);

  if (provider === "anthropic") {
    return callAnthropic(apiKey, model, messages);
  } else {
    return callOpenAI(apiKey, model, messages);
  }
}

// --- Anthropic Claude API ---
async function callAnthropic(apiKey, model, messages) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 1024,
      messages: messages.map((m) => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.content,
      })),
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${err}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text || "No response received.";
}

// --- OpenAI API ---
async function callOpenAI(apiKey, model, messages) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model,
      messages: messages.map((m) => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.content,
      })),
      max_tokens: 1024,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${err}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "No response received.";
}

// ===========================================================================
// UI — Add messages to the chat
// ===========================================================================
function addMessage(role, text) {
  const msg = document.createElement("div");
  msg.className = `sp-msg sp-msg-${role}`;

  const avatar = role === "ai" ? "🧠" : "👤";

  msg.innerHTML = `
    <div class="sp-msg-avatar">${avatar}</div>
    <div class="sp-msg-body">
      <div class="sp-msg-text">${escapeAndFormat(text)}</div>
    </div>
  `;

  $messages.appendChild(msg);
  scrollToBottom();
  return msg;
}

function addAIMessage(text, sources) {
  const msg = document.createElement("div");
  msg.className = "sp-msg sp-msg-ai";

  // Build sources list (top 5 unique URLs)
  const uniqueUrls = [];
  const seen = new Set();
  for (const s of sources) {
    if (s.url && !seen.has(s.url) && !s.url.startsWith("chrome")) {
      seen.add(s.url);
      uniqueUrls.push({ title: s.title || s.url, url: s.url });
      if (uniqueUrls.length >= 5) break;
    }
  }

  let sourcesHtml = "";
  if (uniqueUrls.length > 0) {
    sourcesHtml = `
      <div class="sp-sources">
        <div class="sp-sources-title">Sources from your history:</div>
        ${uniqueUrls.map((s) =>
          `<a class="sp-source-link" href="${esc(s.url)}" target="_blank" title="${esc(s.url)}">${esc(s.title)}</a>`
        ).join("")}
      </div>
    `;
  }

  msg.innerHTML = `
    <div class="sp-msg-avatar">🧠</div>
    <div class="sp-msg-body">
      <div class="sp-msg-text">${escapeAndFormat(text)}${sourcesHtml}</div>
    </div>
  `;

  $messages.appendChild(msg);
  scrollToBottom();
}

function addTypingIndicator() {
  const msg = document.createElement("div");
  msg.className = "sp-msg sp-msg-ai";
  msg.innerHTML = `
    <div class="sp-msg-avatar">🧠</div>
    <div class="sp-msg-body">
      <div class="sp-typing"><span></span><span></span><span></span></div>
    </div>
  `;
  $messages.appendChild(msg);
  scrollToBottom();
  return msg;
}

function scrollToBottom() {
  $messages.scrollTop = $messages.scrollHeight;
}

// ===========================================================================
// TEXT FORMATTING — basic markdown-like rendering
// ===========================================================================
function escapeAndFormat(text) {
  // First escape HTML
  let html = esc(text);

  // Bold: **text** → <strong>
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Code: `text` → <code>
  html = html.replace(/`(.+?)`/g, "<code>$1</code>");

  // URLs → clickable links
  html = html.replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" style="color:#a78bfa;">$1</a>'
  );

  // Line breaks
  html = html.replace(/\n/g, "<br>");

  // Bullet lists: lines starting with - or *
  html = html.replace(/(?:^|<br>)[\s]*[-*]\s+(.+?)(?=<br>|$)/g, (match, content) => {
    return `<br><span style="color:#6a6a88;margin-right:6px;">•</span>${content}`;
  });

  return html;
}

function esc(s) {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
