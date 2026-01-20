console.log("Background service worker active");

// ==============================
// CONFIG
// ==============================
const CLIENT_ID =
  "590450940640-9l860kqpraoe5rlphopnusc6io4f5oju.apps.googleusercontent.com";

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const REDIRECT_URI = `https://${chrome.runtime.id}.chromiumapp.org/`;
const FETCH_BATCH_SIZE = 50;

// Service-worker safe state (non-persistent)
let accessToken = null;
let offlineQueue = [];
let lastMessageId = null;

// ==============================
// INIT (restore persisted state)
// ==============================
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(["lastMessageId"], res => {
    lastMessageId = res.lastMessageId || null;
  });
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("Extension installed");
});

// ==============================
// AUTH
// ==============================
function authorizeGmail() {
  return new Promise((resolve, reject) => {
    const authUrl =
      `https://accounts.google.com/o/oauth2/v2/auth` +
      `?client_id=${CLIENT_ID}` +
      `&response_type=token` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&scope=${encodeURIComponent(SCOPES.join(" "))}` +
      `&prompt=consent`;

    chrome.identity.launchWebAuthFlow(
      { url: authUrl, interactive: true },
      redirectUrl => {
        if (chrome.runtime.lastError || !redirectUrl) {
          return reject(chrome.runtime.lastError || new Error("Auth failed"));
        }

        const match = redirectUrl.match(/access_token=([^&]+)/);
        if (!match) return reject(new Error("Access token not found"));

        accessToken = match[1];
        resolve(accessToken);
      }
    );
  });
}

// ==============================
// FETCH GMAIL MESSAGES
// ==============================
async function fetchGmailEmails() {
  if (!accessToken) await authorizeGmail();

  const headers = { Authorization: `Bearer ${accessToken}` };
  let nextPageToken = null;
  let fetchedCount = 0;

  do {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.searchParams.set("maxResults", FETCH_BATCH_SIZE);
    if (nextPageToken) url.searchParams.set("pageToken", nextPageToken);

    const res = await fetch(url.toString(), { headers });
    if (!res.ok) throw new Error("Gmail list fetch failed");

    const data = await res.json();
    nextPageToken = data.nextPageToken;

    for (const m of data.messages || []) {
      if (lastMessageId && m.id === lastMessageId) break;
      offlineQueue.push(m.id);
      fetchedCount++;
    }

    await processOfflineQueue();
  } while (nextPageToken && fetchedCount < 200);

  console.log("Gmail fetch completed:", fetchedCount);
}

// ==============================
// PROCESS QUEUE
// ==============================
async function processOfflineQueue() {
  while (offlineQueue.length) {
    const id = offlineQueue.shift();

    try {
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      if (!res.ok) throw new Error("Message fetch failed");

      const msgData = await res.json();
      const headersObj = Object.fromEntries(
        msgData.payload.headers.map(h => [h.name, h.value])
      );

      const sender = headersObj.From || "";
      const subject = headersObj.Subject || "";

      chrome.storage.local.get({ dataset: [] }, res => {
        const dataset = res.dataset;
        dataset.push({
          sender,
          subject,
          label: "AUTO",
          timestamp: Date.now(),
          source: "gmail-auto"
        });
        chrome.storage.local.set({ dataset });
      });

      lastMessageId = id;
      chrome.storage.local.set({ lastMessageId });

    } catch (err) {
      console.warn("Message fetch failed, retrying later");
      offlineQueue.unshift(id);
      break;
    }
  }
}

// ==============================
// AUTO-LEARN FROM THREAD
// ==============================
async function learnFromThread(threadId) {
  if (!accessToken) await authorizeGmail();

  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!res.ok) return;

  const thread = await res.json();
  const msg = thread.messages?.[0];
  if (!msg) return;

  const headersObj = Object.fromEntries(
    msg.payload.headers.map(h => [h.name, h.value])
  );

  const sender = headersObj.From || "";
  const subject = headersObj.Subject || "";

  const userLabels = (msg.labelIds || []).filter(l =>
    l.startsWith("Label_")
  );

  if (!userLabels.length) return;

  chrome.storage.local.get({ dataset: [] }, res => {
    const dataset = res.dataset;
    userLabels.forEach(labelId => {
      dataset.push({
        sender,
        subject,
        label: labelId.replace("Label_", ""),
        timestamp: Date.now(),
        source: "gmail-auto"
      });
    });
    chrome.storage.local.set({ dataset });
  });
}

// ==============================
// MESSAGE LISTENER
// ==============================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "PING") {
    console.log("Background received PING");
    sendResponse({ status: "OK" });
  }

  if (msg.type === "AUTHORIZE_GMAIL") {
    authorizeGmail()
      .then(token => sendResponse({ token }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === "FETCH_GMAIL") {
    fetchGmailEmails()
      .then(() => sendResponse({ success: true }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === "AUTO_LEARN_THREAD") {
    learnFromThread(msg.threadId);
  }
});

// ==============================
// ONLINE RESUME (SAFE)
// ==============================
self.addEventListener("online", () => {
  if (offlineQueue.length > 0) {
    console.log("Online again — resuming fetch");
    fetchGmailEmails();
  }
});
