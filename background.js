importScripts("idb_store.js", "ml_model.js");
console.log("Background service worker active");

const CLIENT_ID = "590450940640-9l860kqpraoe5rlphopnusc6io4f5oju.apps.googleusercontent.com";
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const FETCH_BATCH_SIZE = 50;

let accessToken = null;
let currentHistoryId = null;
let offlineQueue = [];
let emailLabelMap = new Map();
let settings = { autoApply: true, senderBoost: true, gmailApiEnabled: false };
let labelCache = null;
const nativelyApplied = new Set();

let initPromise = init();

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
  currentHistoryId = state.currentHistoryId || null;
  offlineQueue = state.offlineQueue || [];
  emailLabelMap = new Map(state.emailLabelMap || []);

  // One-time sanitization: Deduplicate and sort by timestamp
  const uniqueDataset = [];
  const seenIds = new Set();
  (state.trainingDataset || []).forEach(d => {
    if (d.messageId && !seenIds.has(d.messageId)) {
      seenIds.add(d.messageId);
      uniqueDataset.push(d);
    }
  });
  trainingDataset = uniqueDataset.sort((a,b) => (a.timestamp || 0) - (b.timestamp || 0));

  chrome.storage.sync.get({ settings }, sync => {
    if (sync.settings) settings = { ...settings, ...sync.settings };
  });

  chrome.alarms.create("syncGmail", { periodInMinutes: 1 });
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "syncGmail" && settings.gmailApiEnabled) {
    if (offlineQueue.length > 0) processOfflineQueue().catch(e => console.warn("offline queue err", e.message));
    else fetchGmailEmails(false).catch(e => console.warn("Auto fetch err:", e.message));
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
    initPromise.then(() => handlePredict(msg)).then(sendResponse);
    return true; // async
  }
  if (msg.type === "APPLY_LABEL") {
    initPromise.then(() => handleApplyLabel(msg)).then(sendResponse);
    return true;
  }
  if (msg.type === "SAVE_SETTINGS") {
    initPromise.then(() => {
      chrome.storage.sync.set({ settings: msg.settings });
      settings = msg.settings;
      sendResponse({ success: true });
    });
    return true;
  }
  if (msg.type === "FETCH_GMAIL") {
    initPromise.then(() => fetchGmailEmails(true)).then(() => sendResponse({ success: true })).catch(e => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === "GET_STATS") {
    initPromise.then(() => {
      const uniqueLabels = new Set();
      Object.keys(centroids).forEach(l => uniqueLabels.add(l));
      Array.from(emailLabelMap.values()).forEach(v => {
        if(v && v.label && v.label !== "AUTO") uniqueLabels.add(v.label);
      });
      trainingDataset.forEach(d => {
        if(d && d.label && d.label !== "AUTO") uniqueLabels.add(d.label);
      });

      const sortedLabels = Array.from(uniqueLabels).sort((a, b) => a.localeCompare(b));
      sendResponse({ samples: trainingDataset.length, vocab: vocabulary.length, labels: sortedLabels.join(", "), queue: offlineQueue.length });
    });
    return true;
  }
});

