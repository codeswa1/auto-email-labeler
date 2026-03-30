// ml_model.js
// Extracted TF-IDF Model rebuilding and vectorization logic

var MAX_DATASET = 2000;
var trainingDataset = [];
var senderMemory = {};
var vocabulary = [];
var idf = {};
var centroids = {};
var debugLog = [];

function normalize(text){ return text?text.toLowerCase().replace(/[^a-z0-9 ]+/g," ").trim():""; }
function tokenize(text){ return normalize(text).split(" ").filter(Boolean); }
function cosineSimilarity(a,b){
  let dot=0,na=0,nb=0;
  for(let i=0;i<a.length;i++){
    dot+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i];
  } 
  return na&&nb?dot/(Math.sqrt(na)*Math.sqrt(nb)):0;
}

function buildVocabulary(){
  const set = new Set();
  trainingDataset.forEach(d => tokenize(d.sender+" "+d.subject).forEach(t=>set.add(t)));
  vocabulary = Array.from(set);
}

function computeIDF(){
  idf = {};
  vocabulary.forEach(term => {
    let count=0;
    trainingDataset.forEach(d=>{ if(tokenize(d.sender+" "+d.subject).includes(term)) count++; });
    idf[term] = Math.log(trainingDataset.length / (1+count));
  });
}

function vectorize(text){
  const tokens = tokenize(text);
  return vocabulary.map(t => tokens.includes(t)?idf[t]||0:0);
}

function rebuildCentroids(){
  centroids = {};
  const grouped = {};
  trainingDataset.forEach(d => { grouped[d.label] ??= []; grouped[d.label].push(vectorize(d.sender+" "+d.subject)); });
  Object.entries(grouped).forEach(([label, vectors])=>{
    const avg = new Array(vocabulary.length).fill(0);
    vectors.forEach(v=>v.forEach((x,i)=>avg[i]+=x/vectors.length));
    centroids[label] = avg;
  });
}

function rebuildModel(){
  buildVocabulary();
  computeIDF();
  rebuildCentroids();
}

function predictLabel(sender, subject, senderBoostEnabled){
  const senderKey = normalize(sender);
  const vec = vectorize(sender+" "+subject);
  let best = { label: "AUTO", confidence: 0 };
  Object.entries(centroids).forEach(([label, centroid])=>{
    let score = cosineSimilarity(vec, centroid);
    if(senderBoostEnabled && senderMemory[senderKey]?.[label]) score += 0.15;
    if(score > best.confidence) best = { label, confidence: Math.min(score,1) };
  });
  debugLog.push({ sender, subject, ...best });
  if(debugLog.length>30) debugLog.shift();
  return best;
}

let rebuildDebounce;
function rebuildModelDebounced(){
  clearTimeout(rebuildDebounce);
  rebuildDebounce = setTimeout(() => {
    rebuildModel();
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.set({ centroids, vocabulary, idf });
    }
  }, 2000);
}

let storageDebounce;
function saveDataDebounced() {
  clearTimeout(storageDebounce);
  storageDebounce = setTimeout(() => {
    const attemptSave = (retryCount = 0) => {
      try {
        if (emailLabelMap.size > 5000) {
          const entries = Array.from(emailLabelMap.entries());
          emailLabelMap = new Map(entries.slice(entries.length - 2500));
        }

        chrome.storage.local.set({ 
          dataset: trainingDataset, 
          senderMemory: senderMemory, 
          emailLabelMap: Array.from(emailLabelMap.entries()) 
        });
      } catch (e) {
        if(retryCount<3) setTimeout(()=>attemptSave(retryCount+1),500);
      }
    };
    attemptSave();
  }, 1000);
}
