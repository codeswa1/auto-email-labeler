const sliders = ["minShow", "minApply", "minArchive"];

chrome.storage.local.get({ globalRules: {} }, res => {
  sliders.forEach(id => {
    const val = res.globalRules[id] ?? 0.5;
    document.getElementById(id).value = val;
    document.getElementById(id + "Val").textContent = val.toFixed(2);
  });
});

sliders.forEach(id => {
  document.getElementById(id).addEventListener("input", e => {
    const value = parseFloat(e.target.value);
    document.getElementById(id + "Val").textContent = value.toFixed(2);

    chrome.storage.local.get({ globalRules: {} }, res => {
      res.globalRules[id] = value;
      chrome.storage.local.set({ globalRules: res.globalRules });
    });
  });
});
