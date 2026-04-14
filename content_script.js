console.log("Auto Email Labeler Thin Client active");

const DEFAULT_SETTINGS = {
  autoApply: true, autoLearn: true, senderBoost: true,
  debug: false, buttonPos: { top: 120, left: window.innerWidth - 140 },
  badgeVisibility: {}
};

let settings = { ...DEFAULT_SETTINGS };
let panelEl = null, panelVisible = false, debugLog = [];
let rowObserver = null;
let sessionScannedHistory = new Set(); // TRACKS EMAILS SYNCED IN THIS SESSION
let sessionSeenHistory = new Set();    // TRACKS TOTAL EMAILS ENCOUNTERED IN THE LISTS
const labelColors = {};
let heartbeatInterval = null;

// ==============================
// CONTEXT ROBUSTNESS
// ==============================
function isContextValid() {
  return typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id;
}

function safeSendMessage(message, callback) {
  if (!isContextValid()) {
    // Graceful Silence: Clean up all resources and stop the heartbeat
    if (rowObserver) { rowObserver.disconnect(); rowObserver = null; }
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    return false;
  }
  try {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) {
        // Specifically don't console.error if it's a context invalidated error to keep console clean
        if (!chrome.runtime.lastError.message.includes("context invalidated")) {
          console.error("SendMessage error:", chrome.runtime.lastError.message);
        }
      }
      if (callback) callback(response);
    });
    return true;
  } catch (e) {
    if (e.message.includes("context invalidated")) {
      console.warn("Auto Email Labeler: Context lost, stopping activity.");
      if (rowObserver) { rowObserver.disconnect(); rowObserver = null; }
    } else {
      console.error("SafeSendMessage exception:", e);
    }
    return false;
  }
}

// ==============================
// INIT & SETTINGS
// ==============================
chrome.storage.sync.get({ settings: DEFAULT_SETTINGS }, sync => {
  settings = { ...DEFAULT_SETTINGS, ...sync.settings };
  // Force mandatory features to true
  settings.autoApply = true;
  settings.senderBoost = true;

  initFloatingButton();
  startOptimizedObserver();

  // Keep-Alive Heartbeat: Prevents service worker suspension while active in Gmail
  heartbeatInterval = setInterval(() => {
    safeSendMessage({ type: "HEARTBEAT" });
  }, 60000);
});


chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.settings) {
    settings = { ...settings, ...changes.settings.newValue };
  }
});

function saveSettings(newSettings) {
  safeSendMessage({ type: "SAVE_SETTINGS", settings: newSettings });
}

// ==============================
// UI & BADGE INJECTION
// ==============================
function getOrCreateLabelColor(label) {
  if (labelColors[label]) return labelColors[label];
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = label.charCodeAt(i) + ((hash << 5) - hash);
  const color = "#" + "00000".substring(0, 6 - ((hash & 0x00FFFFFF).toString(16)).length) + (hash & 0x00FFFFFF).toString(16).toUpperCase();
  labelColors[label] = color;
  return color;
}

function createBadge(prediction, rowElement) {
  if (settings.badgeVisibility[prediction.label] === false) return null;

  const container = document.createElement("span");
  container.className = "auto-email-label-badge-container";
  container.style.cssText = "display: inline-flex; align-items: center; margin-left: 2px; margin-right: 6px; flex-shrink: 0; z-index: 99;";

  const badge = document.createElement("span");
  badge.className = "auto-email-label-badge";
  badge.textContent = prediction.label !== "AUTO" ? prediction.label : "Predicting...";
  badge.title = `Confidence: ${(prediction.confidence * 100).toFixed(0)}%`;

  Object.assign(badge.style, {
    padding: "2px 8px",
    borderRadius: "12px", fontSize: "12px", fontWeight: "bold", color: "#fff",
    background: prediction.label !== "AUTO" ? getOrCreateLabelColor(prediction.label) : "#aaaaaa",
    cursor: "pointer", maxWidth: "120px", overflow: "hidden", textOverflow: "ellipsis",
    whiteSpace: "nowrap"
  });

  badge.onclick = e => {
    e.stopPropagation();
    showLabelOverrideDropdown(badge, rowElement);
  };

  container.appendChild(badge);

  // If still in Training Phase and not perfectly graduated, show interactive buttons
  if (!prediction.isGraduated) {
    const tick = document.createElement("span");
    tick.innerHTML = "✅";
    tick.title = "Approve label";
    tick.style.cssText = "cursor:pointer; margin-left:4px; font-size:12px; opacity:0.7; transition:opacity 0.2s;";
    tick.onmouseenter = () => tick.style.opacity = "1";
    tick.onmouseleave = () => tick.style.opacity = "0.7";
    tick.onclick = e => {
      e.stopPropagation();
      applyManualLabel(rowElement, badge.textContent, badge);
      container.innerHTML = "";
      container.appendChild(badge);
    };

    const cross = document.createElement("span");
    cross.innerHTML = "❌";
    cross.title = "Reject label";
    cross.style.cssText = "cursor:pointer; margin-left:2px; font-size:12px; opacity:0.7; transition:opacity 0.2s;";
    cross.onmouseenter = () => cross.style.opacity = "1";
    cross.onmouseleave = () => cross.style.opacity = "0.7";
    cross.onclick = e => {
      e.stopPropagation();
      showLabelOverrideDropdown(badge, rowElement);
    };

    // Only show tick if we have a real prediction to approve
    if (prediction.label !== "AUTO") container.appendChild(tick);
    container.appendChild(cross);
  }

  return container;
}

