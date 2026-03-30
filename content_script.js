console.log("Auto Email Labeler content script active");

// ==============================
// CONFIG & STATE
// ==============================
const DEFAULT_SETTINGS = {
  autoApply: true,
  autoLearn: true,
  senderBoost: true,
  debug: false,
  buttonPos: { top: 120, left: window.innerWidth - 140 },
  badgeVisibility: {},
  gmailApiEnabled: false
};

let settings = { ...DEFAULT_SETTINGS };
let labelMeta = {};
let labelRules = {};
let emailLabelMap = new Map();
let panelEl = null;
let panelVisible = false;
let gmailFetchedCount = 0;
let gmailTotalCount = 0;
let lastMessageId = null;

// Map to store dynamic colors for all labels
const labelColors = {};

// Using computeIDF, rebuildCentroids, vectorize, predictLabel, etc. from ml_model.js

// ==============================
// UTILITIES
// ==============================
function saveSettingsViaBackground(settings){
  chrome.runtime.sendMessage({
    type: "SAVE_SETTINGS",
    settings
  });
}

// ==============================
// STORAGE LOAD
// ==============================
chrome.storage.local.get({ 
  dataset: [], 
  senderMemory: {}, 
  lastMessageId: null, 
  emailLabelMap: [],
  centroids: {},
  vocabulary: [],
  idf: {}
}, res => {
  trainingDataset = res.dataset;
  senderMemory = res.senderMemory;
  lastMessageId = res.lastMessageId;
  emailLabelMap = new Map(res.emailLabelMap);
  centroids = res.centroids || {};
  vocabulary = res.vocabulary || [];
  idf = res.idf || {};

  chrome.storage.sync.get({ labelMeta: {}, labelRules: {}, settings: DEFAULT_SETTINGS }, sync => {
    labelMeta = sync.labelMeta;
    labelRules = sync.labelRules;
    settings = { ...DEFAULT_SETTINGS, ...sync.settings };
    initFloatingButton();
    startGmailObserver();
    if(Object.keys(centroids).length === 0 && trainingDataset.length > 0) {
      chrome.runtime.sendMessage({ type: "REBUILD_MODEL" });
    }
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") {
    if (changes.centroids) centroids = changes.centroids.newValue;
    if (changes.vocabulary) vocabulary = changes.vocabulary.newValue;
    if (changes.idf) idf = changes.idf.newValue;
    if (changes.dataset) trainingDataset = changes.dataset.newValue;
    if (changes.senderMemory) senderMemory = changes.senderMemory.newValue;
    if (changes.emailLabelMap) emailLabelMap = new Map(changes.emailLabelMap.newValue);
  }
});

// ==============================
// DYNAMIC LABEL COLOR
// ==============================
function getOrCreateLabelColor(label){
  if(labelColors[label]) return labelColors[label];
  let hash = 0;
  for(let i=0;i<label.length;i++) hash = label.charCodeAt(i)+((hash<<5)-hash);
  const c = (hash & 0x00FFFFFF).toString(16).toUpperCase();
  const color = "#" + "00000".substring(0,6-c.length) + c;
  labelColors[label] = color;
  return color;
}

// ==============================
// BADGE
// ==============================
function createBadge(prediction){
  if(settings.badgeVisibility[prediction.label]===false) return null;
  const badge = document.createElement("span");
  badge.className = "auto-email-label-badge";
  badge.textContent = prediction.label;
  badge.title = prediction.label;
  badge.style.maxWidth = "120px";
  badge.style.overflow = "hidden";
  badge.style.textOverflow = "ellipsis";

  badge.style.whiteSpace = "nowrap";
  badge.style.display = "inline-flex";
  badge.style.alignItems = "center";
  badge.style.flexShrink = "0";


  const bgColor = getOrCreateLabelColor(prediction.label);
  Object.assign(badge.style,{
    marginLeft:"8px",
    padding:"2px 8px",
    borderRadius:"12px",
    fontSize:"12px",
    fontWeight:"bold",
    color:"#fff",
    background:bgColor,
    cursor:"pointer",
    transition:"all 0.3s ease",
    opacity:0
  });
  setTimeout(()=>{ badge.style.opacity = 1; },50);
  badge.onclick = e=>{ e.stopPropagation(); showLabelOverrideDropdown(badge,prediction); };
  return badge;
}

// ==============================
// BADGE OVERRIDE + ADD NEW LABEL
// ==============================
function showLabelOverrideDropdown(badge,prediction){
  document.querySelectorAll(".auto-label-dropdown")?.forEach(d=>d.remove());
  const dropdown = document.createElement("div");
  dropdown.className = "auto-label-dropdown";
  dropdown.style.cssText = `position:absolute; background:#fff; border:1px solid #ccc; padding:4px; z-index:10000; font-size:12px; border-radius:4px;`;

  const labels = Object.keys(centroids);
  labels.forEach(label=>{
    const option = document.createElement("div");
    option.textContent = label;
    option.style.padding="2px 6px";
    option.style.cursor="pointer";
    option.onmouseenter = ()=>option.style.background="#eee";
    option.onmouseleave = ()=>option.style.background="#fff";
    option.onclick = ()=>{ applyNewLabel(prediction,label,badge); dropdown.remove(); };
    dropdown.appendChild(option);
  });

  const input = document.createElement("input");
  input.placeholder = "Add new label...";
  input.style.width="100%";
  input.style.marginTop="4px";
  input.style.padding="2px 4px";
  input.style.boxSizing="border-box";
  input.onkeydown = e=>{
    if(e.key==="Enter" && input.value.trim()){
      applyNewLabel(prediction,input.value.trim(),badge);
      dropdown.remove();
    }
  };
  dropdown.appendChild(input);

  const rect = badge.getBoundingClientRect();
  dropdown.style.top = `${rect.bottom + window.scrollY}px`;
  dropdown.style.left = `${rect.left + window.scrollX}px`;
  document.body.appendChild(dropdown);
  input.focus();
}

// ==============================
// APPLY NEW LABEL
// ==============================
function applyNewLabel(prediction,newLabel,badge){
  prediction.label = newLabel;
  prediction.confidence = 1;
  const key = normalize(prediction.sender+"::"+prediction.subject);
  emailLabelMap.set(key,{label:newLabel,confidence:1});
  const senderKey = normalize(prediction.sender);
  senderMemory[senderKey] ??= {};
  senderMemory[senderKey][newLabel] ??= 0;
  senderMemory[senderKey][newLabel] += 1;

  if(trainingDataset.length>MAX_DATASET) trainingDataset.shift();
  trainingDataset.push({ sender:prediction.sender, subject:prediction.subject, label:newLabel, timestamp:Date.now(), source:"user-corrected" });

  saveDataDebounced();
  chrome.runtime.sendMessage({ type: "REBUILD_MODEL" });

  if(badge){
    badge.textContent = newLabel;
    badge.style.background = getOrCreateLabelColor(newLabel);
  }
}

// ==============================
// APPLY LABEL TO GMAIL ROW
// ==============================
function applyLabelToGmailRow(row,prediction){
  if(!row || !prediction) return;
  const subjectSpan = row.querySelector(".y6 span");
  if(!subjectSpan) return;
  let badge = subjectSpan.parentElement.querySelector(".auto-email-label-badge");
  if(badge){
    badge.style.display = "inline-block";
    badge.textContent = prediction.label;
    badge.style.background = getOrCreateLabelColor(prediction.label);
    return;
  }
  if(prediction.confidence<0.5) return;
  badge = createBadge(prediction);
  if(badge) subjectSpan.parentElement.appendChild(badge);
}

function attachBadgeBeforeSender(row, prediction) {
  const senderContainer = row.querySelector(".yX.xY");
  if (!senderContainer) return;

  // prevent duplicate badges
  if (row.querySelector(".auto-email-label-badge")) return;

  const badge = createBadge(prediction);
  if (!badge) return;

  badge.style.marginRight = "6px";
  badge.style.marginLeft = "2px";

  // 🔑 THIS is the important line
  senderContainer.parentElement.insertBefore(badge, senderContainer);
}


// ==============================
// FLOATING BUTTON + PANEL
// ==============================
function initFloatingButton(){
  if(!document.body) return setTimeout(initFloatingButton,100);
  if(document.getElementById("autoLabelerBtn")) return;

  const btn = document.createElement("div");
  btn.id="autoLabelerBtn";
  btn.textContent="Auto Labeler";
  btn.style.cssText=`position:fixed;top:${settings.buttonPos.top}px;left:${settings.buttonPos.left}px;
    background:#1a73e8;color:#fff;padding:6px 10px;border-radius:16px;font-size:12px;font-weight:600;
    cursor:grab;z-index:9999;user-select:none;transition:transform 0.15s,box-shadow 0.15s;`;
  btn.onmouseenter=()=>{ btn.style.boxShadow="0 2px 6px rgba(0,0,0,0.3)"; btn.style.transform="scale(1.05)"; };
  btn.onmouseleave=()=>{ btn.style.boxShadow="none"; btn.style.transform="scale(1)"; };
  makeDraggable(btn);
  btn.onclick=()=>{ if(btn.dataset.dragging!=="true") togglePanel(); };
  document.body.appendChild(btn);
}

function togglePanel(){ panelVisible?closePanel():openPanel(); }
function openPanel(){
  if(panelEl) return; panelVisible=true;
  panelEl = document.createElement("div");
  panelEl.style.cssText=`position:fixed;top:${settings.buttonPos.top+40}px;left:${settings.buttonPos.left}px;
    background:#fff;border:1px solid #ccc;padding:10px;width:320px;font-size:12px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.2);`;
  document.body.appendChild(panelEl);
  panelEl.innerHTML=`
    <b>Auto Email Labeler</b><br/><br/>
    <label><input type="checkbox" id="autoApply"> Auto Apply</label><br/>
    <label><input type="checkbox" id="autoLearn"> Auto Learn</label><br/>
    <label><input type="checkbox" id="senderBoost"> Sender Boost</label><br/>
    <label><input type="checkbox" id="debug"> Debug Mode</label><br/>
    <label><input type="checkbox" id="gmailApi"> Gmail API</label><br/><hr/>
    <b>Stats</b><br/>
    Samples: ${trainingDataset.length}<br/>
    Vocabulary: ${vocabulary.length}<br/>
    Labels: ${Object.keys(centroids).join(", ")}<br/><hr/>
    <button id="downloadBtn">Download Data</button>
    <button id="sendBtn">Send Data</button>
    <div id="gmailProgress" style="margin-top:5px;">
      <b>Gmail Sync:</b> <span id="gmailFetched">0</span> / <span id="gmailTotal">0</span>
      <div style="width:100%;height:6px;background:#eee;border-radius:3px;margin-top:2px;">
        <div id="gmailProgressBar" style="width:0%;height:100%;background:#1a73e8;border-radius:3px;"></div>
      </div>
    </div>
    <pre id="debugLog" style="max-height:150px;overflow:auto;background:#f8f8f8;padding:4px;margin-top:5px;font-size:10px;"></pre>
  `;

  ["autoApply","autoLearn","senderBoost","debug","gmailApi"].forEach(key=>{
    const el = panelEl.querySelector(`#${key}`);
    el.checked = settings[key];
    el.onchange = ()=>{
      settings[key] = el.checked;
      saveSettingsViaBackground(settings);
      if(key==="gmailApi" && settings.gmailApi) fetchGmailViaBackground();
    };
  });

  panelEl.querySelector("#downloadBtn").onclick = downloadData;
  panelEl.querySelector("#sendBtn").onclick = sendData;
  updateDebugPanel();
}
function closePanel(){ panelEl?.remove(); panelEl=null; panelVisible=false; }

function makeDraggable(el){
  let offsetX=0, offsetY=0, dragging=false;
  el.addEventListener("mousedown", e=>{
    dragging=true; el.dataset.dragging="false";
    offsetX=e.clientX-el.offsetLeft; offsetY=e.clientY-el.offsetTop;
    el.style.cursor="grabbing";
  });
  document.addEventListener("mousemove", e=>{
    if(!dragging) return;
    el.dataset.dragging="true";
    el.style.left=`${e.clientX-offsetX}px`;
    el.style.top=`${e.clientY-offsetY}px`;
  });
  document.addEventListener("mouseup", ()=>{
    if(!dragging) return;
    dragging=false; el.style.cursor="grab";
    settings.buttonPos={top:el.offsetTop,left:el.offsetLeft};
    saveSettingsViaBackground(settings);
  });
}

// ==============================
// DOWNLOAD / SEND DATA
// ==============================
function downloadData(){
  const data = { dataset:trainingDataset, senderMemory };
  const blob = new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href=url; a.download="auto_email_data.json"; a.click(); URL.revokeObjectURL(url);
}
function sendData(){ console.log("Send Data JSON:", {dataset:trainingDataset, senderMemory}); alert("Send Data JSON logged in console."); }

// ==============================
// DEBUG PANEL
// ==============================
function updateDebugPanel(){
  if(!panelEl) return;
  const debugEl = panelEl.querySelector("#debugLog");
  if(!debugEl) return;
  debugEl.textContent = debugLog.map(d=>`${d.sender}|${d.subject}→${d.label}`).join("\n");
}

// ==============================
// FETCH VIA BACKGROUND
// ==============================
function fetchGmailViaBackground(){
  chrome.runtime.sendMessage({ type:"FETCH_GMAIL" }, res=>{
    if(res.error) console.error(res.error); else console.log("Gmail fetch triggered");
  });
}

// ==============================
// GMAIL DOM OBSERVER
// ==============================
function processUnreadEmails() {
  document.querySelectorAll("tr").forEach(row => {

    // Act ONLY on unread rows
    if (!row.classList.contains("zE")) return;

    const subjectSpan = row.querySelector(".y6 span");
    if (!subjectSpan) return;

    const sender =
      row.querySelector(".yX.xY span")?.innerText || "";
    const subject = subjectSpan.innerText;
    const key = normalize(sender + "::" + subject);

    let prediction = emailLabelMap.get(key);

    // Create prediction if missing
    if (!prediction) {
      prediction = predictLabel(sender, subject, settings.senderBoost);
      emailLabelMap.set(key, prediction);
    }

    // Gmail may remove badges → reattach safely BEFORE sender
    const senderContainer = row.querySelector(".yX.xY");
    if (!senderContainer) return;

    if (!row.querySelector(".auto-email-label-badge")) {
      const badge = createBadge(prediction);
      if (!badge) return;

      badge.style.marginRight = "6px";
      badge.style.marginLeft = "2px";

      // Insert BEFORE sender (safe anchor)
      senderContainer.parentElement.insertBefore(badge, senderContainer);
    }
  });

  updateDebugPanel();
}


function startGmailObserver() {
  setTimeout(processUnreadEmails, 1000);

  let debounce;
  // Limit observer to main table or body but filter mutations heavily
  const target = document.querySelector(".AO") || document.body;
  new MutationObserver(() => {
    clearTimeout(debounce);
    debounce = setTimeout(processUnreadEmails, 300);
  }).observe(target, {
    childList: true,
    subtree: true
  });
}


// ==============================
// ONLINE RESUME
window.addEventListener("online",()=>{ if(settings.gmailApi) fetchGmailViaBackground(); });

// ==============================
// SPA NAVIGATION
window.addEventListener('popstate',()=>{ startGmailObserver(); });

// ==============================
// GMAIL API LISTENER
chrome.runtime.onMessage.addListener(msg=>{
  if(msg.type==="NEW_GMAIL_DATA"){
    msg.emails.forEach(e=>{
      const sender = e.sender, subject = e.subject;
      if(trainingDataset.length>MAX_DATASET) trainingDataset.shift();
      trainingDataset.push({sender,subject,label:"AUTO",timestamp:Date.now(),source:"gmail-auto"});
    });
    rebuildModelDebounced();
  }
});
