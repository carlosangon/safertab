// ===================================================
// SaferTab – Popup Logic
// ===================================================

let settings = {};
let blocklist = [];
let allowlist = [];
let schedules = [];
let visitLog = [];
let isUnlocked = false;
let encryptionKey = null;
let activeProfileId = null;

// ─── Init ──────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await loadData();

  const { passwordEnabled } = await chrome.storage.local.get('passwordEnabled');
  const { passwordHash } = await chrome.storage.local.get('passwordHash');

  if (passwordEnabled && passwordHash) {
    show('lockScreen');
    setupLockScreen();
  } else {
    await unlockApp();
  }
});

async function loadData() {
  const data = await chrome.storage.local.get([
    'profiles', 'activeProfileId', 'passwordHash', 'passwordSalt',
    'passwordEnabled', 'cryptoSalt'
  ]);

  activeProfileId = data.activeProfileId;
  const profile = data.profiles?.[activeProfileId];
  if (profile) {
    settings  = profile.settings || {};
    blocklist = profile.blocklist || [];
    allowlist = profile.allowlist || [];
    schedules = profile.schedules || [];
  } else {
    settings = {};
    blocklist = [];
    allowlist = [];
    schedules = [];
  }
  return data;
}

// ─── Lock Screen ───────────────────────────────────

function setupLockScreen() {
  document.getElementById('passwordInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') attemptUnlock();
  });
  document.getElementById('unlockBtn').addEventListener('click', attemptUnlock);
}

async function attemptUnlock() {
  const input = document.getElementById('passwordInput').value;
  const { passwordHash, passwordSalt, cryptoSalt } = await chrome.storage.local.get([
    'passwordHash', 'passwordSalt', 'cryptoSalt'
  ]);
  const inputHash = await hashPassword(input, passwordSalt);

  if (inputHash === passwordHash) {
    encryptionKey = await deriveEncryptionKey(input, cryptoSalt);
    await unlockApp();
  } else {
    show('lockError');
    document.getElementById('passwordInput').value = '';
  }
}

async function unlockApp() {
  isUnlocked = true;
  hide('lockScreen');
  show('app');

  if (!encryptionKey) {
    const { cryptoSalt, passwordHash } = await chrome.storage.local.get(['cryptoSalt', 'passwordHash']);
    encryptionKey = await deriveEncryptionKey(passwordHash || 'safertab', cryptoSalt);
  }

  await mergeAndDecryptLogs();
  setupApp();
}

async function mergeAndDecryptLogs() {
  const { profiles } = await chrome.storage.local.get('profiles');
  const profile = profiles?.[activeProfileId];
  if (!profile) return;

  const encryptedVisitLog = profile.encryptedVisitLog;
  const visitLogPending = profile.visitLogPending || [];

  let decryptedLog = [];

  if (encryptedVisitLog && encryptionKey) {
    try {
      decryptedLog = await decryptData(encryptionKey, encryptedVisitLog);
    } catch (e) {
      console.warn('[SaferTab] Could not decrypt visit log, starting fresh.', e);
      decryptedLog = [];
    }
  }

  if (visitLogPending.length > 0) {
    decryptedLog = [...visitLogPending, ...decryptedLog];
  }

  decryptedLog.sort((a, b) => b.timestamp - a.timestamp);
  visitLog = pruneLog(decryptedLog);

  await saveEncryptedLog();
}

async function saveEncryptedLog() {
  if (!encryptionKey) return;
  try {
    const encrypted = await encryptData(encryptionKey, visitLog);
    const { profiles } = await chrome.storage.local.get('profiles');
    if (profiles?.[activeProfileId]) {
      profiles[activeProfileId].encryptedVisitLog = encrypted;
      profiles[activeProfileId].visitLogPending = [];
      await chrome.storage.local.set({ profiles });
    }
  } catch (e) {
    console.error('[SaferTab] Encryption failed:', e);
  }
}

// ─── App Setup ─────────────────────────────────────