function showLabelOverrideDropdown(badge, rowElement) {
  document.querySelectorAll(".auto-label-dropdown")?.forEach(d => d.remove());
  const dropdown = document.createElement("div");
  dropdown.className = "auto-label-dropdown";
  dropdown.style.cssText = `position:absolute; background:#fff; border:1px solid #ccc; padding:4px; z-index:10000; font-size:12px; border-radius:4px; box-shadow:0 2px 5px rgba(0,0,0,0.2)`;

  // Stop clicks from bubbling to Gmail (which steals focus or tears down views)
  dropdown.onclick = e => e.stopPropagation();
  dropdown.onmousedown = e => e.stopPropagation();

  // Ask background for current labels
  safeSendMessage({ type: "GET_STATS" }, response => {
    if (!response) { dropdown.remove(); return; }
    const header = document.createElement("div");
    header.style.cssText = "display:flex; justify-content:space-between; align-items:center; padding:2px 4px 6px 4px; border-bottom:1px solid #eee; margin-bottom:4px;";

    const title = document.createElement("b");
    title.textContent = "Override Label";
    title.style.color = "#555";

    const closeBtn = document.createElement("span");
    closeBtn.textContent = "✕";
    closeBtn.style.cssText = "cursor:pointer; color:#999; font-weight:bold; font-size:14px; line-height:1; padding:0 4px;";
    closeBtn.title = "Cancel";
    closeBtn.onmouseenter = () => closeBtn.style.color = "#d32f2f";
    closeBtn.onmouseleave = () => closeBtn.style.color = "#999";
    closeBtn.onclick = (e) => { e.stopPropagation(); dropdown.remove(); };

    header.appendChild(title);
    header.appendChild(closeBtn);
    dropdown.appendChild(header);

    const labels = (response.labels || "").split(', ').filter(Boolean);
    const optionsContainer = document.createElement("div");
    optionsContainer.style.maxHeight = "150px";
    optionsContainer.style.overflowY = "auto";

    labels.forEach(label => {
      const option = document.createElement("div");
      option.textContent = label;
      option.style.padding = "4px 8px"; option.style.cursor = "pointer";
      option.onmouseenter = () => option.style.background = "#eee";
      option.onmouseleave = () => option.style.background = "#fff";
      option.onclick = (e) => { e.stopPropagation(); applyManualLabel(rowElement, label, badge); dropdown.remove(); };
      optionsContainer.appendChild(option);
    });
    dropdown.appendChild(optionsContainer);

    const input = document.createElement("input");
    input.placeholder = "New label... + Enter";
    input.style.width = "100%"; input.style.marginTop = "4px"; input.style.boxSizing = "border-box";

    // Stop keyboard events from bubbling to Gmail (which triggers shortcuts and closes UI)
    input.onkeydown = e => {
      e.stopPropagation();
      if (e.key === "Enter" && input.value.trim()) {
        applyManualLabel(rowElement, input.value.trim(), badge); dropdown.remove();
      }
    };
    input.onkeyup = e => e.stopPropagation();
    input.onkeypress = e => e.stopPropagation();

    dropdown.appendChild(input);

    const rect = badge.getBoundingClientRect();
    dropdown.style.visibility = "hidden"; // Hide briefly while positioning
    document.body.appendChild(dropdown);

    const dropRect = dropdown.getBoundingClientRect();

    if (rect.bottom + dropRect.height + 20 > window.innerHeight) {
      // It would overflow the bottom. Move it to the side and shift it up.
      dropdown.style.top = `${Math.max(window.scrollY + 10, rect.bottom + window.scrollY - dropRect.height)}px`;
      if (rect.right + dropRect.width + 20 > window.innerWidth) {
        dropdown.style.left = `${rect.left + window.scrollX - dropRect.width - 10}px`; // Left side
      } else {
        dropdown.style.left = `${rect.right + window.scrollX + 10}px`; // Right side
      }
    } else {
      // Normal placement below
      dropdown.style.top = `${rect.bottom + window.scrollY + 4}px`;
      dropdown.style.left = `${rect.left + window.scrollX}px`;
    }

    dropdown.style.visibility = "visible";
    input.focus();

    // Close dropdown when clicking outside
    setTimeout(() => {
      const closeHandler = () => {
        dropdown.remove();
        document.removeEventListener("click", closeHandler);
      };
      document.addEventListener("click", closeHandler);
    }, 100);
  });
}

