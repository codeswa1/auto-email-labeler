importScripts("idb_store.js", "ml_model.js");
console.log("Background service worker active");

const CLIENT_ID = "590450940640-9l860kqpraoe5rlphopnusc6io4f5oju.apps.googleusercontent.com";
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const FETCH_BATCH_SIZE = 50;

let accessToken = null;
let lastMessageId = null;
let offlineQueue = [];
let emailLabelMap = new Map();
let settings = { autoApply: true, senderBoost: true, gmailApiEnabled: false };
let labelCache = null;
const nativelyApplied = new Set();

// ==============================
// INIT
// ==============================
async function init() {
  const state = await idb.getAllState();
  trainingDataset = state.trainingDataset || [];
  senderMemory = state.senderMemory || {};
  vocabulary = state.vocabulary || [];
  idf = state.idf || {};
  centroids = state.centroids || {};
  lastMessageId = state.lastMessageId || null;
  offlineQueue = state.offlineQueue || [];
  emailLabelMap = new Map(state.emailLabelMap || []);

  chrome.storage.sync.get({ settings }, sync => {
    if (sync.settings) settings = { ...settings, ...sync.settings };
  });

  chrome.alarms.create("syncGmail", { periodInMinutes: 5 });
}
init();

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "syncGmail" && settings.gmailApiEnabled) {
    if (offlineQueue.length > 0) processOfflineQueue();
    else fetchGmailEmails().catch(e => console.error("Auto fetch error", e));
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.settings) {
    settings = { ...settings, ...changes.settings.newValue };
  }
});

// ==============================
// MESSAGING & RPC (Thin Client support)
// ==============================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "PREDICT") {
    handlePredict(msg).then(sendResponse);
    return true; // async
  }
  if (msg.type === "APPLY_LABEL") {
    handleApplyLabel(msg).then(sendResponse);
    return true;
  }
  if (msg.type === "SAVE_SETTINGS") {
    chrome.storage.sync.set({ settings: msg.settings });
    settings = msg.settings;
    if (settings.gmailApiEnabled) fetchGmailEmails();
    sendResponse({ success: true });
  }
  if (msg.type === "FETCH_GMAIL") {
    fetchGmailEmails(true).then(() => sendResponse({ success: true })).catch(e => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === "GET_STATS") {
    const uniqueLabels = new Set();
    Object.keys(centroids).forEach(l => uniqueLabels.add(l));
    Array.from(emailLabelMap.values()).forEach(v => {
      if(v && v.label && v.label !== "AUTO") uniqueLabels.add(v.label);
    });
    trainingDataset.forEach(d => {
      if(d && d.label && d.label !== "AUTO") uniqueLabels.add(d.label);
    });

    sendResponse({ samples: trainingDataset.length, vocab: vocabulary.length, labels: Array.from(uniqueLabels).join(", "), queue: offlineQueue.length });
  }
});

async function handlePredict(msg) {
  const key = normalize(msg.sender + "::" + msg.subject);
  let result;
  if (emailLabelMap.has(key)) {
     result = emailLabelMap.get(key);
  } else {
     // Uses memory objects built by IDB/Init, now passes settings
     result = await predictLabel(msg.sender, msg.subject, settings);
     emailLabelMap.set(key, result);
     saveStoreData(["emailLabelMap"]);
  }
  
  if (settings.autoApply && msg.messageId && result && result.label && result.label !== "AUTO") {
    applyLabelToMessageId(msg.messageId, result.label);
  }
  
  return result;
}

async function handleApplyLabel(msg) {
  const key = normalize(msg.sender + "::" + msg.subject);
  emailLabelMap.set(key, { label: msg.newLabel, confidence: 1 });
  
  const senderKey = normalize(msg.sender);
  senderMemory[senderKey] ??= {};
  senderMemory[senderKey][msg.newLabel] = (senderMemory[senderKey][msg.newLabel] || 0) + 1;

  if (settings.autoApply && msg.messageId && msg.newLabel) {
    applyLabelToMessageId(msg.messageId, msg.newLabel, true);
  }

  if (trainingDataset.length > MAX_DATASET) trainingDataset.shift();
  trainingDataset.push({ sender: msg.sender, subject: msg.subject, label: msg.newLabel, timestamp: Date.now(), source: "user-corrected" });

  await saveStoreData(["senderMemory", "dataset", "emailLabelMap"]);
  triggerOffscreenRebuild();
  return { success: true };
}

// ==============================
// OFFSCREEN & STORAGE
// ==============================
let setupOffscreenPromise = null;
async function triggerOffscreenRebuild() {
  if (setupOffscreenPromise) await setupOffscreenPromise;
  
  const hasDocument = await chrome.offscreen.hasDocument();
  if (!hasDocument) {
    setupOffscreenPromise = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Running heavy TF-IDF machine learning matrix rebuilding.'
    });
    await setupOffscreenPromise;
    setupOffscreenPromise = null;
  }
  
  console.log("Sending rebuild order to offscreen");
  chrome.runtime.sendMessage({ type: "OFFSCREEN_REBUILD_MODEL", settings }, async (response) => {
    console.log("Offscreen responded:", response);
    // Reload new centroids into our RAM from IDB
    const state = await idb.getAllState();
    vocabulary = state.vocabulary || [];
    idf = state.idf || {};
    centroids = state.centroids || {};
  });
}

