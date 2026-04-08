document.addEventListener('DOMContentLoaded', async () => {
  Chart.defaults.color = '#94a3b8';
  Chart.defaults.font.family = "'Inter', sans-serif";

  // Quick fallback if extension context lacks IndexedDB connection instantly
  if (typeof idb === 'undefined') {
    document.getElementById('statsRow').innerHTML = `<div class="stat-card">Error: idb_store.js failed to load.</div>`;
    return;
  }

  // Load datasets directly from the local IndexedDB. 
  // No external fetching needed because this UI is served locally by the extension!
  const state = await idb.getAllState();
  const dataset = state.trainingDataset || [];
  const centroids = state.centroids || {};
  const vocab = state.vocabulary || [];

  // Data processing
  let autoSamples = 0;
  let labelCounts = {};

  dataset.forEach(item => {
    if (item.label === "AUTO") {
      autoSamples++;
    } else {
      labelCounts[item.label] = (labelCounts[item.label] || 0) + 1;
    }
  });

  const labels = Object.keys(labelCounts);
  const dataCounts = Object.values(labelCounts);
  const totalCustomLabels = labels.length;
  const labeledSamples = dataset.length - autoSamples;

  // Render top stats
  const statsHtml = `
    <div class="stat-card">
      <div class="stat-value">${labeledSamples}</div>
      <div class="stat-label">User Validated Emails</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${autoSamples}</div>
      <div class="stat-label">AUTO/Unlabeled</br>Emails</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${totalCustomLabels}</div>
      <div class="stat-label">Unique Learned</br>Labels</div>
    </div>
  `;
  document.getElementById('statsRow').innerHTML = statsHtml;

  // Generate a sweeping gradient color wheel using dynamically calculated HSL
  const generatePieColors = () => labels.map((_, i) => `hsla(${(i * 360) / Math.max(labels.length, 1)}, 85%, 65%, 0.9)`);
  const generatePieBorders = () => labels.map((_, i) => `hsla(${(i * 360) / Math.max(labels.length, 1)}, 85%, 55%, 1)`);
  const pieColors = generatePieColors();
  const pieBorders = generatePieBorders();

  const donutCtx = document.getElementById('donutChart').getContext('2d');
  
  // Drill-down Modal Variables
  const drilldownModal = document.getElementById('drilldownModal');
  const closeBtn = document.getElementById('closeDrilldown');
  const tbody = document.getElementById('drilldownBody');
  const title = document.getElementById('drilldownTitle');
  
  closeBtn.onclick = () => drilldownModal.classList.remove('active');
  
  function handleChartClick(event, activeElements) {
    if (!activeElements || activeElements.length === 0) return;
    const clickedLabel = labels[activeElements[0].index];
    const matchingEmails = dataset.filter(d => d.label === clickedLabel);
    
    title.textContent = `Emails in "${clickedLabel}" (${matchingEmails.length})`;
    tbody.innerHTML = ''; // clear previous
    
    matchingEmails.forEach(email => {
      const tr = document.createElement('tr');
      const d = new Date(email.timestamp);
      // Format as DD/MM/YY, HH:MM AM/PM
      const dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      
      tr.innerHTML = `
        <td style="font-weight: 500;">${email.sender}</td>
        <td style="opacity: 0.9;">${email.subject}</td>
        <td style="opacity: 0.7; font-size: 0.8rem; white-space: nowrap;">${dateStr}</td>
      `;
      tbody.appendChild(tr);
    });
    
    drilldownModal.classList.add('active');
  }

  // 1. Donut Chart
  
  if (totalCustomLabels === 0) {
    // Empty state
    new Chart(donutCtx, {
      type: 'doughnut',
      data: {
        labels: ['No Data Yet'],
        datasets: [{
          data: [1],
          backgroundColor: ['rgba(255,255,255,0.05)'],
          borderWidth: 0
        }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });
  } else {
    new Chart(donutCtx, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [{
          label: 'Total Emails',
          data: dataCounts,
          backgroundColor: pieColors,
          borderWidth: 2,
          borderColor: pieBorders,
          hoverOffset: 8
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        onHover: (event, activeElements) => {
          event.native.target.style.cursor = activeElements.length ? 'pointer' : 'default';
        },
        onClick: handleChartClick,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { padding: 20, color: '#e2e8f0' }
          }
        },
        cutout: '65%',
        layout: { padding: 10 }
      }
    });
  }

  // 2. Bar Chart (Mathematical Density / Samples via Vectorization)
  const barCtx = document.getElementById('barChart').getContext('2d');
  
  if (totalCustomLabels === 0) {
    new Chart(barCtx, { type: 'bar', data: { labels: [], datasets: [] }, options: { scales: { y: { display: false }, x: { display: false } } }});
  } else {
    new Chart(barCtx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Number of Emails',
            data: dataCounts,
            backgroundColor: pieColors,
            borderColor: pieBorders,
            borderWidth: 1,
            borderRadius: 6,
            hoverBackgroundColor: pieBorders
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        onHover: (event, activeElements) => {
          event.native.target.style.cursor = activeElements.length ? 'pointer' : 'default';
        },
        onClick: handleChartClick,
        scales: {
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(255, 255, 255, 0.05)' }
          },
          x: {
            grid: { display: false }
          }
        }
      }
    });
  }

  // 3. Time-Series Velocity (Line Chart)
  const lineCtx = document.getElementById('lineChart').getContext('2d');
  
  if (dataset.length === 0) {
    new Chart(lineCtx, { type: 'line', data: { labels: [], datasets: [] }, options: { scales: { y: { display: false }, x: { display: false } } }});
  } else {
    // Group records by Date string
    const timeGrouped = {};
    dataset.forEach(item => {
      // Use YYYY-MM-DD for cohesive sorting & display
      const dateStr = new Date(item.timestamp).toISOString().split('T')[0];
      timeGrouped[dateStr] ??= {};
      if (item.label !== "AUTO") {
        timeGrouped[dateStr][item.label] = (timeGrouped[dateStr][item.label] || 0) + 1;
      }
    });

    const sortedDates = Object.keys(timeGrouped).sort();
    
    // Map each label into a unique dataset spanning the dates
    const lineDatasets = labels.map((label, idx) => {
      const dataPoints = sortedDates.map(date => timeGrouped[date][label] || 0);
      return {
        label: label,
        data: dataPoints,
        borderColor: pieBorders[idx],
        backgroundColor: pieColors[idx].replace('0.9)', '0.2)'),
        borderWidth: 2,
        tension: 0.4, // Smooth curved lines
        fill: true,
        pointBackgroundColor: pieBorders[idx],
        pointRadius: 3,
        hoverRadius: 6
      };
    });

    new Chart(lineCtx, {
      type: 'line',
      data: {
        labels: sortedDates,
        datasets: lineDatasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'top', labels: { color: '#e2e8f0' } }
        },
        scales: {
          y: { beginAtZero: true, grid: { color: 'rgba(255, 255, 255, 0.05)' } },
          x: { grid: { color: 'rgba(255, 255, 255, 0.05)' } }
        },
        interaction: {
          mode: 'index',
          intersect: false
        }
      }
    });
  }

  // 4. Recent Activity & Search Rendering
  const activityBody = document.getElementById('activityBody');
  const searchInput = document.getElementById('emailSearch');
  const resultCount = document.getElementById('resultCount');
  const dropdown = document.getElementById('searchResultsDropdown');

  function renderActivityTable(filterText = '') {
    const query = (filterText || '').toLowerCase().trim();
    const filtered = dataset.filter(item => {
      const sdr = (item.sender || '').toLowerCase();
      const sub = (item.subject || '').toLowerCase();
      return sdr.includes(query) || sub.includes(query);
    }).sort((a, b) => b.timestamp - a.timestamp);

    resultCount.textContent = `${filtered.length} items`;
    activityBody.innerHTML = '';

    if (filtered.length === 0) {
      activityBody.innerHTML = `<tr><td colspan="5" style="text-align:center; opacity:0.5; padding: 2rem;">No emails found matching "${filterText}".</td></tr>`;
      return;
    }

    filtered.forEach(email => {
      const tr = document.createElement('tr');
      const d = new Date(email.timestamp);
      const dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      
      const statusLabel = email.isUnread ? 'Unread' : 'Read';
      const statusClass = email.isUnread ? 'unread' : 'read';
      
      tr.innerHTML = `
        <td><span class="status-pill ${statusClass}">${statusLabel}</span></td>
        <td style="font-weight: 500;">${email.sender}</td>
        <td style="opacity: 0.9;">${email.subject}</td>
        <td style="opacity: 0.7; font-size: 0.8rem; white-space: nowrap;">${dateStr}</td>
      `;
      activityBody.appendChild(tr);
    });
  }

  // Initial render
  renderActivityTable();

  // Search & Dropdown listener
  searchInput.addEventListener('input', (e) => {
    const val = e.target.value;
    renderActivityTable(val);
    
    if (!val.trim()) {
      dropdown.classList.remove('active');
      return;
    }

    // Dropdown matches (Top 5)
    const matches = dataset.filter(item => 
      (item.sender || '').toLowerCase().includes(val.toLowerCase()) || 
      (item.subject || '').toLowerCase().includes(val.toLowerCase())
    ).sort((a, b) => b.timestamp - a.timestamp).slice(0, 5);

    if (matches.length > 0) {
      dropdown.innerHTML = '';
      matches.forEach(email => {
        const d = new Date(email.timestamp);
        const dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        
        const item = document.createElement('div');
        item.className = 'result-item';
        
        item.innerHTML = `
          <div class="result-header">
            <span class="result-sender">${email.sender}</span>
            <span class="result-date">${dateStr}</span>
          </div>
          <div class="result-subject">${email.subject}</div>
        `;
        
        dropdown.appendChild(item);
      });
      dropdown.classList.add('active');
    } else {
      dropdown.classList.remove('active');
    }
  });

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!searchInput.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.remove('active');
    }
  });
});