function applyManualLabel(row, newLabel, badge) {
  const senderContainer = row.querySelector(".yX.xY span");
  const subjectSpan = row.querySelector(".y6 span");
  if (!senderContainer || !subjectSpan) return;

  const sender = senderContainer.innerText;
  const subject = subjectSpan.innerText;
  const fullText = row.querySelector(".y6")?.innerText || "";
  const snippet = fullText.startsWith(subject) ? fullText.slice(subject.length).replace(/^-?\s*/, "") : "";

  const dateCell = row.querySelector(".xW");
  // PRIORITIZE Title (Full Date) -> ARIA (Medium Date) -> Text (Summary Date)
  let sentDate = "";
  if (dateCell) {
    const span = dateCell.querySelector("span");
    sentDate = span?.getAttribute("title") || span?.getAttribute("aria-label") || dateCell.innerText || "";
  }

  const checkbox = row.querySelector('div[role="checkbox"]');
  const messageId = checkbox?.getAttribute("data-id") ||
    row.getAttribute("data-thread-id") ||
    row.getAttribute("data-legacy-last-message-id") ||
    row.getAttribute("data-legacy-thread-id") ||
    row.getAttribute("data-legacy-message-id");
  const isUnread = row.classList.contains("zE");

  badge.textContent = newLabel;
  badge.style.background = getOrCreateLabelColor(newLabel);

  if (badge.parentElement && badge.parentElement.className === "auto-email-label-badge-container") {
    Array.from(badge.parentElement.children).forEach(c => {
      if (c !== badge) c.remove(); // Clean up Tick/Cross UI visually
    });
  }

  safeSendMessage({ type: "APPLY_LABEL", sender, subject, snippet, newLabel, messageId, isUnread, sentDate }, () => {
    // Wipe all OTHER rows' badges for the exact same sender, forcing an instant re-prediction!
    const rows = document.querySelectorAll("tr.zA");
    rows.forEach(r => {
      if (r === row) return;
      const sContainer = r.querySelector(".yX.xY span");
      if (sContainer && sContainer.innerText === sender) {
        const b = r.querySelector(".auto-email-label-badge-container");
        if (b) {
          b.remove(); // remove old badge
          delete r.dataset.autoLabeled; // remove processing lock
          processSingleRow(r); // Instant re-predict
        }
      }
    });
  });
}