async function handlePredict(msg) {
  const key = normalize(msg.sender + "::" + msg.subject);
  let result;
  if (emailLabelMap.has(key)) {
     result = emailLabelMap.get(key);
     
     // Retroactively guarantee the graduation flag checks out on loaded cache entries!
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
     // Uses memory objects built by IDB/Init, now passes snippet payload explicitly
     result = await predictLabel(msg.sender, msg.subject, msg.snippet || "", settings);
     
     // Store or Heal the message metadata
     const existingIndex = trainingDataset.findIndex(d => d.messageId === msg.messageId);
     if (existingIndex !== -1) {
       // HEALING logic: Update missing date OR upgrade 'AUTO' to actual prediction
       let changed = false;
       if (!trainingDataset[existingIndex].sentDate && msg.sentDate) {
         trainingDataset[existingIndex].sentDate = msg.sentDate;
         changed = true;
       }
       if (trainingDataset[existingIndex].label === "AUTO" && result.label && result.label !== "AUTO") {
         trainingDataset[existingIndex].label = result.label;
         changed = true;
       }
       if (changed) saveStoreData(["dataset"]);
     } else {
       // NEW record
       trainingDataset.push({
         messageId: msg.messageId,
         sender: msg.sender,
         subject: msg.subject,
         snippet: msg.snippet || "",
         isUnread: msg.isUnread || false,
         label: result.label || "AUTO",
         timestamp: Date.now(),
         sentDate: msg.sentDate || new Date().toLocaleString(),
         source: "gmail-predict"
       });
       if (trainingDataset.length > MAX_DATASET) trainingDataset.shift();
       saveStoreData(["dataset"]);
     }

     emailLabelMap.set(key, result);
     saveStoreData(["emailLabelMap"]);
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

  if (trainingDataset.length > MAX_DATASET) trainingDataset.shift();
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
  if (keys.includes("historyId")) promises.push(idb.set("currentHistoryId", currentHistoryId));

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
      if (chrome.runtime.lastError || !token) {
        return reject(new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : "No token returned"));
      }
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

function parseGmailDate(dateStr) {
  if (!dateStr) return Date.now();
  // Strip day of week if present "Fri, 12 Apr..."
  const cleanDate = dateStr.replace(/^[A-Za-z]{3},\s+/, "");
  const d = new Date(cleanDate);
  return isNaN(d.getTime()) ? Date.now() : d.getTime();
}

async function fetchGmailEmails(interactive = false) {
  if (!accessToken) {
    try {
      await authorizeGmail(interactive);
    } catch (e) {
      if (!interactive) return; // fail silently in background mode
      throw e;
    }
  }

  try {
    if (!currentHistoryId) {
      // Establish fresh historyId baseline and fetch few latest
      const pRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { Authorization: `Bearer ${accessToken}` } });
      if (pRes.status === 401) {
        await new Promise(r => chrome.identity.removeCachedAuthToken({token: accessToken}, r));
        accessToken = null;
        return fetchGmailEmails(interactive);
      }
      if (!pRes.ok) return;
      const pData = await pRes.json();
      currentHistoryId = pData.historyId;
      saveStoreData(["historyId"]);

      // Fetch latest messages with pagination (limit to 500 for baseline)
      let allMessages = [];
      let pageToken = null;
      do {
        const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
        url.searchParams.set("maxResults", "250");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        
        const mRes = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
        const mData = await mRes.json();
        if (mData.messages) allMessages.push(...mData.messages);
        pageToken = mData.nextPageToken;
      } while (pageToken && allMessages.length < 500);

      // CRITICAL: Reverse to process OLD-TO-NEW so the array ends with newest and shift() removes oldest
      for (const m of allMessages.reverse()) {
        if (!offlineQueue.includes(m.id)) offlineQueue.push(m.id);
      }
    } else {
      // Delta pull with pagination
      let pageToken = null;
      do {
        const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/history");
        url.searchParams.set("startHistoryId", currentHistoryId);
        url.searchParams.set("historyTypes", "messageAdded");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        
        const hRes = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
        if (hRes.status === 401) {
          await new Promise(r => chrome.identity.removeCachedAuthToken({token: accessToken}, r));
          accessToken = null;
          return fetchGmailEmails(interactive);
        }
        if (hRes.status === 404) {
          currentHistoryId = null; // Stale history, reset
          return fetchGmailEmails(interactive);
        }
        
        if (!hRes.ok) break;
        const hData = await hRes.json();
        
        // Add new history messages to queue
        const batch = [];
        for (const record of hData.history || []) {
          for (const msgAdded of record.messagesAdded || []) {
             batch.push(msgAdded.message.id);
          }
        }
        // History is naturally chronological (oldest to newest)
        for (const mid of batch) {
          if (!offlineQueue.includes(mid)) offlineQueue.push(mid);
        }

        currentHistoryId = hData.historyId || currentHistoryId;
        pageToken = hData.nextPageToken;
      } while (pageToken);
      
      saveStoreData(["historyId"]);
    }

    if (offlineQueue.length > 0) await processOfflineQueue();
  } catch (err) {
    if (interactive) throw err;
  }
}

async function processOfflineQueue() {
  while (offlineQueue.length) {
    const id = offlineQueue.shift();
    try {
      const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, 
        { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) throw new Error("Message fetch fail");
      
      const isDuplicate = trainingDataset.some(d => d.messageId === id);
      if (isDuplicate) continue;

      const msgData = await res.json();
      const headersObj = Object.fromEntries(msgData.payload.headers.map(h => [h.name, h.value]));
      
      const senderDecoded = decodeMime(headersObj.From || "");
      const subjectDecoded = decodeMime(headersObj.Subject || "");
      const dateHeader = headersObj.Date || "";
      const snippet = msgData.snippet || "";
      const isUnread = msgData.labelIds ? msgData.labelIds.includes("UNREAD") : false;

      trainingDataset.push({
        messageId: id,
        sender: senderDecoded,
        subject: subjectDecoded,
        snippet: snippet,
        isUnread: isUnread,
        label: "AUTO", 
        timestamp: Number(msgData.internalDate) || Date.now(), 
        sentDate: dateHeader,
        source: "gmail-auto"
      });
      if (trainingDataset.length > MAX_DATASET) trainingDataset.shift(); // Added global truncation check

      if (settings.autoApply) {
        const prediction = await predictLabel(senderDecoded, subjectDecoded, snippet, settings);
        if (prediction && prediction.label && prediction.label !== "AUTO" && prediction.isGraduated) {
          applyLabelToMessageId(id, prediction.label);
        }
      }
      saveStoreDataDebounced(["dataset", "queue"]);
    } catch (err) {
      offlineQueue.unshift(id);
      break;
    }
  }
  if(trainingDataset.length > 0) triggerOffscreenRebuild();
}
