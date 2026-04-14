importScripts("idb_store.js", "ml_model.js");
console.log("Background service worker active");

const SYNC_MODE = "SCRAPE"; // Force local-only scraping mode
if (typeof MAX_DATASET === 'undefined') var MAX_DATASET = 25000;

let emailLabelMap = new Map();
let settings = { autoApply: true, senderBoost: true };
let labelCache = null;

// Atomic Initialization with Safety Timeout
let initPromise = Promise.race([
  init(),
  new Promise((_, reject) => setTimeout(() => reject(new Error("Init Timeout")), 5000))
]).catch(e => {
  console.error("Critical: Initialization Failure", e);
  // Emergency fallback to empty state to keep the client alive
  trainingDataset = trainingDataset || [];
  return true;
});


// ==============================
// INIT
// ==============================
async function init() {
  console.log("Initializing Background Service Worker...");
  const state = await idb.getAllState();
  trainingDataset = state.trainingDataset || [];
  senderMemory = state.senderMemory || {};
  vocabulary = state.vocabulary || [];
  idf = state.idf || {};
  centroids = state.centroids || {};
  currentHistoryId = state.currentHistoryId || null;
  offlineQueue = state.offlineQueue || [];
  emailLabelMap = new Map(state.emailLabelMap || []);

  // One-time sanitization: Deduplicate by ID, preferring labeled/unread over stale AUTO records
  const dedupedMap = new Map();
  (state.trainingDataset || []).forEach(d => {
    if (!d.messageId) return;
    const existing = dedupedMap.get(d.messageId);
    // Keep the most complete record
    if (!existing || (existing.label === "AUTO" && d.label !== "AUTO") || (d.timestamp > existing.timestamp)) {
      dedupedMap.set(d.messageId, {
        ...d,
        timestamp: d.timestamp || Date.now() // Guarantee timestamp
      });
    }
  });

  trainingDataset = Array.from(dedupedMap.values()).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  // Await storage settings
  const sync = await new Promise(resolve => chrome.storage.sync.get({ settings }, resolve));
  if (sync.settings) settings = { ...settings, ...sync.settings };

  // FORCE mandatory features override
  settings.autoApply = true;
  settings.senderBoost = true;
  console.log("Settings loaded and forced:", settings);

  console.log("Running in Local Scrape Mode. Background API Sync disabled.");
}


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
    initPromise
      .then(() => handlePredict(msg))
      .then(sendResponse)
      .catch(e => { console.error("Predict error:", e); sendResponse({ error: e.message }); });
    return true; // async
  }
  if (msg.type === "APPLY_LABEL") {
    initPromise
      .then(() => handleApplyLabel(msg))
      .then(sendResponse)
      .catch(e => { console.error("Apply error:", e); sendResponse({ error: e.message }); });
    return true;
  }
  if (msg.type === "SAVE_SETTINGS") {
    initPromise.then(() => {
      chrome.storage.sync.set({ settings: msg.settings });
      settings = msg.settings;
      sendResponse({ success: true });
    }).catch(e => { console.error("Save settings error:", e); sendResponse({ error: e.message }); });
    return true;
  }
  if (msg.type === "GET_STATS") {
    initPromise.then(() => {
      const uniqueLabels = new Set();
      Object.keys(centroids).forEach(l => uniqueLabels.add(l));
      Array.from(emailLabelMap.values()).forEach(v => {
        if (v && v.label && v.label !== "AUTO") uniqueLabels.add(v.label);
      });
      trainingDataset.forEach(d => {
        if (d && d.label && d.label !== "AUTO") uniqueLabels.add(d.label);
      });

      const sortedLabels = Array.from(uniqueLabels).sort((a, b) => a.localeCompare(b));
      sendResponse({
        samples: trainingDataset.length,
        vocab: vocabulary.length,
        labels: sortedLabels.join(", "),
        queue: 0,
        status: "Ready (Local Scrape)",
        dbSize: trainingDataset.length
      });

    }).catch(e => { console.error("Get stats error:", e); sendResponse({ error: e.message }); });
    return true;
  }
  if (msg.type === "OPEN_DASHBOARD") {
    const url = chrome.runtime.getURL("visualization.html");
    chrome.tabs.query({}, (tabs) => {
      const existingTab = tabs.find(t => t.url === url);
      if (existingTab) {
        chrome.tabs.update(existingTab.id, { active: true, highlighted: true, url: url });
        chrome.windows.update(existingTab.windowId, { focused: true });
      } else {
        chrome.tabs.create({ url: url });
      }
    });
    sendResponse({ success: true });
    return true;
  }
  if (msg.type === "GET_RAW_DATA") {
    initPromise.then(() => {
      sendResponse({
        memoryCount: trainingDataset.length,
        idbStatus: "Connected",
        lastSave: new Date().toLocaleTimeString()
      });
    });
    return true;
  }
  if (msg.type === "RESET_ENGINE") {
    trainingDataset = [];
    emailLabelMap.clear();
    senderMemory = {};
    idb.set("trainingDataset", []);
    idb.set("emailLabelMap", []);
    idb.set("senderMemory", {});
    sendResponse({ success: true });
    return true;
  }
  if (msg.type === "HEARTBEAT") {
    sendResponse({ alive: true, timestamp: Date.now() });
    return true;
  }
});





