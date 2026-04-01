// offscreen.js

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "OFFSCREEN_REBUILD_MODEL") {
    console.log("Offscreen processing ML rebuild...");
    runRebuild(msg.settings).then(() => sendResponse({ success: true }));
    return true; // Keep message channel open for async response
  }
});

async function runRebuild(settings) {
  const state = await idb.getAllState();
  
  // Load state into ml_model's global scope
  window.trainingDataset = state.trainingDataset;
  window.vocabulary = state.vocabulary;
  window.idf = state.idf;
  window.centroids = state.centroids;

  // Run the math function
  await rebuildModel(settings || {}); 

  // Save the newly calculated matrices back to IDB
  await idb.set('vocabulary', window.vocabulary);
  await idb.set('idf', window.idf);
  await idb.set('centroids', window.centroids);
  if (settings && settings.ollamaEnabled) {
    await idb.set('trainingDataset', window.trainingDataset); // Persist cached vectors
  }
}