// ==============================
// OPTIMIZED OBSERVER & PROCESSING
// ==============================
function startOptimizedObserver() {
  rowObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        processSingleRow(entry.target);
      }
    });
  }, { rootMargin: "200px" });

  const target = document.querySelector('table.F.cf.zt') || document.body;

  const reObserve = () => {
    document.querySelectorAll("tr.zA:not([data-observed])").forEach(row => {
      row.dataset.observed = "true";
      rowObserver.observe(row);
    });
  };

  // Attach to body but watch subtree for Gmail row changes
  const mainObserver = new MutationObserver((mutations) => {
    let rowChanged = false;
    mutations.forEach(m => {
      if (m.addedNodes.length) rowChanged = true;
      if (m.type === "attributes" && m.target?.classList?.contains("zA")) {
        processSingleRow(m.target);
      }
    });
    if (rowChanged) reObserve();
  });
  
  mainObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });

  // Listen for clicks on rows to catch instant Gmail state changes
  document.addEventListener("click", (e) => {
    const row = e.target.closest("tr.zA");
    if (row) {
      // Small delay to let Gmail's own click handlers finish their DOM swaps
      setTimeout(() => processSingleRow(row), 50);
    }
  }, true);

  setInterval(() => {
    reObserve();
    updateProgressCounter();
  }, 2000);

  // Gmail Navigation Watcher: Re-scan whenever the view changes (Next/Back/Filter)
  window.addEventListener('hashchange', () => {
    console.log("Navigation detected, re-initializing scanner...");
    document.querySelectorAll("tr.zA").forEach(row => delete row.dataset.observed);
    reObserve();
  });

  reObserve();
}

function updateProgressCounter() {
  const btn = document.getElementById("autoLabelerBtn");
  if (!btn) return;

  if (!isContextValid()) {
    btn.innerHTML = `<span style="opacity:1;"> Refresh Page</span>`;
    btn.style.background = "linear-gradient(135deg, #d93025 0%, #a50e0e 100%)";
    return;
  }

  const rows = document.querySelectorAll("tr.zA");
  const currentlyScannedOnPage = document.querySelectorAll("tr.zA .auto-email-label-badge-container").length;

  // The Total Session Count = Scanned so far in session + all others encountered
  // We populate sessionSeenHistory every time we observe a row
  rows.forEach(row => {
     const rowInfo = extractRowInfo(row);
     if (rowInfo) {
       const id = generateEmailId(rowInfo);
       sessionSeenHistory.add(id);
     }
  });

  const displayTotal = Math.max(sessionScannedHistory.size, sessionSeenHistory.size);

  if (displayTotal > 0) {
    btn.innerHTML = `<span>✨</span> ${sessionScannedHistory.size}/${displayTotal} Scanned`;
  } else {
    btn.innerHTML = `<span>✨</span> Auto Labeler`;
  }
}



function extractRowInfo(row) {
  const subjectSpan = row.querySelector(".y6 span") || row.querySelector(".y6");
  const senderContainer = row.querySelector(".yX.xY");
  const senderSpan = senderContainer?.querySelector("span") || senderContainer;

  if (!subjectSpan || !senderContainer) return null;

  const sender = senderSpan.innerText || senderContainer.innerText || "";
  const subject = subjectSpan.innerText || subjectSpan.textContent || "";
  const fullText = row.querySelector(".y6")?.innerText || "";
  const snippet = fullText.startsWith(subject) ? fullText.slice(subject.length).replace(/^-?\s*/, "") : fullText;
  const cleanSubject = subject.split("\n")[0].split(" - ")[0].trim();

  const checkbox = row.querySelector('div[role="checkbox"]');
  const messageId = checkbox?.getAttribute("data-id") || row.getAttribute("data-thread-id");

  const isUnread = row.classList.contains("zE");
  const dateCell = row.querySelector(".xW");
  let sentDate = "";
  if (dateCell) {
    const span = dateCell.querySelector("span");
    sentDate = span?.getAttribute("title") || span?.getAttribute("aria-label") || dateCell.innerText || "";
  }
  
  const threadSize = row.querySelector(".bp3")?.innerText || "";

  return { sender, subject, cleanSubject, snippet, messageId, isUnread, sentDate, threadSize };
}

function generateEmailId(info) {
  // ULTIMATE IDENTITY FIX: We no longer prefer Gmail's internal IDs (which are often Thread IDs).
  // Instead, we use the high-resolution metadata as the primary key for the database.
  const snippetPart = (info.snippet || "").substring(0, 300); // 300 chars for extreme uniqueness
  const entropySource = info.sender + info.subject + snippetPart + info.sentDate + info.threadSize;
  return btoa(unescape(encodeURIComponent(entropySource))).substring(0, 64);
}