async function handlePredict(msg) {
  const key = normalize(msg.sender + "::" + msg.subject);
  let result;

  // PHASE 1: Prediction (Cached or New)
  if (emailLabelMap.has(key)) {
    result = emailLabelMap.get(key);
    const senderKey = normalize(msg.sender);
    if (senderMemory[senderKey]) {
      let totalApprovals = 0;
      Object.values(senderMemory[senderKey]).forEach(val => {
        totalApprovals += (val && typeof val === 'object' ? val.count : val);
      });
      result.isGraduated = totalApprovals >= 3;
    } else {
      result.isGraduated = false;
    }
  } else {
    result = await predictLabel(msg.sender, msg.subject, msg.snippet || "", settings);
    emailLabelMap.set(key, result);
    await saveStoreData(["emailLabelMap"]);
  }

  // PHASE 2: Intelligence Persistence (CRITICAL: Runs for every message seen)
  const existingIndex = trainingDataset.findIndex(d => d.messageId === msg.messageId);
  if (existingIndex !== -1) {
    let changed = false;
    const entry = trainingDataset[existingIndex];
    if (!entry.sentDate && msg.sentDate) { entry.sentDate = msg.sentDate; changed = true; }
    if (msg.isUnread !== undefined && entry.isUnread !== msg.isUnread) { entry.isUnread = msg.isUnread; changed = true; }
    if (entry.label === "AUTO" && result.label && result.label !== "AUTO") { entry.label = result.label; changed = true; }
    if (changed) {
      await saveStoreData(["dataset"]);
      console.log(`Persistence: Updated intelligence for ${msg.messageId.substring(0, 8)}...`);
    }
  } else {
    const timestamp = msg.sentDate ? parseGmailDate(msg.sentDate) : Date.now();
    trainingDataset.push({
      messageId: msg.messageId,
      sender: msg.sender,
      subject: msg.subject,
      snippet: msg.snippet || "",
      isUnread: msg.isUnread || false,
      label: result.label || "AUTO",
      timestamp: timestamp,
      sentDate: msg.sentDate || new Date().toLocaleString(),
      source: msg.source || "gmail-sync"
    });
    smartTrimDataset(MAX_DATASET);
    await saveStoreData(["dataset"]);
    console.log(`Persistence: NEW Intelligence Saved [ID: ${msg.messageId.substring(0, 8)}]`);
  }

  if (settings.autoApply && msg.messageId && result && result.label && result.label !== "AUTO" && result.isGraduated) {
    applyLabelToMessageId(msg.messageId, result.label);
  }

  return result;
}


