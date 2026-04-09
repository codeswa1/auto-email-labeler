console.log("Auto Email Labeler Thin Client active");

const DEFAULT_SETTINGS = {
  autoApply: true, autoLearn: true, senderBoost: true,
  debug: false, buttonPos: { top: 120, left: window.innerWidth - 140 },
  gmailApiEnabled: false, badgeVisibility: {}
};

let settings = { ...DEFAULT_SETTINGS };
let panelEl = null, panelVisible = false, debugLog = [];
let rowObserver = null;
const labelColors = {};

// ==============================
// CONTEXT ROBUSTNESS
// ==============================
function isContextValid() {
  return typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id;
}

function safeSendMessage(message, callback) {
  if (!isContextValid()) {
    console.warn("Auto Email Labeler: Extension context lost. Please refresh the page.");
    if (rowObserver) { rowObserver.disconnect(); rowObserver = null; }
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
  initFloatingButton();
  startOptimizedObserver();
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

  new MutationObserver((mutations) => {
    reObserve();
    // If attributes changed, a row might have been updated (read/selected)
    // and Gmail may have wiped our badge.
    mutations.forEach(m => {
      if (m.type === "attributes" && m.target?.classList?.contains("zA")) {
        processSingleRow(m.target);
      }
    });
  }).observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });

  // Listen for clicks on rows to catch instant Gmail state changes
  document.addEventListener("click", (e) => {
    const row = e.target.closest("tr.zA");
    if (row) {
      // Small delay to let Gmail's own click handlers finish their DOM swaps
      setTimeout(() => processSingleRow(row), 50);
    }
  }, true);

  setInterval(reObserve, 3000);
  reObserve();
}

function processSingleRow(row) {
    if (row.querySelector(".auto-email-label-badge-container")) return; 
    if (row.dataset.autoLabeled === "processing") return; 
    
    const subjectSpan = row.querySelector(".y6 span");
    const senderContainer = row.querySelector(".yX.xY");
    const senderSpan = senderContainer?.querySelector("span");
    
    if (!subjectSpan || !senderContainer || !senderSpan) return;
    row.dataset.autoLabeled = "processing"; 

    const sender = senderSpan.innerText;
    const subject = subjectSpan.innerText;
    const fullText = row.querySelector(".y6")?.innerText || "";
    const snippet = fullText.startsWith(subject) ? fullText.slice(subject.length).replace(/^-?\s*/, "") : "";
    
    // Robust ID extraction for Gmail
    const checkbox = row.querySelector('div[role="checkbox"]');
    const messageId = checkbox?.getAttribute("data-id") || 
                      row.getAttribute("data-thread-id") || 
                      row.getAttribute("data-legacy-last-message-id") ||
                      row.getAttribute("data-legacy-thread-id") || 
                      row.getAttribute("data-legacy-message-id");
    
    const isUnread = row.classList.contains("zE");
    const dateCell = row.querySelector(".xW");
    let sentDate = "";
    if (dateCell) {
      const span = dateCell.querySelector("span");
      sentDate = span?.getAttribute("title") || span?.getAttribute("aria-label") || dateCell.innerText || "";
    }

    if (!isContextValid()) return;

    safeSendMessage({ type: "PREDICT", sender, subject, snippet, messageId, isUnread, sentDate }, (prediction) => {
      delete row.dataset.autoLabeled;
      
      const container = createBadge(prediction || { label: "AUTO", confidence: 0, isGraduated: false }, row);
      if (container && !row.querySelector(".auto-email-label-badge-container")) {
        senderContainer.parentElement.insertBefore(container, senderContainer);
        debugLog.push(`${sender} | ${subject} -> ${prediction?.label || "AUTO"}`);
        if(debugLog.length > 20) debugLog.shift();
      }
    });
}