function processSingleRow(row) {
  if (row.dataset.autoLabeled === "processing") {
    // Self-Healing
    const startTimeCount = parseInt(row.dataset.autoLabelStart || "0");
    if (Date.now() - startTimeCount > 10000) {
       delete row.dataset.autoLabeled;
    } else {
       return;
    }
  }

  const rowInfo = extractRowInfo(row);
  if (!rowInfo) return;

  row.dataset.autoLabeled = "processing";
  row.dataset.autoLabelStart = Date.now().toString();

  if (!isContextValid()) return;

  const finalId = generateEmailId(rowInfo);
  sessionSeenHistory.add(finalId); // Ensure seen history is always updated

  return new Promise(resolve => {
    safeSendMessage({ 
       type: "PREDICT", 
       sender: rowInfo.sender, 
       subject: rowInfo.cleanSubject, 
       snippet: rowInfo.snippet, 
       messageId: finalId, 
       isUnread: rowInfo.isUnread, 
       sentDate: rowInfo.sentDate, 
       source: "auto-scroll" 
    }, (prediction) => {

      // RE-QUERY IN CALLBACK: Gmail may have swapped out the row internal DOM (e.g., on unread toggle)
      const currentSenderContainer = row.querySelector(".yX.xY");
      if (!currentSenderContainer) {
        delete row.dataset.autoLabeled;
        return resolve();
      }

      const container = createBadge(prediction || { label: "AUTO", confidence: 0, isGraduated: false }, row);

      // Ensure no duplicated badges and inject into the RE-QUERIED live container
      if (container && !row.querySelector(".auto-email-label-badge-container")) {
        currentSenderContainer.parentElement.insertBefore(container, currentSenderContainer);
        sessionScannedHistory.add(finalId);
      } else if (row.querySelector(".auto-email-label-badge-container")) {
        sessionScannedHistory.add(finalId);
      }

      delete row.dataset.autoLabeled;
      resolve();
    });

  });
}




