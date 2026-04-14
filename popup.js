const els = {
  statsSamples: document.getElementById("statsSamples"),
  statsLabels: document.getElementById("statsLabels"),
  systemStatus: document.getElementById("systemStatus"),
  openDashboard: document.getElementById("openDashboard")
};

function updateStats() {
  chrome.runtime.sendMessage({ type: "GET_STATS" }, (response) => {
    if (chrome.runtime.lastError) {
      els.systemStatus.textContent = "Error: Connection lost";
      els.systemStatus.style.color = "#d93025";
      return;
    }
    if (response) {
      els.statsSamples.textContent = response.samples || 0;
      els.statsLabels.textContent = response.labels || "None";
    }
  });
}

// Initial stats fetch
updateStats();
setInterval(updateStats, 2000);

els.openDashboard.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" });
});

