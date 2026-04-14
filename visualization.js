document.addEventListener('DOMContentLoaded', async () => {
  // --- Global Theme & Fallbacks ---
  Chart.defaults.color = '#1e293b';
  Chart.defaults.font.family = "'Inter', sans-serif";
  Chart.defaults.font.size = 12;

  const getStableColor = (str) => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    const h = (Math.abs(hash) * 137) % 360; 
    return `hsla(${h}, 70%, 55%, 0.85)`;
  };

  const getStableBorder = (str) => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    const h = (Math.abs(hash) * 137) % 360;
    return `hsla(${h}, 80%, 45%, 1)`;
  };

  // --- Advanced Smart Date Formatter ---
  const getNormalizedLabel = (email) => {
    if (!email || !email.label || email.label === "AUTO") return "Unclassified";
    return email.label;
  };

  const getLocalDateString = (email) => {
    const ts = Number(email.timestamp) || Date.now();
    const dateObj = new Date(ts);
    return dateObj.getFullYear() + '-' + String(dateObj.getMonth() + 1).padStart(2, '0') + '-' + String(dateObj.getDate()).padStart(2, '0');
  };

  const formatSmartDate = (email) => {

    let date;
    if (email.sentDate) {
      // Robustly handle Gmail's varying date formats
      let dateStr = email.sentDate.trim();
      // Remove day of week (e.g., 'Fri, ') if present at start
      dateStr = dateStr.replace(/^[A-Za-z]{3},\s+/, ""); 
      
      date = new Date(dateStr);
      
      // If parsing failed, try using the timestamp
      if (isNaN(date.getTime())) {
          date = new Date(email.timestamp);
      }
    } else {
      date = new Date(email.timestamp);
    }
    
    const now = new Date();
    const timeOptions = { hour: 'numeric', minute: '2-digit', hour12: true };
    
    // Check for "Today" and "Yesterday" based on actual date object comparison
    const isToday = now.toDateString() === date.toDateString();
    
    const yesterday = new Date();
    yesterday.setDate(now.getDate() - 1);
    const isYesterday = yesterday.toDateString() === date.toDateString();

    const tStr = date.toLocaleTimeString(undefined, timeOptions);

    if (isToday) {
      return `Today, ${tStr}`;
    } else if (isYesterday) {
      return `Yesterday, ${tStr}`;
    } else {
      // Older emails: Oct 10 2025 10:30 AM
      const dStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      return `${dStr} ${tStr}`;
    }
  };
 
    const matchesSearch = (item, query) => {
      const q = (query || "").toLowerCase().trim();
      if (!q) return true;

      const sender = (item.sender || "").toLowerCase();
      const subject = (item.subject || "").toLowerCase();
      const dateStr = (item.sentDate || "").toLowerCase();
      const smartDate = formatSmartDate(item).toLowerCase();
      
      // Keyword matching
      const emailDate = new Date(item.timestamp);
      const now = new Date();
      if (q === "today") return now.toDateString() === emailDate.toDateString();
      if (q === "yesterday") {
        const yesterdayDate = new Date();
        yesterdayDate.setDate(now.getDate() - 1);
        return yesterdayDate.toDateString() === emailDate.toDateString();
      }

      // Normal text match across all fields including the human-readable date
      return sender.includes(q) || 
             subject.includes(q) || 
             dateStr.includes(q) || 
             smartDate.includes(q);
    };

  if (typeof idb === 'undefined') {
    const statsRow = document.getElementById('statsRow');
    if (statsRow) statsRow.innerHTML = `<div class="stat-card">Error: idb_store.js failed to load.</div>`;
    return;
  }

  // --- Data Initialization ---
  const state = await idb.getAllState();
  const dataset = state.trainingDataset || [];
  
  // Identify all labels globally
  const rawLabels = [...new Set(dataset.map(d => getNormalizedLabel(d)))];

  const labelsList = rawLabels.sort((a, b) => {
    if (a === "Unclassified") return 1;
    if (b === "Unclassified") return -1;
    return a.localeCompare(b);
  });
  
  let autoSamples = 0;
  let labelCounts = {};
  dataset.forEach(item => {
    const label = getNormalizedLabel(item);
    if (label === "Unclassified") autoSamples++;
    labelCounts[label] = (labelCounts[label] || 0) + 1;
  });


  // Final sanity check for libraries
  const isD3Ready = typeof d3 !== 'undefined';
  const isChartReady = typeof Chart !== 'undefined';

  try { renderTopStats(dataset.length - autoSamples, autoSamples, labelsList.filter(l => l !== "Unclassified").length); } catch(e) { console.error("Stats fail", e); }
  
  const pieColors = labelsList.map(l => l === "Unclassified" ? "#94a3b8" : getStableColor(l));
  const pieBorders = labelsList.map(l => l === "Unclassified" ? "#64748b" : getStableBorder(l));

  // Render everything with library guards
  const clusterData = dataset.map(d => ({ ...d, label: d.label === "AUTO" ? "Unclassified" : d.label }));
  
  if (isD3Ready) {
    renderEmailCluster(clusterData, labelsList);
    renderLegend(labelsList, pieColors);
  } else {
    document.getElementById('clusterContainer').innerHTML = `<div style="padding:40px; color:var(--text-dim); text-align:center;">D3 Visualization Library failed to load. Using raw table only.</div>`;
  }

  if (isChartReady) {
    renderBarChart(labelsList, labelCounts, pieColors, pieBorders);
    renderLineChart(dataset, labelsList, pieColors, pieBorders);
  }

  renderActivityTable(dataset);
  initSearch(dataset);

  // --- Filter Logic ---
  const filterState = {
    cluster: { from: null, to: null },
    bar: { from: null, to: null },
    line: { from: null, to: null }
  };

  const applyFilter = (prefix) => {
    const fromInput = document.getElementById(`${prefix}DateFrom`);
    const toInput = document.getElementById(`${prefix}DateTo`);
    filterState[prefix].from = fromInput.value || null;
    filterState[prefix].to = toInput.value || null;
    updateCard(prefix);
  };

  const clearFilter = (prefix) => {
    document.getElementById(`${prefix}DateFrom`).value = '';
    document.getElementById(`${prefix}DateTo`).value = '';
    filterState[prefix].from = null;
    filterState[prefix].to = null;
    updateCard(prefix);
  };

  const toggleFilter = (prefix) => {
    const bar = document.getElementById(`${prefix}FilterBar`);
    const btn = document.getElementById(`${prefix}FilterBtn`);
    bar.classList.toggle('active');
    btn.classList.toggle('active');
  };

  const getFilteredDataset = (prefix) => {
    const range = filterState[prefix];
    if (!range.from && !range.to) return dataset;
    
    let fromTs = 0;
    if (range.from) {
      const [y, m, d] = range.from.split('-').map(Number);
      fromTs = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
    }

    let toTs = Infinity;
    if (range.to) {
      const [y, m, d] = range.to.split('-').map(Number);
      toTs = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
    }
    
    return dataset.filter(d => {
      const ts = Number(d.timestamp);
      return ts >= fromTs && ts <= toTs;
    });
  };

  const updateCard = (prefix) => {
    const filtered = getFilteredDataset(prefix);
    const labels = [...new Set(filtered.map(d => getNormalizedLabel(d)))].sort((a,b) => {
       if (a === "Unclassified") return 1;
       if (b === "Unclassified") return -1;
       return a.localeCompare(b);
    });
    
    const colors = labels.map(l => l === "Unclassified" ? "#94a3b8" : getStableColor(l));
    const borders = labels.map(l => l === "Unclassified" ? "#64748b" : getStableBorder(l));

    if (prefix === 'cluster') {
      if (isD3Ready) renderEmailCluster(filtered.map(d => ({ ...d, label: getNormalizedLabel(d) })), labels);
    } else if (prefix === 'bar') {
      const counts = {};
      filtered.forEach(item => { const l = getNormalizedLabel(item); counts[l] = (counts[l] || 0) + 1; });
      Chart.getChart("barChart")?.destroy();
      renderBarChart(labels, counts, colors, borders);
    } else if (prefix === 'line') {
      Chart.getChart("lineChart")?.destroy();
      renderLineChart(filtered, labels, colors, borders);
    }
  };

  // Setup listeners
  ['cluster', 'bar', 'line'].forEach(prefix => {
    document.getElementById(`${prefix}FilterBtn`).addEventListener('click', () => toggleFilter(prefix));
    document.getElementById(`${prefix}DateFrom`).addEventListener('change', () => applyFilter(prefix));
    document.getElementById(`${prefix}DateTo`).addEventListener('change', () => applyFilter(prefix));
    document.getElementById(`${prefix}FilterClear`).addEventListener('click', () => clearFilter(prefix));
  });


  // --- Live Update (Optimized) ---
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "DATA_UPDATED") {
      console.log("Intelligence broadcast received:", msg.keys);
      handleDataUpdate();
    }
  });

  async function handleDataUpdate() {
    try {
      const newState = await idb.getAllState();
      const newDataset = newState.trainingDataset || [];
      
      // Removed: bailout on same length to ensure label updates/graduations are visible.
      // We now perform a light content check if performance becomes an issue.
      
      console.log(`Dynamic Update: Dataset refreshed with ${newDataset.length} items.`);
      
      // Update the local reference
      dataset.length = 0;
      dataset.push(...newDataset);
      
      // Recalculate stats
      const rawLabels = [...new Set(dataset.map(d => getNormalizedLabel(d)))];
      const labelsList = rawLabels.sort((a,b) => {
        if (a === "Unclassified") return 1;
        if (b === "Unclassified") return -1;
        return a.localeCompare(b);
      });
      
      let autoSamples = 0;
      dataset.forEach(item => { if (getNormalizedLabel(item) === "Unclassified") autoSamples++; });
      
      // Partial UI Update
      renderTopStats(dataset.length - autoSamples, autoSamples, labelsList.filter(l => l !== "Unclassified").length);
      renderActivityTable(dataset, document.getElementById('emailSearch')?.value || '');
      
      // Update charts/clusters using their current filters
      if (isChartReady || isD3Ready) {
        ['cluster', 'bar', 'line'].forEach(updateCard);
      }
      
    } catch(e) { console.warn("Dynamic update failed", e); }
  }




  const drilldownModal = document.getElementById('drilldownModal');
  const closeBtn = document.getElementById('closeDrilldown');
  if (closeBtn) closeBtn.onclick = () => drilldownModal.classList.remove('active');

  // --- Render Helpers ---

  function renderLegend(labels, colors) {
    const legend = document.getElementById('clusterLegend');
    if (!legend) return;
    legend.innerHTML = labels.map((label, i) => `
      <div class="legend-item">
        <div class="legend-color" style="background: ${colors[i]}"></div>
        <span>${label}</span>
      </div>
    `).join('');
  }

  function renderTopStats(labeled, auto, unique) {
    const statsRow = document.getElementById('statsRow');
    if (!statsRow) return;
    statsRow.innerHTML = `
      <div class="stat-card">
        <div class="stat-value">${labeled}</div>
        <div class="stat-label">Analyzed Emails</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${auto}</div>
        <div class="stat-label">Pending Review</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${unique}</div>
        <div class="stat-label">Labels</div>
      </div>
    `;
  }

  function getInitials(sender) {
    if (!sender) return "??";
    const parts = sender.split(/[ <@.]+/).filter(p => p.length > 0);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return sender.substring(0, 2).toUpperCase();
  }

  function renderEmailCluster(data, labels) {
    const container = document.getElementById('clusterContainer');
    if (!container) return;
    if (typeof d3 === 'undefined') {
        container.innerHTML = `<div style="padding:40px; color:var(--text-dim); text-align:center;">D3 Visualization Library failed to load.</div>`;
        return;
    }
    
    try {
      if (data.length === 0) {
        container.innerHTML = `<div style="padding:100px; color:var(--text-dim); text-align:center; font-family:var(--font-display); font-weight:600;">No emails found in this date range.</div>`;
        return;
      }
      // Density Guard: Only render the latest 5,000 for the simulation to keep Gmail fluid
      const MAX_VISUAL_NODES = 5000;
      const visualData = data.length > MAX_VISUAL_NODES ? data.slice(-MAX_VISUAL_NODES) : data;
      
      container.innerHTML = '';
      const width = container.clientWidth;
      const height = container.clientHeight || 400;

      const svg = d3.select("#clusterContainer").append("svg")
        .attr("width", "100%").attr("height", "100%").attr("viewBox", [0, 0, width, height]);

      const g = svg.append("g");
      svg.call(d3.zoom().scaleExtent([0.5, 5]).on("zoom", (e) => g.attr("transform", e.transform)));

      const centers = {};
      const radius = Math.min(width, height) * 0.35;
      labels.forEach((l, i) => {
        const angle = (i / labels.length) * 2 * Math.PI;
        centers[l] = { x: width/2 + radius*Math.cos(angle), y: height/2 + radius*Math.sin(angle) };
      });

      const nodes = visualData.map(d => ({
        ...d, radius: 17, initials: getInitials(d.sender),
        x: centers[d.label].x + (Math.random() - 0.5) * 80,
        y: centers[d.label].y + (Math.random() - 0.5) * 80
      }));

      const simulation = d3.forceSimulation(nodes)
        .force("x", d3.forceX(d => centers[d.label].x).strength(0.55))
        .force("y", d3.forceY(d => centers[d.label].y).strength(0.55))
        .force("collide", d3.forceCollide(20))
        .force("charge", d3.forceManyBody().strength(-35))
        .velocityDecay(0.4)
        .on("tick", () => nodeGroups.attr("transform", d => `translate(${d.x},${d.y})`));

      const nodeGroups = g.selectAll(".cluster-node-group").data(nodes).enter().append("g")
        .attr("class", "cluster-node-group").on("click", (e, d) => showEmailDetail(d));

      nodeGroups.append("circle")
        .attr("r", d => d.radius)
        .attr("fill", d => getStableColor(d.label))
        .attr("stroke", d => d.isUnread ? "#ffffff" : "rgba(255,255,255,0.3)")
        .attr("stroke-width", d => d.isUnread ? 3 : 1)
        .style("filter", d => d.isUnread ? "drop-shadow(0 0 5px rgba(255,255,255,0.6))" : "none");

      nodeGroups.append("text").attr("class", "node-text").text(d => d.initials).attr("font-size", "9px").attr("fill", "white")
        .style("pointer-events", "none").attr("text-anchor", "middle").attr("dy", ".35em");

      nodeGroups.append("title").text(d => `Origin: ${d.sender}\nSubject: ${d.subject}\nDate: ${formatSmartDate(d)}`);

      nodeGroups.call(d3.drag()
        .on("start", (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })

      .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on("end", (e, d) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }));
    } catch(e) {
      console.error("Cluster render failed:", e);
      container.innerHTML = `<div style="padding:40px; color:var(--text-dim); text-align:center;">Failed to generate neural cluster. See console for details.</div>`;
    }
  }


  function renderStandardModalTable(emails, labelName) {
    const drilldownModal = document.getElementById('drilldownModal');
    const title = document.getElementById('drilldownTitle');
    const tbody = document.getElementById('drilldownBody');
    const thead = document.querySelector('#drilldownModal thead');

    title.textContent = labelName;
    if (thead) thead.innerHTML = `<tr><th style="width:25%">Sender</th><th style="width:50%">Subject</th><th style="width:25%">Received</th></tr>`;

    // Sort Descending (Newest First)
    const sortedEmails = [...emails].sort((a, b) => b.timestamp - a.timestamp);

    tbody.innerHTML = sortedEmails.map(email => `
      <tr>
        <td style="font-weight: 500; font-size: 0.9rem; color: var(--accent-primary);">${email.sender}</td>
        <td class="subject-cell">${email.subject}</td>
        <td style="color: var(--text-dim); font-size: 0.85rem;">${formatSmartDate(email)}</td>
      </tr>
    `).join('');

    drilldownModal.classList.add('active');
  }

  function showEmailDetail(email) {
    renderStandardModalTable([email], "Intelligence Detail");
  }

  function handleChartClick(event, activeElements) {
    const chart = event.chart;
    let clickedVal = null;
    let isDate = chart.canvas.id === 'lineChart';

    if (activeElements && activeElements.length > 0) {
      // Clicked a specific data point
      const index = activeElements[0].index;
      clickedVal = chart.data.labels[index];
    } else {
      // User clicked on the "base" (X-axis labels)
      const points = chart.getElementsAtEventForMode(event.native, 'index', { intersect: false }, true);
      if (points.length > 0) {
        clickedVal = chart.data.labels[points[0].index];
      }
    }

    if (!clickedVal) return;

    if (isDate) {
      const matchingEmails = dataset.filter(item => getLocalDateString(item) === clickedVal);
      renderStandardModalTable(matchingEmails, `Drilldown: ${clickedVal} (${matchingEmails.length} emails)`);
    } else {
      const matchingEmails = dataset.filter(d => getNormalizedLabel(d) === clickedVal);
      renderStandardModalTable(matchingEmails, `Category: ${clickedVal} (${matchingEmails.length} items)`);
    }
  }



  function renderBarChart(labels, counts, colors, borders) {
    const ctx = document.getElementById('barChart')?.getContext('2d');
    if (!ctx) return;
    if (typeof Chart === 'undefined') return;
    
    try {
      if (labels.length === 0) {
        const wrapper = document.querySelector('#barChart').parentElement;
        wrapper.innerHTML = `<canvas id="barChart"></canvas><div style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:var(--text-dim); font-weight:600;">No data for this range</div>`;
        return;
      }
      new Chart(ctx, {
        type: 'bar',
        data: {
          labels,
          datasets: [{ label: 'Quantity', data: labels.map(l => counts[l] || 0), backgroundColor: colors, borderColor: borders, borderWidth: 1.5, borderRadius: 6 }]
        },
        options: {
          responsive: true, maintainAspectRatio: false, onClick: handleChartClick,
          plugins: { legend: { display: false } },
          scales: { y: { beginAtZero: true }, x: { grid: { display: false } } }
        }
      });
    } catch(e) { console.error("Bar chart render failed:", e); }
  }


  function renderLineChart(dataset, labels, colors, borders) {
    const ctx = document.getElementById('lineChart')?.getContext('2d');
    if (!ctx) return;
    if (typeof Chart === 'undefined') return;

    try {
      const timeGroups = {};
      dataset.forEach(item => {
        const d = getLocalDateString(item);
        timeGroups[d] ??= {};
        const label = getNormalizedLabel(item);
        timeGroups[d][label] = (timeGroups[d][label] || 0) + 1;
      });

      if (Object.keys(timeGroups).length === 0) {
        const wrapper = document.querySelector('#lineChart').parentElement;
        wrapper.innerHTML = `<canvas id="lineChart"></canvas><div style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:var(--text-dim); font-weight:600;">No temporal data for this range</div>`;
        return;
      }


      const sortedDates = Object.keys(timeGroups).sort();
      const lineSets = labels.map((label, idx) => ({
        label, data: sortedDates.map(d => timeGroups[d][label] || 0),
        borderColor: borders[idx], backgroundColor: colors[idx].replace('0.85)', '0.08)'),
        borderWidth: 2, tension: 0.4, fill: true, pointRadius: 2.5
      }));
      new Chart(ctx, {
        type: 'line', 
        data: { labels: sortedDates, datasets: lineSets },
        options: { 
          responsive: true, 
          maintainAspectRatio: false, 
          onClick: handleChartClick,
          interaction: {
            mode: 'index',
            intersect: false,
          },
          plugins: {
            tooltip: {
              position: 'nearest',
              filter: function(tooltipItem) {
                // Reduces clutter: only show categories that actually have emails on this date
                return tooltipItem.raw > 0;
              },
              callbacks: {
                label: function(context) {
                  const val = context.raw || 0;
                  return ` ${context.dataset.label}: ${val} emails`;
                }
              }
            }
          },
          scales: {
            y: { beginAtZero: true, ticks: { precision: 0 } }
          }

        }
      });
    } catch(e) { console.error("Line chart render failed:", e); }

  }


  function renderActivityTable(data, filterText = '') {
    const body = document.getElementById('activityBody');
    const badge = document.getElementById('resultCount');
    if (!body) return;
    const filtered = data.filter(d => matchesSearch(d, filterText))
      .sort((a,b) => b.timestamp - a.timestamp);
    if (badge) badge.textContent = `${filtered.length} items`;
    body.innerHTML = filtered.map(email => `
      <tr>
        <td><span class="status-pill ${email.isUnread ? 'unread' : 'read'}">${email.isUnread ? 'Unread' : 'Read'}</span></td>
        <td style="font-weight: 700; color: var(--accent-primary);">${email.sender}</td>
        <td class="subject-cell">${email.subject}</td>
        <td style="opacity: 0.8; font-size: 0.85rem; font-weight: 500;">${formatSmartDate(email)}</td>
      </tr>
    `).join('');
  }

  function initSearch(data) {
    const input = document.getElementById('emailSearch');
    const dd = document.getElementById('searchResultsDropdown');
    if (!input || !dd) return;
    input.addEventListener('input', (e) => {
      const v = e.target.value;
      renderActivityTable(data, v);
      if (!v.trim()) return dd.classList.remove('active');
      const matches = data.filter(d => matchesSearch(d, v))
        .sort((a,b) => b.timestamp - a.timestamp).slice(0, 10);
      if (matches.length > 0) {
        dd.innerHTML = matches.map(email => `
          <div class="search-item" data-id="${email.messageId || email.timestamp}">
            <div class="search-item-header">
              <span class="search-item-sender">${email.sender}</span>
              <span class="search-item-date">${formatSmartDate(email)}</span>
            </div>
            <div class="search-item-subject">${email.subject}</div>
          </div>
        `).join('');
        dd.querySelectorAll('.search-item').forEach(i => i.onclick = () => {
          const mid = i.dataset.id;
          const target = data.find(d => (d.messageId||d.timestamp.toString()) === mid);
          if (target) showEmailDetail(target);
          dd.classList.remove('active');
        });
        dd.classList.add('active');
      } else dd.classList.remove('active');
    });
    document.addEventListener('click', (e) => { if (!input.contains(e.target) && !dd.contains(e.target)) dd.classList.remove('active'); });
  }
});
