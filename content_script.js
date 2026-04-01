console.log("Auto Email Labeler Thin Client active");

const DEFAULT_SETTINGS = {
  autoApply: true, autoLearn: true, senderBoost: true,
  debug: false, buttonPos: { top: 120, left: window.innerWidth - 140 },
  gmailApiEnabled: false, badgeVisibility: {},
  ollamaEnabled: false, ollamaUrl: "http://localhost:11434", ollamaModel: "llama3.2"
};

let settings = { ...DEFAULT_SETTINGS };
let panelEl = null, panelVisible = false, debugLog = [];
let pendingRowProcessing = false;
const labelColors = {};

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
  chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings: newSettings });
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
  const badge = document.createElement("span");
  badge.className = "auto-email-label-badge";
  badge.textContent = prediction.label;
  badge.title = `Confidence: ${(prediction.confidence * 100).toFixed(0)}%`;
  
  Object.assign(badge.style, {
    marginLeft: "2px", marginRight: "6px", padding: "2px 8px",
    borderRadius: "12px", fontSize: "12px", fontWeight: "bold", color: "#fff",
    background: getOrCreateLabelColor(prediction.label), cursor: "pointer",
    maxWidth: "120px", overflow: "hidden", textOverflow: "ellipsis",
    whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", flexShrink: "0"
  });

  badge.onclick = e => { 
    e.stopPropagation(); 
    showLabelOverrideDropdown(badge, rowElement); 
  };
  return badge;
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
  chrome.runtime.sendMessage({ type: "GET_STATS" }, response => {
    const labels = (response.labels || "").split(', ').filter(Boolean);
    labels.forEach(label => {
      const option = document.createElement("div");
      option.textContent = label;
      option.style.padding = "4px 8px"; option.style.cursor = "pointer";
      option.onmouseenter = () => option.style.background = "#eee";
      option.onmouseleave = () => option.style.background = "#fff";
      option.onclick = (e) => { e.stopPropagation(); applyManualLabel(rowElement, label, badge); dropdown.remove(); };
      dropdown.appendChild(option);
    });

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
    dropdown.style.top = `${rect.bottom + window.scrollY}px`;
    dropdown.style.left = `${rect.left + window.scrollX}px`;
    document.body.appendChild(dropdown);
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

  badge.textContent = newLabel;
  badge.style.background = getOrCreateLabelColor(newLabel);

  chrome.runtime.sendMessage({ type: "APPLY_LABEL", sender, subject, newLabel });
}

// ==============================
// OPTIMIZED OBSERVER & PROCESSING
// ==============================
function startOptimizedObserver() {
  const target = document.querySelector('table.F.cf.zt') || document.body;
  new MutationObserver(() => {
    if (!pendingRowProcessing) {
      pendingRowProcessing = true;
      requestAnimationFrame(processInboxRows);
    }
  }).observe(target, { childList: true, subtree: true });

  setInterval(() => { if (!pendingRowProcessing) requestAnimationFrame(processInboxRows); }, 3000);
}

function processInboxRows() {
  pendingRowProcessing = false;
  // tr.zE matches ONLY unread email rows in Gmail
  const rows = document.querySelectorAll("tr.zE"); 
  
  rows.forEach(row => {
    // If Gmail destroys our badge during a re-render, this will be falsy, 
    // allowing us to re-fetch and re-attach it accurately.
    if (row.querySelector(".auto-email-label-badge")) return; 
    
    // Prevent overlapping network requests for the exact same row
    if (row.dataset.autoLabeled === "processing") return; 
    
    const subjectSpan = row.querySelector(".y6 span");
    const senderContainer = row.querySelector(".yX.xY");
    const senderSpan = senderContainer?.querySelector("span");
    
    if (!subjectSpan || !senderContainer || !senderSpan) return;
    row.dataset.autoLabeled = "processing"; // Mark as being processed

    const sender = senderSpan.innerText;
    const subject = subjectSpan.innerText;

    // Fix for: "Extension context invalidated" development error
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) {
      console.warn("Auto Email Labeler context lost. Please refresh the Gmail tab.");
      return;
    }

    chrome.runtime.sendMessage({ type: "PREDICT", sender, subject }, (prediction) => {
      if (chrome.runtime.lastError) {
        delete row.dataset.autoLabeled;
        return;
      }
      
      delete row.dataset.autoLabeled; // clear the processing lock
      
      const badge = createBadge(prediction || { label: "AUTO", confidence: 0 }, row);
      if (badge && !row.querySelector(".auto-email-label-badge")) {
        senderContainer.parentElement.insertBefore(badge, senderContainer);
        debugLog.push(`${sender} | ${subject} -> ${prediction?.label || "AUTO"}`);
        if(debugLog.length > 20) debugLog.shift();
      }
    });
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
  btn.style.cssText = `position:fixed;top:${settings.buttonPos.top}px;left:${settings.buttonPos.left}px;
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
      else { settings.buttonPos = { top: btn.offsetTop, left: btn.offsetLeft }; saveSettings(settings); }
    };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  };
  document.body.appendChild(btn);
}

function togglePanel() { panelVisible ? closePanel() : openPanel(); }

function openPanel() {
  if (panelEl) return; panelVisible = true;
  panelEl = document.createElement("div");
  panelEl.style.cssText = `position:fixed;top:${settings.buttonPos.top+40}px;left:${settings.buttonPos.left}px;
    background:#fff;border:1px solid #ccc;padding:12px;width:320px;font-size:12px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.2);border-radius:8px;font-family:sans-serif;`;
  
  chrome.runtime.sendMessage({ type: "GET_STATS" }, stats => {
    panelEl.innerHTML = `
      <b style="font-size:14px;">Auto Email Labeler (Thin Client)</b><hr style="margin:8px 0;"/>
      <label style="display:block;margin-bottom:4px"><input type="checkbox" id="autoApply"> Auto Apply Labels</label>
      <label style="display:block;margin-bottom:4px"><input type="checkbox" id="senderBoost"> Sender Memory Boost</label>
      <label style="display:block;margin-bottom:4px"><input type="checkbox" id="gmailApi"> Background Sync API</label>
      <label style="display:block;margin-bottom:4px;color:#0e8a16;font-weight:bold"><input type="checkbox" id="ollamaEnabled"> Enable Ollama Semantic AI</label>
      <div id="ollamaBox" style="display:${settings.ollamaEnabled ? 'block' : 'none'}; padding-left:14px; margin-bottom:8px; border-left:2px solid #ccc;">
        URL: <input type="text" id="ollamaUrl" style="width:100%; font-size:10px; margin-bottom:4px;" placeholder="http://localhost:11434">
        Model: 
        <select id="ollamaModel" style="width:100%; font-size:10px; padding:2px;">
          <option value="llama3.2">llama3.2:latest</option>
          <option value="deepseek-coder">deepseek-coder:latest</option>
        </select>
      </div>
      <hr style="margin:8px 0;"/>
      <b>Server Stats:</b><br/>
      Samples Learned: ${stats.samples || 0}<br/>
      Total Labels: ${stats.labels || "None"}<br/>
      Offline Queue: ${stats.queue || 0} items<hr style="margin:8px 0;"/>
      <button id="closeBtn" style="padding:4px 8px;background:#eee;border:1px solid #ccc;border-radius:4px;cursor:pointer;">Close</button>
      <pre style="max-height:100px;overflow:auto;background:#f8f8f8;padding:4px;margin-top:8px;font-size:10px;">${debugLog.join('\\n')}</pre>
    `;
    
    document.body.appendChild(panelEl);

    ["autoApply", "senderBoost", "gmailApi", "ollamaEnabled"].forEach(key => {
      const el = panelEl.querySelector(`#${key}`);
      el.checked = settings[key];
      el.onchange = () => { 
        settings[key] = el.checked; 
        
        if (key === "ollamaEnabled") {
          panelEl.querySelector("#ollamaBox").style.display = el.checked ? 'block' : 'none';
          // Tell background to rebuild the math centroids immediately using the new engine
          chrome.runtime.sendMessage({ type: "OFFSCREEN_REBUILD_MODEL", settings });
        }
        
        saveSettings(settings); 
        if (key === "gmailApi" && el.checked) {
          chrome.runtime.sendMessage({ type: "FETCH_GMAIL" });
        }
      };
    });
    
    ["ollamaUrl", "ollamaModel"].forEach(key => {
      const el = panelEl.querySelector(`#${key}`);
      el.value = settings[key];
      el.onchange = () => { settings[key] = el.value.trim(); saveSettings(settings); };
    });

    panelEl.querySelector("#closeBtn").onclick = closePanel;
  });
}

function closePanel() { panelEl?.remove(); panelEl = null; panelVisible = false; }
