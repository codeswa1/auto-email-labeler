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

      sendResponse({ samples: trainingDataset.length, vocab: vocabulary.length, labels: Array.from(uniqueLabels).join(", "), queue: offlineQueue.length });
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
     
     // Store the message metadata in the dataset for the dashboard (Avoid duplicates!)
     const exists = trainingDataset.some(d => d.messageId === msg.messageId);
     if (!exists) {
       trainingDataset.push({
         messageId: msg.messageId,
         sender: msg.sender,
         subject: msg.subject,
         snippet: msg.snippet || "",
         isUnread: msg.isUnread || false,
         label: "AUTO",
         timestamp: Date.now(),
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
    timestamp: Date.now(), 
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

      const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
      url.searchParams.set("maxResults", "50"); // Increased baseline for complete account mapping
      // Removed "is:unread" to fetch from all folders and labels
      const mRes = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
      const mData = await mRes.json();
      for (const m of mData.messages || []) offlineQueue.push(m.id);
    } else {
      // Delta pull
      const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/history");
      url.searchParams.set("startHistoryId", currentHistoryId);
      url.searchParams.set("historyTypes", "messageAdded");
      
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
      
      if (!hRes.ok) return;
      const hData = await hRes.json();
      currentHistoryId = hData.historyId || currentHistoryId;
      saveStoreData(["historyId"]);

      for (const record of hData.history || []) {
        for (const msgAdded of record.messagesAdded || []) {
          if (!offlineQueue.includes(msgAdded.message.id)) {
             offlineQueue.push(msgAdded.message.id);
          }
        }
      }
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
      const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, 
        { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) throw new Error("Message fetch fail");
      
      const msgData = await res.json();
      const headersObj = Object.fromEntries(msgData.payload.headers.map(h => [h.name, h.value]));
      
      const senderDecoded = decodeMime(headersObj.From || "");
      const subjectDecoded = decodeMime(headersObj.Subject || "");
      const snippet = msgData.snippet || "";
      const isUnread = msgData.labelIds ? msgData.labelIds.includes("UNREAD") : false;

      trainingDataset.push({
        messageId: id,
        sender: senderDecoded,
        subject: subjectDecoded,
        snippet: snippet,
        isUnread: isUnread,
        label: "AUTO", timestamp: Date.now(), source: "gmail-auto"
      });
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
