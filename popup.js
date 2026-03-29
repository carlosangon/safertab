// ===================================================
// SaferTab – Popup Logic
// ===================================================

let settings = {};
let blocklist = [];
let visitLog = [];
let isUnlocked = false;

// ─── Init ──────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await loadData();

  if (settings.passwordEnabled) {
    show('lockScreen');
    setupLockScreen();
  } else {
    unlockApp();
  }
});

async function loadData() {
  const data = await chrome.storage.local.get(['settings', 'blocklist', 'visitLog', 'dailyUsage', 'limitReachedToday']);
  settings   = data.settings   || {};
  blocklist  = data.blocklist  || [];
  visitLog   = data.visitLog   || [];
  return data;
}

// ─── Lock Screen ───────────────────────────────────

function setupLockScreen() {
  document.getElementById('passwordInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') attemptUnlock();
  });
  document.getElementById('unlockBtn').addEventListener('click', attemptUnlock);
}

function attemptUnlock() {
  const input = document.getElementById('passwordInput').value;
  if (input === settings.password) {
    unlockApp();
  } else {
    show('lockError');
    document.getElementById('passwordInput').value = '';
  }
}

function unlockApp() {
  isUnlocked = true;
  hide('lockScreen');
  show('app');
  setupApp();
}

// ─── App Setup ─────────────────────────────────────

function setupApp() {
  setupTabs();
  setupDashboard();
  setupHistory();
  setupBlocklist();
  setupSettings();

  // Lock button
  document.getElementById('lockBtn').addEventListener('click', () => {
    if (settings.passwordEnabled) {
      hide('app');
      show('lockScreen');
      document.getElementById('passwordInput').value = '';
      hide('lockError');
    }
  });
}

// ─── Tabs ──────────────────────────────────────────

function setupTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(s => s.classList.add('hidden'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.remove('hidden');
    });
  });
}

// ─── Dashboard ─────────────────────────────────────

async function setupDashboard() {
  const data = await chrome.storage.local.get(['dailyUsage', 'settings']);
  const today = getTodayStr();
  const minutes = data.dailyUsage?.date === today ? data.dailyUsage.minutes : 0;
  const limit = data.settings?.dailyLimitMinutes || 120;
  const limitEnabled = data.settings?.limitEnabled;
  const adultEnabled = data.settings?.adultFilterEnabled !== false;

  // Stats
  document.getElementById('statMinutes').textContent = minutes;
  document.getElementById('statSites').textContent = visitLog.length;
  document.getElementById('statBlocked').textContent = blocklist.length;

  // Progress bar
  const pct = limitEnabled ? Math.min(100, (minutes / limit) * 100) : 0;
  document.getElementById('progressBar').style.width = `${pct}%`;
  document.getElementById('usageLabel').textContent = limitEnabled
    ? `${minutes} / ${limit} min`
    : `${minutes} min (no limit)`;
  if (pct > 80) document.getElementById('progressBar').style.background = 'linear-gradient(90deg, #f59e0b, #ef4444)';

  // Pills
  const pillAdultStatus = document.getElementById('pillAdultStatus');
  pillAdultStatus.textContent = adultEnabled ? 'ON' : 'OFF';
  pillAdultStatus.className = `pill-status ${adultEnabled ? '' : 'off'}`;

  const pillLimitStatus = document.getElementById('pillLimitStatus');
  pillLimitStatus.textContent = limitEnabled ? `${limit}min` : 'OFF';
  pillLimitStatus.className = `pill-status ${limitEnabled ? '' : 'off'}`;

  // Recent 5 visits
  const recent = visitLog.slice(0, 5);
  const list = document.getElementById('recentList');
  if (recent.length === 0) {
    list.innerHTML = '<li class="empty-state">No visits recorded yet.</li>';
  } else {
    list.innerHTML = recent.map(entry => `
      <li>
        <div class="log-title">${escHtml(entry.title || entry.hostname)}</div>
        <div class="log-meta">
          <span class="log-domain">${escHtml(entry.hostname)}</span>
          <span>${formatTime(entry.timestamp)}</span>
        </div>
      </li>
    `).join('');
  }
}

// ─── History ───────────────────────────────────────

function setupHistory() {
  renderHistory(visitLog);

  document.getElementById('historySearch').addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    const filtered = visitLog.filter(v =>
      v.hostname.toLowerCase().includes(q) ||
      (v.title || '').toLowerCase().includes(q) ||
      v.url.toLowerCase().includes(q)
    );
    renderHistory(filtered);
  });

  document.getElementById('clearHistoryBtn').addEventListener('click', async () => {
    if (!confirm('Clear all visit history?')) return;
    await chrome.runtime.sendMessage({ action: 'clearLog' });
    visitLog = [];
    renderHistory([]);
    document.getElementById('statSites').textContent = '0';
  });
}

