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
  const formatSmartDate = (email) => {
    let date;
    if (email.sentDate) {
      // Clean Gmail's title string (e.g., remove day of week like 'Fri, ')
      let dateStr = email.sentDate.replace(/^[A-Z][a-z]{2},\s/, ""); 
      date = new Date(dateStr);
      // Hard check for validity
      if (isNaN(date.getTime())) {
          // One more try: just use the raw string if it looks like a time (e.g. "4:30 PM")
          if (email.sentDate.includes(":") && email.sentDate.length < 10) return email.sentDate;
          date = new Date(email.timestamp); // Emergency fallback
      }
    } else {
      date = new Date(email.timestamp);
    }
    
    const now = new Date();
    const timeOptions = { hour: 'numeric', minute: '2-digit', hour12: true };
    
    // SPECIAL CASE: Literal words from Gmail
    const lowerDate = email.sentDate ? email.sentDate.toLowerCase() : "";
    const isTodayText = lowerDate.includes("today") || (email.sentDate && email.sentDate.includes(":") && email.sentDate.length < 10);
    const isYesterdayText = lowerDate.includes("yesterday");

    if (isTodayText) {
      const tStr = date.toLocaleTimeString(undefined, timeOptions);
      return `Today, ${tStr}`;
    } else if (isYesterdayText) {
      const tStr = date.toLocaleTimeString(undefined, timeOptions);
      return `Yesterday, ${tStr}`;
    }
    
    // Standard logic
    const isToday = now.toDateString() === date.toDateString();
    
    const yesterday = new Date();
    yesterday.setDate(now.getDate() - 1);
    const isYesterday = yesterday.toDateString() === date.toDateString();

    if (isToday) {
      const tStr = date.toLocaleTimeString(undefined, timeOptions);
      return `Today, ${tStr}`;
    } else if (isYesterday) {
      const tStr = date.toLocaleTimeString(undefined, timeOptions);
      return `Yesterday, ${tStr}`;
    } else {
      // Older emails: Oct 10 2025 10:30 AM
      const dStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      const tStr = date.toLocaleTimeString(undefined, timeOptions);
      return `${dStr} ${tStr}`;
    }
  };

  if (typeof idb === 'undefined') {
    const statsRow = document.getElementById('statsRow');
    if (statsRow) statsRow.innerHTML = `<div class="stat-card">Error: idb_store.js failed to load.</div>`;
    return;
  }

  // --- Data Initialization ---
  const state = await idb.getAllState();
  const dataset = state.trainingDataset || [];
  const labelsList = [...new Set(dataset.filter(d => d.label !== "AUTO").map(d => d.label))].sort();
  
  let autoSamples = 0;
  let labelCounts = {};
  dataset.forEach(item => {
    if (item.label === "AUTO") autoSamples++;
    else labelCounts[item.label] = (labelCounts[item.label] || 0) + 1;
  });

  renderTopStats(dataset.length - autoSamples, autoSamples, labelsList.length);
  const pieColors = labelsList.map(l => getStableColor(l));
  const pieBorders = labelsList.map(l => getStableBorder(l));

  renderEmailCluster(dataset.filter(d => d.label !== "AUTO"), labelsList);
  renderLegend(labelsList, pieColors);
  renderBarChart(labelsList, labelCounts, pieColors, pieBorders);
  renderLineChart(dataset, labelsList, pieColors, pieBorders);
  renderActivityTable(dataset);
  initSearch(dataset);

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
        <div class="stat-label">Neural Mapped</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${auto}</div>
        <div class="stat-label">Unclassified</div>
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

    const nodes = data.map(d => ({
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

    nodeGroups.append("circle").attr("r", d => d.radius).attr("fill", d => getStableColor(d.label))
      .attr("stroke", "rgba(255,255,255,0.8)").attr("stroke-width", 1.5);

    nodeGroups.append("text").attr("class", "node-text").text(d => d.initials).attr("font-size", "9px").attr("fill", "white")
      .style("pointer-events", "none").attr("text-anchor", "middle").attr("dy", ".35em");

    nodeGroups.append("title").text(d => `Origin: ${d.sender}\nSubject: ${d.subject}\nDate: ${formatSmartDate(d)}`);

    nodeGroups.call(d3.drag()
      .on("start", (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on("end", (e, d) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }));
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
    if (!activeElements || activeElements.length === 0) return;
    const index = activeElements[0].index;
    const clickedLabel = activeElements[0].element.$context.chart.data.labels[index];
    const matchingEmails = dataset.filter(d => d.label === clickedLabel);
    renderStandardModalTable(matchingEmails, `Category: ${clickedLabel} (${matchingEmails.length})`);
  }

  function renderBarChart(labels, counts, colors, borders) {
    const ctx = document.getElementById('barChart')?.getContext('2d');
    if (!ctx) return;
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
  }

  function renderLineChart(dataset, labels, colors, borders) {
    const ctx = document.getElementById('lineChart')?.getContext('2d');
    if (!ctx) return;
    const timeGroups = {};
    dataset.forEach(item => {
      const d = new Date(item.timestamp).toISOString().split('T')[0];
      timeGroups[d] ??= {};
      if (item.label !== "AUTO") timeGroups[d][item.label] = (timeGroups[d][item.label] || 0) + 1;
    });
    const sortedDates = Object.keys(timeGroups).sort();
    const lineSets = labels.map((label, idx) => ({
      label, data: sortedDates.map(d => timeGroups[d][label] || 0),
      borderColor: borders[idx], backgroundColor: colors[idx].replace('0.85)', '0.08)'),
      borderWidth: 2, tension: 0.4, fill: true, pointRadius: 2.5
    }));
    new Chart(ctx, {
      type: 'line', data: { labels: sortedDates, datasets: lineSets },
      options: { responsive: true, maintainAspectRatio: false, onClick: handleChartClick }
    });
  }

  function renderActivityTable(data, filterText = '') {
    const body = document.getElementById('activityBody');
    const badge = document.getElementById('resultCount');
    if (!body) return;
    const val = filterText.toLowerCase().trim();
    const filtered = data.filter(d => (d.sender||'').toLowerCase().includes(val) || (d.subject||'').toLowerCase().includes(val))
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
      const v = e.target.value.toLowerCase().trim();
      renderActivityTable(data, v);
      if (!v) return dd.classList.remove('active');
      const matches = data.filter(d => (d.sender||'').toLowerCase().includes(v) || (d.subject||'').toLowerCase().includes(v))
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
