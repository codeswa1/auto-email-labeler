const DEFAULT_SETTINGS = {
  autoApply: true, autoLearn: true, senderBoost: true,
  gmailApiEnabled: false
};

let settings = { ...DEFAULT_SETTINGS };

const els = {
  autoApply: document.getElementById("autoApply"),
  senderBoost: document.getElementById("senderBoost"),
  gmailApi: document.getElementById("gmailApi"),
  statsSamples: document.getElementById("statsSamples"),
  statsLabels: document.getElementById("statsLabels"),
  statsQueue: document.getElementById("statsQueue")
};

function saveSettings() {
  settings.autoApply = els.autoApply.checked;
  settings.senderBoost = els.senderBoost.checked;
  settings.gmailApiEnabled = els.gmailApi.checked;

  chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings });
}

chrome.storage.sync.get({ settings: DEFAULT_SETTINGS }, res => {
  settings = { ...DEFAULT_SETTINGS, ...res.settings };
  
  els.autoApply.checked = settings.autoApply;
  els.senderBoost.checked = settings.senderBoost;
  els.gmailApi.checked = settings.gmailApiEnabled;
});

["autoApply", "senderBoost", "gmailApi"].forEach(key => {
  els[key].addEventListener("change", () => {
    saveSettings();
    if (key === "gmailApi" && els.gmailApi.checked) {
      chrome.runtime.sendMessage({ type: "FETCH_GMAIL" });
    }
  });
});

chrome.runtime.sendMessage({ type: "GET_STATS" }, stats => {
  if (stats) {
    els.statsSamples.textContent = stats.samples || 0;
    els.statsLabels.textContent = stats.labels || "None";
    els.statsQueue.textContent = stats.queue || 0;
  }
});