function trimMap(map, maxSize = 2500) {
  if (map.size > maxSize * 2) {
    return new Map(Array.from(map.entries()).slice(-maxSize));
  }
  return map;
}

// Await the direct IO operations so offscreen doesn't read stale data
async function saveStoreData(keys = []) {
  emailLabelMap = trimMap(emailLabelMap);
  
  const promises = [];
  if (keys.includes("dataset")) promises.push(idb.set("trainingDataset", trainingDataset));
  if (keys.includes("senderMemory")) promises.push(idb.set("senderMemory", senderMemory));
  if (keys.includes("emailLabelMap")) promises.push(idb.set("emailLabelMap", Array.from(emailLabelMap.entries())));
  if (keys.includes("queue")) promises.push(idb.set("offlineQueue", offlineQueue));
  if (keys.includes("lastMessageId")) promises.push(idb.set("lastMessageId", lastMessageId));

  await Promise.all(promises);
}

// Debounced version for heavy batch jobs like fetch loop
let saveDebounce;
async function saveStoreDataDebounced(keys = []) {
  clearTimeout(saveDebounce);
  saveDebounce = setTimeout(() => saveStoreData(keys), 1000);
}

// ==============================
// GMAIL OAUTH & API FETCHING
// ==============================

async function getOrCreateGmailLabel(labelName) {
  if (!accessToken) await authorizeGmail(false);
  
  if (!labelCache) {
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.ok) {
      const data = await res.json();
      labelCache = data.labels || [];
    } else {
      labelCache = [];
    }
  }
  
  let label = labelCache.find(l => l.name === labelName || l.name.toLowerCase() === labelName.toLowerCase());
  if (!label) {
    const createRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: labelName,
        labelListVisibility: "labelShow",
        messageListVisibility: "show"
      })
    });
    if (createRes.ok) {
      label = await createRes.json();
      labelCache.push(label);
    }
  }
  return label ? label.id : null;
}

async function applyLabelToMessageId(messageId, labelName, force = false) {
  if (!force && nativelyApplied.has(messageId)) return;
  try {
    const labelId = await getOrCreateGmailLabel(labelName);
    if (!labelId) return;

    await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        addLabelIds: [labelId],
        removeLabelIds: ["INBOX"]
      })
    });
    nativelyApplied.add(messageId);
    if (nativelyApplied.size > 2000) nativelyApplied.clear();
  } catch(e) {
    console.error("Failed to apply native label", e);
  }
}
function authorizeGmail(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, function(token) {
      if (chrome.runtime.lastError || !token) return reject(chrome.runtime.lastError);
      accessToken = token; resolve(token);
    });
  });
}

function decodeMime(str) {
  if (!str) return "";
  return str.replace(/=\?([^?]+)\?([QB])\?([^?]*)\?=/gi, function(match, charset, encoding, content) {
    try {
      if (encoding.toUpperCase() === 'B') return decodeURIComponent(escape(atob(content)));
      if (encoding.toUpperCase() === 'Q') return decodeURIComponent(escape(content.replace(/_/g, ' ').replace(/=([A-F0-9]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))));
    } catch(e) {} return str;
  });
}

async function fetchGmailEmails(interactive = false) {
  if (!accessToken) await authorizeGmail(interactive);
  let nextPageToken = null, fetchedCount = 0;
  
  do {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.searchParams.set("maxResults", FETCH_BATCH_SIZE);
    if (nextPageToken) url.searchParams.set("pageToken", nextPageToken);
    
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error("List fetch failed");
    
    const data = await res.json();
    nextPageToken = data.nextPageToken;
    
    for (const m of data.messages || []) {
      if (lastMessageId && m.id === lastMessageId) break;
      offlineQueue.push(m.id);
      fetchedCount++;
    }
    await processOfflineQueue();
  } while (nextPageToken && fetchedCount < 200);
}

async function processOfflineQueue() {
  while (offlineQueue.length) {
    const id = offlineQueue.shift();
    try {
      const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, 
        { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) throw new Error("Message fetch fail");
      
      const msgData = await res.json();
      const headersObj = Object.fromEntries(msgData.payload.headers.map(h => [h.name, h.value]));
      
      const senderDecoded = decodeMime(headersObj.From || "");
      const subjectDecoded = decodeMime(headersObj.Subject || "");

      trainingDataset.push({
        sender: senderDecoded,
        subject: subjectDecoded,
        label: "AUTO", timestamp: Date.now(), source: "gmail-auto"
      });
      if (settings.autoApply) {
        const prediction = await predictLabel(senderDecoded, subjectDecoded, settings);
        if (prediction && prediction.label && prediction.label !== "AUTO") {
          applyLabelToMessageId(id, prediction.label);
        }
      }
      lastMessageId = id;
      saveStoreDataDebounced(["dataset", "queue", "lastMessageId"]);
    } catch (err) {
      offlineQueue.unshift(id);
      break;
    }
  }
  if(trainingDataset.length > 0) triggerOffscreenRebuild();
}