function setupApp() {
  setupTabs();
  setupProfileSelector();
  setupDashboard();
  setupHistory();
  setupSites();
  setupSchedules();
  setupSettings();
  checkStorageUsage();

  document.getElementById('lockBtn').addEventListener('click', async () => {
    const { passwordEnabled } = await chrome.storage.local.get('passwordEnabled');
    if (passwordEnabled) {
      hide('app');
      show('lockScreen');
      document.getElementById('passwordInput').value = '';
      hide('lockError');
      encryptionKey = null;
    }
  });
}

// ─── Profile Selector ──────────────────────────────

async function setupProfileSelector() {
  const resp = await chrome.runtime.sendMessage({ action: 'getProfiles' });
  const select = document.getElementById('profileSelector');
  select.innerHTML = resp.profiles.map(p =>
    `<option value="${p.id}" ${p.id === resp.activeProfileId ? 'selected' : ''}>${escHtml(p.name)}</option>`
  ).join('');

  select.addEventListener('change', async () => {
    await chrome.runtime.sendMessage({ action: 'switchProfile', profileId: select.value });
    activeProfileId = select.value;
    await loadData();
    await mergeAndDecryptLogs();
    setupDashboard();
    setupSites();
    setupSchedules();
    updateSettingsUI();
    updateModeUI();
  });
}

// ─── Storage Monitoring ────────────────────────────

async function checkStorageUsage() {
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'getStorageSize' });
    const pct = Math.round((resp.sizeBytes / resp.limitBytes) * 100);
    const warning = document.getElementById('storageWarning');
    const label = document.getElementById('storagePercent');

    if (pct >= 80) {
      label.textContent = `${pct}%`;
      warning.classList.remove('hidden');
      if (pct >= 95) warning.classList.add('critical');
    }
  } catch (e) { /* background not ready */ }
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
  const { profiles } = await chrome.storage.local.get('profiles');
  const profile = profiles?.[activeProfileId];
  if (!profile) return;

  const today = getTodayStr();
  const minutes = profile.dailyUsage?.date === today ? profile.dailyUsage.minutes : 0;
  const limit = profile.settings?.dailyLimitMinutes || 120;
  const limitEnabled = profile.settings?.limitEnabled;
  const adultEnabled = profile.settings?.adultFilterEnabled !== false;
  const mode = profile.settings?.mode || 'blocklist';

  document.getElementById('statMinutes').textContent = minutes;
  document.getElementById('statSites').textContent = visitLog.length;
  document.getElementById('statBlocked').textContent = mode === 'allowlist' ? allowlist.length : blocklist.length;

  const pct = limitEnabled ? Math.min(100, (minutes / limit) * 100) : 0;
  document.getElementById('progressBar').style.width = `${pct}%`;
  document.getElementById('usageLabel').textContent = limitEnabled
    ? `${minutes} / ${limit} min`
    : `${minutes} min (no limit)`;
  if (pct > 80) document.getElementById('progressBar').style.background = 'linear-gradient(90deg, #f59e0b, #ef4444)';
  else document.getElementById('progressBar').style.background = '';

  const pillAdultStatus = document.getElementById('pillAdultStatus');
  pillAdultStatus.textContent = adultEnabled ? 'ON' : 'OFF';
  pillAdultStatus.className = `pill-status ${adultEnabled ? '' : 'off'}`;

  const pillLimitStatus = document.getElementById('pillLimitStatus');
  pillLimitStatus.textContent = limitEnabled ? `${limit}min` : 'OFF';
  pillLimitStatus.className = `pill-status ${limitEnabled ? '' : 'off'}`;

  const pillModeStatus = document.getElementById('pillModeStatus');
  pillModeStatus.textContent = mode === 'allowlist' ? 'ALLOW' : 'BLOCK';
  pillModeStatus.className = `pill-status ${mode === 'allowlist' ? 'allow' : ''}`;

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
    if (!confirm('Clear all visit history? Consider exporting to CSV first.')) return;
    await chrome.runtime.sendMessage({ action: 'clearLog' });
    visitLog = [];
    renderHistory([]);
    document.getElementById('statSites').textContent = '0';
  });

  document.getElementById('exportCsvBtn').addEventListener('click', exportCsv);
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