function renderHistory(entries) {
  const list = document.getElementById('historyList');
  if (entries.length === 0) {
    list.innerHTML = '<li class="empty-state">No history to show.</li>';
    return;
  }
  list.innerHTML = entries.map(e => `
    <li>
      <div class="log-title">${escHtml(e.title || e.hostname)}</div>
      <div class="log-meta">
        <span class="log-domain">${escHtml(e.hostname)}</span>
        <span>${formatTime(e.timestamp)}</span>
      </div>
    </li>
  `).join('');
}

// ─── Blocklist ─────────────────────────────────────

function setupBlocklist() {
  renderBlocklist();

  // Add single domain
  document.getElementById('addBlockBtn').addEventListener('click', addDomain);
  document.getElementById('blockInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') addDomain();
  });

  // Import from .txt file
  document.getElementById('importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    let added = 0;
    for (const line of lines) {
      const domain = cleanDomain(line);
      if (domain && !blocklist.includes(domain)) {
        blocklist.push(domain);
        added++;
      }
    }
    await saveBlocklist();
    renderBlocklist();
    const status = document.getElementById('importStatus');
    status.textContent = `✅ Imported ${added} new domain(s) from ${file.name}`;
    show('importStatus');
    setTimeout(() => hide('importStatus'), 4000);
    e.target.value = '';
  });
}

async function addDomain() {
  const input = document.getElementById('blockInput');
  const domain = cleanDomain(input.value);
  if (!domain) return;
  if (blocklist.includes(domain)) { input.value = ''; return; }
  blocklist.push(domain);
  await saveBlocklist();
  renderBlocklist();
  input.value = '';
}

async function removeDomain(domain) {
  blocklist = blocklist.filter(d => d !== domain);
  await saveBlocklist();
  renderBlocklist();
  document.getElementById('statBlocked').textContent = blocklist.length;
}

async function saveBlocklist() {
  await chrome.storage.local.set({ blocklist });
  document.getElementById('statBlocked').textContent = blocklist.length;
  chrome.runtime.sendMessage({ action: 'rebuildRules' });
}

function renderBlocklist() {
  const list = document.getElementById('blocklistItems');
  document.getElementById('blocklistCount').textContent = blocklist.length;
  if (blocklist.length === 0) {
    list.innerHTML = '<li class="empty-state">No sites blocked yet.</li>';
    return;
  }
  list.innerHTML = blocklist.map(domain => `
    <li>
      <span>${escHtml(domain)}</span>
      <button class="remove-btn" data-domain="${escHtml(domain)}" title="Remove">✕</button>
    </li>
  `).join('');
  list.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', () => removeDomain(btn.dataset.domain));
  });
}

// ─── Settings ──────────────────────────────────────

function setupSettings() {
  const adultToggle  = document.getElementById('adultFilterToggle');
  const limitToggle  = document.getElementById('limitToggle');
  const limitRow     = document.getElementById('limitRow');
  const limitMinutes = document.getElementById('limitMinutes');
  const pwToggle     = document.getElementById('passwordToggle');
  const pwRow        = document.getElementById('passwordRow');

  // Load current values
  adultToggle.checked  = settings.adultFilterEnabled !== false;
  limitToggle.checked  = !!settings.limitEnabled;
  limitMinutes.value   = settings.dailyLimitMinutes || 120;
  pwToggle.checked     = !!settings.passwordEnabled;
  if (!settings.limitEnabled) limitRow.classList.add('hidden');
  if (!settings.passwordEnabled) pwRow.classList.add('hidden');

  limitToggle.addEventListener('change', () => {
    limitRow.classList.toggle('hidden', !limitToggle.checked);
  });
  pwToggle.addEventListener('change', () => {
    pwRow.classList.toggle('hidden', !pwToggle.checked);
  });

  // Save password separately
  document.getElementById('savePasswordBtn').addEventListener('click', async () => {
    const newPw = document.getElementById('newPassword').value.trim();
    if (!newPw) return;
    settings.password = newPw;
    await chrome.storage.local.set({ settings });
    document.getElementById('newPassword').value = '';
    flashSuccess();
  });

  // Reset usage
  document.getElementById('resetUsageBtn').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'resetUsage' });
    await setupDashboard();
  });

  // Save all settings
  document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
    settings.adultFilterEnabled = adultToggle.checked;
    settings.limitEnabled       = limitToggle.checked;
    settings.dailyLimitMinutes  = parseInt(limitMinutes.value) || 120;
    settings.passwordEnabled    = pwToggle.checked;
    await chrome.storage.local.set({ settings });
    await chrome.runtime.sendMessage({ action: 'rebuildRules' });
    flashSuccess();
    await setupDashboard();
  });
}

function flashSuccess() {
  const el = document.getElementById('settingsSaved');
  show('settingsSaved');
  setTimeout(() => hide('settingsSaved'), 2500);
}

// ─── Helpers ───────────────────────────────────────

function cleanDomain(raw) {
  return raw.trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
}

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function getTodayStr() {
  return new Date().toISOString().split('T')[0];
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function show(id) { document.getElementById(id)?.classList.remove('hidden'); }
function hide(id) { document.getElementById(id)?.classList.add('hidden'); }