// ==============================
// FLOATING BUTTON & PANEL
// ==============================
function initFloatingButton() {
  if (!document.body) return setTimeout(initFloatingButton, 100);
  if (document.getElementById("autoLabelerBtn")) return;

  // Inject shared styles for the premium UI
  const style = document.createElement("style");
  style.textContent = `
    #autoLabelerBtn {
      position: fixed;
      z-index: 9999;
      user-select: none;
      transition: transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275), box-shadow 0.2s;
      background: linear-gradient(135deg, #1a73e8 0%, #0d47a1 100%);
      color: #fff;
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 600;
      cursor: grab;
      display: flex;
      align-items: center;
      gap: 6px;
      box-shadow: 0 4px 15px rgba(26, 115, 232, 0.4);
      border: 1px solid rgba(255,255,255,0.1);
    }
    #autoLabelerBtn:hover {
      transform: scale(1.05) translateY(-2px);
      box-shadow: 0 6px 20px rgba(26, 115, 232, 0.6);
    }
    #autoLabelerBtn:active { cursor: grabbing; transform: scale(0.98); }
    
    .ael-panel {
      position: fixed;
      z-index: 9998;
      width: 340px;
      background: rgba(255, 255, 255, 0.75);
      backdrop-filter: blur(16px) saturate(180%);
      -webkit-backdrop-filter: blur(16px) saturate(180%);
      border: 1px solid rgba(209, 213, 219, 0.3);
      border-radius: 16px;
      padding: 20px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.1);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      animation: ael-fade-in 0.3s ease-out;
      color: #1f2937;
    }
    
    @keyframes ael-fade-in {
      from { opacity: 0; transform: translateY(10px) scale(0.95); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    
    .ael-header {
      font-size: 16px;
      font-weight: 700;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: #111827;
    }
    
    .ael-section { margin-bottom: 16px; }
    .ael-section-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #6b7280;
      font-weight: 600;
      margin-bottom: 10px;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    
    .ael-toggle-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
      cursor: pointer;
      user-select: none;
    }
    
    .ael-toggle-label { font-size: 13px; font-weight: 500; }
    
    /* Toggle Switch Styles */
    .ael-switch {
      position: relative;
      display: inline-block;
      width: 36px;
      height: 20px;
    }
    .ael-switch input { opacity: 0; width: 0; height: 0; }
    .ael-slider {
      position: absolute;
      cursor: pointer;
      top: 0; left: 0; right: 0; bottom: 0;
      background-color: #d1d5db;
      transition: .3s;
      border-radius: 20px;
    }
    .ael-slider:before {
      position: absolute;
      content: "";
      height: 14px; width: 14px;
      left: 3px; bottom: 3px;
      background-color: white;
      transition: .3s;
      border-radius: 50%;
    }
    input:checked + .ael-slider { background-color: #1a73e8; }
    input:checked + .ael-slider:before { transform: translateX(16px); }
    
    .ael-stat-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .ael-stat-card {
      background: rgba(255,255,255,0.4);
      padding: 10px;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.5);
    }
    .ael-stat-val { font-size: 15px; font-weight: 700; color: #1a73e8; }
    .ael-stat-lab { font-size: 10px; color: #6b7280; font-weight: 600; }
    
    .ael-footer {
      display: flex;
      gap: 10px;
      margin-top: 20px;
    }
    .ael-btn {
      flex: 1;
      padding: 10px;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
      text-align: center;
    }
    .ael-btn-primary { background: #1a73e8; color: #fff; box-shadow: 0 4px 10px rgba(26,115,232,0.3); }
    .ael-btn-primary:hover { background: #1565c0; box-shadow: 0 6px 15px rgba(26,115,232,0.4); }
    .ael-btn-secondary { background: rgba(0,0,0,0.05); color: #4b5563; }
    .ael-btn-secondary:hover { background: rgba(0,0,0,0.1); }
    
    .ael-debug {
      margin-top: 15px;
      max-height: 80px;
      overflow: auto;
      background: rgba(0,0,0,0.03);
      border-radius: 8px;
      padding: 8px;
      font-family: monospace;
      font-size: 10px;
      color: #6b7280;
      white-space: pre-wrap;
    }
  `;
  document.head.appendChild(style);

  const btn = document.createElement("div");
  btn.id = "autoLabelerBtn";
  btn.innerHTML = `<span>✨</span> Auto Labeler`;
  btn.style.top = `${settings.buttonPos?.top || 120}px`;
  btn.style.left = `${settings.buttonPos?.left || window.innerWidth - 180}px`;

  btn.onmousedown = e => {
    let offsetX = e.clientX - btn.offsetLeft, offsetY = e.clientY - btn.offsetTop;
    let dragged = false;

    const move = mev => {
      dragged = true;
      const newLeft = mev.clientX - offsetX;
      const newTop = mev.clientY - offsetY;

      btn.style.left = `${newLeft}px`;
      btn.style.top = `${newTop}px`;

      // Update panel position if visible
      if (panelEl) {
        panelEl.style.left = `${newLeft}px`;
        panelEl.style.top = `${newTop + btn.offsetHeight + 10}px`;
      }
    };

    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      if (!dragged) togglePanel();
      else {
        settings.buttonPos = { top: btn.offsetTop, left: btn.offsetLeft };
        saveSettings(settings);
      }
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };
  document.body.appendChild(btn);
}


function togglePanel() {
  if (panelVisible) {
    closePanel();
  } else {
    openPanel();
  }
}

async function harvestEntirePage() {
  const rows = Array.from(document.querySelectorAll("tr.zA"));
  const status = document.getElementById("aelStatus");
  let count = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.querySelector(".auto-email-label-badge-container") && row.dataset.autoLabeled !== "processing") {
      if (status) status.textContent = `Scraping: ${count + 1} / ${rows.length}...`;
      await processSingleRow(row);
      count++;
    }
  }
  return count;
}