function exportCsv() {
  if (visitLog.length === 0) return;
  const header = '"Title","URL","Domain","Date","Time"';
  const rows = visitLog.map(e => {
    const d = new Date(e.timestamp);
    return [e.title || e.hostname, e.url, e.hostname, d.toLocaleDateString(), d.toLocaleTimeString()]
      .map(field => `"${String(field).replace(/"/g, '""')}"`).join(',');
  });
  const csv = [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `safertab-history-${getTodayStr()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Sites (Blocklist + Allowlist) ─────────────────

function setupSites() {
  updateModeUI();
  setupBlocklist();
  setupAllowlist();
}

function updateModeUI() {
  const mode = settings.mode || 'blocklist';
  const modeLabel = document.getElementById('modeLabel');
  const blockSec = document.getElementById('blocklistSection');
  const allowSec = document.getElementById('allowlistSection');

  if (mode === 'allowlist') {
    modeLabel.textContent = 'Allowlist Mode — only listed sites are accessible';
    blockSec.classList.add('hidden');
    allowSec.classList.remove('hidden');
  } else {
    modeLabel.textContent = 'Blocklist Mode — listed sites are blocked';
    blockSec.classList.remove('hidden');
    allowSec.classList.add('hidden');
  }

  // Stat card label
  document.getElementById('statBlocked').textContent = mode === 'allowlist' ? allowlist.length : blocklist.length;
}

function setupBlocklist() {
  renderBlocklist();

  document.getElementById('addBlockBtn').addEventListener('click', () => addSiteTo('block'));
  document.getElementById('blockInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') addSiteTo('block');
  });

  document.getElementById('importBlockFile').addEventListener('change', (e) => importFile(e, 'block'));
}

function setupAllowlist() {
  renderAllowlist();

  document.getElementById('addAllowBtn').addEventListener('click', () => addSiteTo('allow'));
  document.getElementById('allowInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') addSiteTo('allow');
  });

  document.getElementById('importAllowFile').addEventListener('change', (e) => importFile(e, 'allow'));
}

async function addSiteTo(type) {
  const inputId = type === 'block' ? 'blockInput' : 'allowInput';
  const input = document.getElementById(inputId);
  const domain = cleanDomain(input.value);
  if (!domain) return;

  const list = type === 'block' ? blocklist : allowlist;
  if (list.includes(domain)) { input.value = ''; return; }
  list.push(domain);
  await saveSiteList(type);
  type === 'block' ? renderBlocklist() : renderAllowlist();
  input.value = '';
}

async function removeSiteFrom(domain, type) {
  if (type === 'block') {
    blocklist = blocklist.filter(d => d !== domain);
  } else {
    allowlist = allowlist.filter(d => d !== domain);
  }
  await saveSiteList(type);
  type === 'block' ? renderBlocklist() : renderAllowlist();
  updateModeUI();
}

async function saveSiteList(type) {
  const { profiles } = await chrome.storage.local.get('profiles');
  if (!profiles?.[activeProfileId]) return;
  if (type === 'block') {
    profiles[activeProfileId].blocklist = blocklist;
  } else {
    profiles[activeProfileId].allowlist = allowlist;
  }
  await chrome.storage.local.set({ profiles });
  chrome.runtime.sendMessage({ action: 'rebuildRules' });
  updateModeUI();
}

async function importFile(e, type) {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const list = type === 'block' ? blocklist : allowlist;
  let added = 0;
  for (const line of lines) {
    const domain = cleanDomain(line);
    if (domain && !list.includes(domain)) { list.push(domain); added++; }
  }
  await saveSiteList(type);
  type === 'block' ? renderBlocklist() : renderAllowlist();
  const statusId = type === 'block' ? 'importBlockStatus' : 'importAllowStatus';
  const status = document.getElementById(statusId);
  status.textContent = `Imported ${added} new domain(s) from ${file.name}`;
  show(statusId);
  setTimeout(() => hide(statusId), 4000);
  e.target.value = '';
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
      <button class="remove-btn" data-domain="${escHtml(domain)}" data-type="block" title="Remove">&#x2715;</button>
    </li>
  `).join('');
  list.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', () => removeSiteFrom(btn.dataset.domain, btn.dataset.type));
  });
}