// ==============================
// FLOATING BUTTON & PANEL
// ==============================
function initFloatingButton() {
  if (!document.body) return setTimeout(initFloatingButton, 100);
  if (document.getElementById("autoLabelerBtn")) return;

  const btn = document.createElement("div");
  btn.id = "autoLabelerBtn";
  btn.textContent = "Auto Labeler";
  btn.style.cssText = `position:fixed;top:${settings.buttonPos?.top || 120}px;left:${settings.buttonPos?.left || window.innerWidth - 140}px;
    background:#1a73e8;color:#fff;padding:6px 10px;border-radius:16px;font-size:12px;font-weight:600;
    cursor:grab;z-index:9999;user-select:none;transition:transform 0.15s,box-shadow 0.15s;`;
  
  btn.onmouseenter = () => { btn.style.boxShadow = "0 2px 6px rgba(0,0,0,0.3)"; btn.style.transform = "scale(1.05)"; };
  btn.onmouseleave = () => { btn.style.boxShadow = "none"; btn.style.transform = "scale(1)"; };
  btn.onmousedown = e => {
    let offsetX = e.clientX - btn.offsetLeft, offsetY = e.clientY - btn.offsetTop;
    let dragged = false;
    const move = mev => { dragged = true; btn.style.left = `${mev.clientX - offsetX}px`; btn.style.top = `${mev.clientY - offsetY}px`; };
    const up = () => {
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      if (!dragged) togglePanel();
      else { 
        settings.buttonPos = { top: btn.offsetTop, left: btn.offsetLeft }; 
        saveSettings(settings);
      }
    };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  };
  document.body.appendChild(btn);
}

function togglePanel() { panelVisible ? closePanel() : openPanel(); }

function openPanel() {
  panelEl = document.createElement("div");
  panelEl.style.cssText = `position:fixed;top:${(settings.buttonPos?.top || 120)+40}px;left:${settings.buttonPos?.left || window.innerWidth - 140}px;
    background:#fff;border:1px solid #ccc;padding:12px;width:320px;font-size:12px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.2);border-radius:8px;font-family:sans-serif;`;
  
  const success = safeSendMessage({ type: "GET_STATS" }, stats => {
    panelEl.innerHTML = `
      <b style="font-size:14px;">Auto Email Labeler (Thin Client)</b><hr style="margin:8px 0;"/>
      <label style="display:block;margin-bottom:4px"><input type="checkbox" id="autoApply"> Auto Apply Labels natively in Gmail</label>
      <label style="display:block;margin-bottom:4px"><input type="checkbox" id="senderBoost"> Sender Memory Boost</label>
      <label style="display:block;margin-bottom:4px"><input type="checkbox" id="gmailApi"> Background Sync API</label>
      <hr style="margin:8px 0;"/>
      <b>Server Stats:</b><br/>
      Samples Learned: ${stats?.samples || 0}<br/>
      Total Labels: ${stats?.labels || "None"}<br/>
      Offline Queue: ${stats?.queue || 0} items<hr style="margin:8px 0;"/>
      <button id="vizBtn" style="padding:4px 8px;background:#1a73e8;color:#fff;border:1px solid #1a73e8;border-radius:4px;cursor:pointer;margin-right:8px;">📊 Dashboard</button>
      <button id="closeBtn" style="padding:4px 8px;background:#eee;border:1px solid #ccc;border-radius:4px;cursor:pointer;">Close</button>
      <pre style="max-height:100px;overflow:auto;background:#f8f8f8;padding:4px;margin-top:8px;font-size:10px;">${debugLog.join('\n')}</pre>
    `;
    
    document.body.appendChild(panelEl);

    ["autoApply", "senderBoost", "gmailApi"].forEach(key => {
      const el = panelEl.querySelector(`#${key}`);
      const mapKey = key === "gmailApi" ? "gmailApiEnabled" : key;
      el.checked = settings[mapKey];
      el.onchange = () => { 
        settings[mapKey] = el.checked; 
        saveSettings(settings);
        if (key === "gmailApi" && el.checked) {
          safeSendMessage({ type: "FETCH_GMAIL" });
        }
      };
    });
    
    const vizBtn = panelEl.querySelector("#vizBtn");
    if (vizBtn) {
      vizBtn.onclick = () => {
        if (!isContextValid()) {
          alert("Extension context lost due to a reload or update. Please refresh the Gmail page.");
          closePanel();
          const mainBtn = document.getElementById("autoLabelerBtn");
          if (mainBtn) mainBtn.style.opacity = "0.5"; 
          return;
        }
        window.open(chrome.runtime.getURL("visualization.html"), "_blank");
      };
    }

    const closeBtn = panelEl.querySelector("#closeBtn");
    if (closeBtn) closeBtn.onclick = closePanel;
  });

  if (!success) {
    console.warn("Auto Email Labeler: Connection lost during panel init.");
    alert("Extension connection lost. Please refresh the Gmail tab.");
    closePanel();
  }
}

function closePanel() { panelEl?.remove(); panelEl = null; panelVisible = false; }