async function handleApplyLabel(msg) {
  const senderKey = normalize(msg.sender);
  const key = normalize(msg.sender + "::" + msg.subject);

  // Wipe cache for any email matching this sender so it forces re-prediction with new weights
  Array.from(emailLabelMap.keys()).forEach(k => {
    if (k.startsWith(senderKey)) emailLabelMap.delete(k);
  });

  senderMemory[senderKey] ??= {};
  let currentObj = senderMemory[senderKey][msg.newLabel];
  let newCount = (currentObj && typeof currentObj === 'object' ? currentObj.count : (currentObj || 0)) + 1;
  senderMemory[senderKey][msg.newLabel] = { count: newCount, lastUpdated: Date.now() };

  let totalApprovals = 0;
  Object.values(senderMemory[senderKey]).forEach(val => {
    totalApprovals += (val && typeof val === 'object' ? val.count : val);
  });

  // Directly set the specific corrected subject key to the explicit label WITH the grad flag
  emailLabelMap.set(key, { label: msg.newLabel, confidence: 1, isGraduated: totalApprovals >= 3 });

  if (settings.autoApply && msg.messageId && msg.newLabel) {
    applyLabelToMessageId(msg.messageId, msg.newLabel, true);
  }

  const existingIndex = trainingDataset.findIndex(d => d.messageId === msg.messageId);
  if (existingIndex !== -1) {
    trainingDataset[existingIndex].label = msg.newLabel;
    trainingDataset[existingIndex].source = "user-corrected";
    if (msg.sentDate) trainingDataset[existingIndex].sentDate = msg.sentDate;
    if (msg.isUnread !== undefined) trainingDataset[existingIndex].isUnread = msg.isUnread;
  } else {
    trainingDataset.push({
      messageId: msg.messageId,
      sender: msg.sender,
      subject: msg.subject,
      snippet: msg.snippet || "",
      isUnread: msg.isUnread || false,
      label: msg.newLabel,
      timestamp: parseGmailDate(msg.sentDate),
      sentDate: msg.sentDate || new Date().toLocaleString(),
      source: "user-corrected"
    });
    smartTrimDataset(MAX_DATASET);
  }

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

function smartTrimDataset(maxSize) {
  if (trainingDataset.length <= maxSize) return;

  // Identify candidates for removal: Oldest, Read, and Unlabeled
  // We want to KEEP: Unread OR Labeled
  const removeCount = trainingDataset.length - maxSize;

  // Sort indices by priority: 
  // 1. Read & Unlabeled (lowest priority to keep)
  // 2. Read & Labeled
  // 3. Unread
  const indices = trainingDataset.map((_, i) => i);
  indices.sort((a, b) => {
    const da = trainingDataset[a];
    const db = trainingDataset[b];

    const priorityA = (da.isUnread ? 10 : 0) + (da.label !== "AUTO" ? 5 : 0);
    const priorityB = (db.isUnread ? 10 : 0) + (db.label !== "AUTO" ? 5 : 0);

    if (priorityA !== priorityB) return priorityA - priorityB;
    return (da.timestamp || 0) - (db.timestamp || 0); // Older first
  });

  const indicesToRemove = new Set(indices.slice(0, removeCount));
  trainingDataset = trainingDataset.filter((_, i) => !indicesToRemove.has(i));
}

// Await the direct IO operations so offscreen doesn't read stale data
async function saveStoreData(keys = []) {
  emailLabelMap = trimMap(emailLabelMap);

  const promises = [];
  if (keys.includes("dataset")) promises.push(idb.set("trainingDataset", trainingDataset));
  if (keys.includes("senderMemory")) promises.push(idb.set("senderMemory", senderMemory));
  if (keys.includes("emailLabelMap")) promises.push(idb.set("emailLabelMap", Array.from(emailLabelMap.entries())));
  if (keys.includes("queue")) promises.push(idb.set("offlineQueue", offlineQueue));
  if (keys.includes("historyId")) promises.push(idb.set("currentHistoryId", currentHistoryId));

  await Promise.all(promises);
  console.log(`Deep Persistence: Committed ${keys.join(", ")} to IndexedDB.`);

  // BROADCAST: Notify open dashboards that data has changed
  chrome.runtime.sendMessage({ type: "DATA_UPDATED", keys }).catch(() => { });
}

// Reliable persistence for Service Workers
async function saveStoreDataDebounced(keys = []) {
  // In MV3, we avoid long timeouts. We save immediately or use short awaits.
  await saveStoreData(keys);
}

// Pure Scraper: API calls removed to prevent GCP Client ID errors.
async function applyLabelToMessageId(messageId, labelName, force = false) {
  console.log(`Scraper Mode: Native label application [${labelName}] skipped for ${messageId}`);
}

function parseGmailDate(dateStr) {
  if (!dateStr) return Date.now();
  // Strip day of week if present "Fri, 12 Apr..."
  const cleanDate = dateStr.replace(/^[A-Za-z]{3},\s+/, "");
  const d = new Date(cleanDate);
  return isNaN(d.getTime()) ? Date.now() : d.getTime();
}