function renderAllowlist() {
  const list = document.getElementById('allowlistItems');
  document.getElementById('allowlistCount').textContent = allowlist.length;
  if (allowlist.length === 0) {
    list.innerHTML = '<li class="empty-state">No sites allowed yet. All sites will be blocked.</li>';
    return;
  }
  list.innerHTML = allowlist.map(domain => `
    <li>
      <span>${escHtml(domain)}</span>
      <button class="remove-btn" data-domain="${escHtml(domain)}" data-type="allow" title="Remove">&#x2715;</button>
    </li>
  `).join('');
  list.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', () => removeSiteFrom(btn.dataset.domain, btn.dataset.type));
  });
}

// ─── Schedules ─────────────────────────────────────

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function setupSchedules() {
  renderSchedules();

  // Day picker toggle
  document.querySelectorAll('#dayPicker .day-pill').forEach(btn => {
    btn.addEventListener('click', () => btn.classList.toggle('active'));
  });

  document.getElementById('addScheduleBtn').addEventListener('click', addSchedule);
}

async function addSchedule() {
  const domain = cleanDomain(document.getElementById('schedDomain').value);
  if (!domain) return;

  const days = Array.from(document.querySelectorAll('#dayPicker .day-pill.active'))
    .map(btn => parseInt(btn.dataset.day));
  if (days.length === 0) return;

  const startTime = document.getElementById('schedStart').value;
  const endTime = document.getElementById('schedEnd').value;
  if (!startTime || !endTime) return;

  const action = document.querySelector('input[name="schedAction"]:checked').value;

  const rule = {
    id: Math.random().toString(36).substring(2, 10),
    target: domain,
    days,
    startTime,
    endTime,
    action,
  };

  schedules.push(rule);
  await saveSchedules();
  renderSchedules();

  // Reset form
  document.getElementById('schedDomain').value = '';
  document.querySelectorAll('#dayPicker .day-pill').forEach(btn => btn.classList.remove('active'));
}

async function removeSchedule(id) {
  schedules = schedules.filter(s => s.id !== id);
  await saveSchedules();
  renderSchedules();
}

async function saveSchedules() {
  const { profiles } = await chrome.storage.local.get('profiles');
  if (!profiles?.[activeProfileId]) return;
  profiles[activeProfileId].schedules = schedules;
  await chrome.storage.local.set({ profiles });
  chrome.runtime.sendMessage({ action: 'rebuildRules' });
}

function renderSchedules() {
  const container = document.getElementById('scheduleList');
  if (schedules.length === 0) {
    container.innerHTML = '<div class="empty-state">No schedules yet.</div>';
    return;
  }
  container.innerHTML = schedules.map(s => `
    <div class="schedule-card">
      <div class="sched-header">
        <span class="sched-domain">${escHtml(s.target)}</span>
        <button class="remove-btn" data-id="${s.id}" title="Remove">&#x2715;</button>
      </div>
      <div class="sched-details">
        <span class="sched-days">${s.days.map(d => DAY_NAMES[d]).join(', ')}</span>
        <span class="sched-time">${s.startTime} – ${s.endTime}</span>
      </div>
      <div class="sched-action ${s.action}">${s.action === 'allow' ? 'Allow only during window' : 'Block during window'}</div>
    </div>
  `).join('');
  container.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', () => removeSchedule(btn.dataset.id));
  });
}

// ─── Settings ──────────────────────────────────────