function openPanel() {
  if (panelEl) panelEl.remove();

  const btn = document.getElementById("autoLabelerBtn");
  const top = btn ? btn.offsetTop + btn.offsetHeight + 10 : (settings.buttonPos?.top || 120) + 40;
  const left = btn ? btn.offsetLeft : (settings.buttonPos?.left || window.innerWidth - 180);

  panelEl = document.createElement("div");
  panelEl.className = "ael-panel";
  panelEl.style.top = `${top}px`;
  panelEl.style.left = `${left}px`;

  // Show immediate loading state
  panelEl.innerHTML = `<div style="padding:20px; text-align:center; color:white; font-size:12px;">Loading Intelligence...</div>`;
  document.body.appendChild(panelEl);

  safeSendMessage({ type: "GET_STATS" }, stats => {
    panelVisible = true;
    panelEl.innerHTML = `
      <div class="ael-header">
        <span>HushInMosiac</span>
        <span style="font-size:10px; opacity:0.5; font-weight:normal">v1.2.0</span>
      </div>
      
      <div class="ael-section">
        <div class="ael-section-title">📊 Intelligence Stats</div>
        <div class="ael-stat-grid">
          <div class="ael-stat-card">
            <div class="ael-stat-val">${stats?.samples || 0}</div>
            <div class="ael-stat-lab">ANALYZED EMAILS</div>
          </div>
          <div class="ael-stat-card">
            <div class="ael-stat-val">${stats?.labels ? stats.labels.split(',').length : 0}</div>
            <div class="ael-stat-lab">LABELS</div>
          </div>
          <div class="ael-stat-card">
            <div class="ael-stat-val">${stats?.queue || 0}</div>
            <div class="ael-stat-lab">QUEUE</div>
          </div>
          <div class="ael-stat-card">
            <div class="ael-stat-val">${stats?.samples > 0 ? 'Active' : 'Idle'}</div>
            <div class="ael-stat-lab">STATUS</div>
          </div>
        </div>
      </div>

      <div class="ael-footer" style="flex-wrap: wrap;">
        <button id="vizBtn" class="ael-btn ael-btn-primary" style="flex: 1 1 100%;">Open Analytics Dashboard</button>
        <button id="closeBtn" class="ael-btn ael-btn-secondary" style="flex: 1 1 100%;">Dismiss Panel</button>
      </div>

      
      <div id="aelStatus" style="font-size: 11px; text-align: center; margin-top: 10px; color: #1a73e8; font-weight: 500;">${stats?.status || 'Ready'}</div>
      
      <div class="ael-diagnostic-row" style="margin-top:15px; padding-top:12px; border-top:1px solid rgba(255,255,255,0.1); display:flex; gap:8px;">

        <button id="debugBtn" style="flex:1; padding:7px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.15); border-radius:6px; color:white; font-size:10px; cursor:pointer; font-weight:500;">Check Health</button>
        <button id="resetBtn" style="flex:1; padding:7px; background:rgba(255,80,80,0.12); border:1px solid rgba(255,100,100,0.15); border-radius:6px; color:#ff9999; font-size:10px; cursor:pointer; font-weight:500;">Reset Engine</button>
      </div>
    `;

    // Interaction Mapping (Strictly inside the stats callback)
    const debugBtn = panelEl.querySelector("#debugBtn");
    const resetBtn = panelEl.querySelector("#resetBtn");
    const crawlBtn = panelEl.querySelector("#crawlBtn");
    const vizBtn = panelEl.querySelector("#vizBtn");
    const closeBtn = panelEl.querySelector("#closeBtn");

    if (debugBtn) debugBtn.onclick = () => {
      safeSendMessage({ type: "GET_RAW_DATA" }, (res) => {
        alert(`Storage Health:\nItems in Database: ${res.memoryCount}\nStorage State: ${res.idbStatus}\nLast Committed: ${res.lastSave}`);
      });
    };

    if (resetBtn) resetBtn.onclick = () => {
      if (confirm("Are you sure? This will wipe your local intelligence database and start fresh.")) {
        safeSendMessage({ type: "RESET_ENGINE" }, () => location.reload());
      }
    };

    if (crawlBtn) crawlBtn.onclick = async (e) => {
      const btn = e.target;
      const statusDisp = document.getElementById("aelStatus");
      btn.disabled = true;
      btn.textContent = "Processing...";

      const count = await harvestEntirePage();
      if (statusDisp) {
        statusDisp.textContent = `Scrape Complete: +${count} emails saved.`;
        statusDisp.style.color = "#34a853";
      }

      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = "Crawl This Page";
        openPanel(); // Refresh to show new stats
      }, 3000);
    };

    if (vizBtn) vizBtn.onclick = () => {
      if (!isContextValid()) return alert("Context lost. Refresh Gmail.");
      safeSendMessage({ type: "OPEN_DASHBOARD" });
    };

    if (closeBtn) closeBtn.onclick = closePanel;


  });
}

function closePanel() {
  if (panelEl) {
    panelEl.style.animation = "ael-fade-in 0.2s ease-in reverse forwards";
    setTimeout(() => {
      panelEl?.remove();
      panelEl = null;
      panelVisible = false;
    }, 200);
  } else {
    panelVisible = false;
  }
}