function setupSettings() {
  const adultToggle  = document.getElementById('adultFilterToggle');
  const safeToggle   = document.getElementById('safeSearchToggle');
  const limitToggle  = document.getElementById('limitToggle');
  const limitRow     = document.getElementById('limitRow');
  const limitMinutes = document.getElementById('limitMinutes');
  const pwToggle     = document.getElementById('passwordToggle');
  const pwRow        = document.getElementById('passwordRow');

  updateSettingsUI();

  limitToggle.addEventListener('change', () => {
    limitRow.classList.toggle('hidden', !limitToggle.checked);
  });
  pwToggle.addEventListener('change', () => {
    pwRow.classList.toggle('hidden', !pwToggle.checked);
  });

  // Mode toggle
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Save password
  document.getElementById('savePasswordBtn').addEventListener('click', async () => {
    const newPw = document.getElementById('newPassword').value.trim();
    if (!newPw) return;

    const { cryptoSalt } = await chrome.storage.local.get('cryptoSalt');
    const newKey = await deriveEncryptionKey(newPw, cryptoSalt);

    if (visitLog.length > 0) {
      const encrypted = await encryptData(newKey, visitLog);
      const { profiles } = await chrome.storage.local.get('profiles');
      if (profiles?.[activeProfileId]) {
        profiles[activeProfileId].encryptedVisitLog = encrypted;
        await chrome.storage.local.set({ profiles });
      }
    }

    const passwordSalt = generateSalt();
    const passwordHash = await hashPassword(newPw, passwordSalt);
    await chrome.storage.local.set({ passwordHash, passwordSalt });

    encryptionKey = newKey;
    document.getElementById('newPassword').value = '';
    flashSuccess();
  });

  document.getElementById('resetUsageBtn').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'resetUsage' });
    await setupDashboard();
  });

  // Save all settings
  document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
    const activeMode = document.querySelector('.mode-btn.active')?.dataset.mode || 'blocklist';

    settings.adultFilterEnabled = adultToggle.checked;
    settings.safeSearchEnabled  = safeToggle.checked;
    settings.limitEnabled       = limitToggle.checked;
    settings.dailyLimitMinutes  = parseInt(limitMinutes.value) || 120;
    settings.mode               = activeMode;

    const { profiles } = await chrome.storage.local.get('profiles');
    if (profiles?.[activeProfileId]) {
      profiles[activeProfileId].settings = settings;
      await chrome.storage.local.set({ profiles });
    }

    await chrome.storage.local.set({ passwordEnabled: pwToggle.checked });
    await chrome.runtime.sendMessage({ action: 'rebuildRules' });
    flashSuccess();
    await setupDashboard();
    updateModeUI();
  });

  // Profile management
  setupProfileManagement();
}

function updateSettingsUI() {
  document.getElementById('adultFilterToggle').checked = settings.adultFilterEnabled !== false;
  document.getElementById('safeSearchToggle').checked = !!settings.safeSearchEnabled;
  document.getElementById('limitToggle').checked = !!settings.limitEnabled;
  document.getElementById('limitMinutes').value = settings.dailyLimitMinutes || 120;

  if (!settings.limitEnabled) document.getElementById('limitRow').classList.add('hidden');
  else document.getElementById('limitRow').classList.remove('hidden');

  // Password toggle
  chrome.storage.local.get('passwordEnabled').then(({ passwordEnabled }) => {
    document.getElementById('passwordToggle').checked = !!passwordEnabled;
    if (!passwordEnabled) document.getElementById('passwordRow').classList.add('hidden');
    else document.getElementById('passwordRow').classList.remove('hidden');
  });

  // Mode toggle
  const mode = settings.mode || 'blocklist';
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
}

async function setupProfileManagement() {
  const resp = await chrome.runtime.sendMessage({ action: 'getProfiles' });
  const container = document.getElementById('profileList');

  container.innerHTML = resp.profiles.map(p => `
    <div class="profile-card">
      <span class="profile-name">${escHtml(p.name)}</span>
      <span class="profile-badge ${p.id === resp.activeProfileId ? 'active' : ''}">${p.id === resp.activeProfileId ? 'Active' : ''}</span>
      ${resp.profiles.length > 1 && p.id !== resp.activeProfileId
        ? `<button class="remove-btn profile-delete" data-id="${p.id}" title="Delete">&#x2715;</button>`
        : ''}
    </div>
  `).join('');

  container.querySelectorAll('.profile-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this profile?')) return;
      await chrome.runtime.sendMessage({ action: 'deleteProfile', profileId: btn.dataset.id });
      await setupProfileManagement();
      await setupProfileSelector();
    });
  });

  document.getElementById('addProfileBtn').addEventListener('click', async () => {
    const nameInput = document.getElementById('newProfileName');
    const name = nameInput.value.trim();
    if (!name) return;
    await chrome.runtime.sendMessage({ action: 'createProfile', name });
    nameInput.value = '';
    await setupProfileManagement();
    await setupProfileSelector();
  });
}

function flashSuccess() {
  show('settingsSaved');
  setTimeout(() => hide('settingsSaved'), 2500);
}

// ─── Helpers ───────────────────────────────────────

function cleanDomain(raw) {
  return raw.trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
}

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
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
