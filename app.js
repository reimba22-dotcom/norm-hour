// app.js — Нормо-часы M-Telemetry Pro 2.0
(function () {
  'use strict';

  // ===== UTILITIES & STATE =====
  const todayIso = toLocalIso(new Date());

  const DEFAULT_PRESETS = [
    { title: 'Замена моторного масла и фильтра', aw: 4 },
    { title: 'Замена передних тормозных колодок', aw: 8 },
    { title: 'Замена задних тормозных колодок', aw: 7 },
    { title: 'Сход-развал (регулировка УУК)', aw: 8 },
    { title: 'Диагностика ходовой части', aw: 3 },
    { title: 'Компьютерная диагностика (ISTA)', aw: 3 }
  ];

  const DEFAULT_SETTINGS = {
    monthlySalaryKop: 0,
    awRateKop: 0,
    hourRateKop: 100000, // 1 000 ₽/нч по умолчанию, перезаписывается сохраненными настройками
    awPerHour100: 1200,
    monthlyGoalKop: 20000000, // 200 000 ₽
    shiftGoalAw: 100,         // 100 AW / смена
    schedule: { type: 'custom', startDate: todayIso, pattern: 'РРВВ' },
    theme: 'dark',
    splashEnabled: true,
    driveMode: 'comfort',
    ocrProvider: 'ocrspace',
    ocrSpaceKey: '',
    geminiKey: '',
    workingModel: ''
  };

  let state = {
    orders: [],
    days: {},
    settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    adjustments: [],
    customPresets: []
  };

  let currentTab = 'orders';
  let periodMode = 'month'; // day | week | month | custom
  let anchorDate = todayIso;
  let customFrom = todayIso.slice(0, 7) + '-01';
  let customTo = todayIso;
  let calSubView = 'month'; // month | week | day
  let selectedCalDay = todayIso;
  let searchQuery = '';
  let statusFilter = 'all';
  let activePhotoDataUrl = null;
  let lastDeletedOrder = null;
  let lastDeletedPhoto = null;
  let navSlideDir = 0; // -1 left, +1 right
  let lastClonedId = null;
  let lastStatusPulseIso = null;
  let dominoCalFill = false;
  let prevRenderedTab = '';
  let telemetryRaf = null;
  let lastTelemetryKey = '';
  let modeBannerTimer = null;

  function haptic(ms = 12) {
    if (navigator.vibrate) {
      try { navigator.vibrate(ms); } catch (e) {}
    }
  }

  function toLocalIso(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function parseLocalIso(iso) {
    const [y, m, d] = (iso || '').split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  }
  function addDaysIso(iso, delta) {
    const d = parseLocalIso(iso);
    d.setDate(d.getDate() + delta);
    return toLocalIso(d);
  }
  function addMonthsIso(iso, delta) {
    const [y, m, day] = iso.split('-').map(Number);
    const target = new Date(y, m - 1 + delta, 1);
    const maxD = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(day, maxD));
    return toLocalIso(target);
  }

  function uid() { return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }
  function fmtRub(kop) { return Math.round((kop || 0) / 100).toLocaleString('ru-RU') + ' ₽'; }
  function fmtRubDec(kop) {
    return ((kop || 0) / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';
  }
  function fmtShortK(kop) {
    const rub = (kop || 0) / 100;
    if (rub <= 0) return '';
    if (rub >= 1000) return (rub / 1000).toFixed(1).replace('.', ',').replace(',0', '') + 'к';
    return Math.round(rub) + '₽';
  }
  function fmtDateRu(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
    return `${parseInt(d, 10)} ${months[parseInt(m, 10) - 1]} ${y}`;
  }
  function fmtMonthTitle(ym) {
    const [y, m] = ym.split('-').map(Number);
    const names = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
    return names[m - 1] + ' ' + y;
  }
  function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Realistic Russian Plate Formatter with tap glint
  function renderPlateHtml(plateRaw) {
    const clean = String(plateRaw || '').replace(/\s+/g, '').toUpperCase();
    const m = clean.match(/^([АВЕКМНОРСТУХABEKMHOPCTYX])(\d{3})([АВЕКМНОРСТУХABEKMHOPCTYX]{2})(\d{2,3})$/);
    if (!m) return `<span class="ru-plate-real" onclick="this.classList.remove('glint');void this.offsetWidth;this.classList.add('glint')"><span class="ru-plate-main">${escapeHtml(plateRaw)}</span></span>`;
    return `
      <span class="ru-plate-real" title="Госномер" onclick="this.classList.remove('glint');void this.offsetWidth;this.classList.add('glint')">
        <span class="ru-plate-main">${escapeHtml(m[1])} ${escapeHtml(m[2])} ${escapeHtml(m[3])}</span>
        <span class="ru-plate-reg"><span>${escapeHtml(m[4])}</span><span class="ru-flag-micro"></span></span>
      </span>
    `;
  }

  function toast(text, undoCallback = null) {
    const el = document.getElementById('toast');
    const txtEl = document.getElementById('toastText');
    const undoBtn = document.getElementById('toastUndoBtn');
    if (!el || !txtEl) return;
    txtEl.textContent = text;
    if (undoCallback) {
      undoBtn.classList.remove('hidden');
      undoBtn.onclick = () => {
        undoCallback();
        el.classList.remove('show');
      };
    } else {
      undoBtn.classList.add('hidden');
      undoBtn.onclick = null;
    }
    el.classList.add('show');
    clearTimeout(window._tTimer);
    window._tTimer = setTimeout(() => el.classList.remove('show'), undoCallback ? 4500 : 2500);
  }

  // ===== PWA & NETWORK STATUS =====
  if ('serviceWorker' in navigator && (window.location.protocol.startsWith('http') || window.location.hostname === 'localhost')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  function updateNetworkStatus() {
    const badge = document.getElementById('pwaStatusBadge');
    const txt = document.getElementById('pwaStatusText');
    if (!badge || !txt) return;
    if (navigator.onLine) {
      badge.classList.remove('offline');
      txt.textContent = 'IndexedDB · Офлайн готов';
    } else {
      badge.classList.add('offline');
      txt.textContent = 'Офлайн-режим (IndexedDB)';
    }
  }
  window.addEventListener('online', updateNetworkStatus);
  window.addEventListener('offline', updateNetworkStatus);
  updateNetworkStatus();

  async function refreshStorageBadge() {
    const el = document.getElementById('storageSummaryBadge');
    if (!el || !window.MDB) return;
    const stats = await window.MDB.getStorageStats();
    el.textContent = `${stats.ordersCount} З/Н · ${stats.photosCount} фото (${stats.photoMb} МБ)`;
  }

  // ===== METRICS & CALCULATIONS =====
  function calcOrderMetrics(aw100, multiplier = 1) {
    const awPerHour = (state.settings.awPerHour100 || 1200) / 100;
    const effectiveAw100 = Math.round((aw100 || 0) * (multiplier || 1));
    const aw = effectiveAw100 / 100;
    const hours = aw / awPerHour;
    const hours100 = Math.round(hours * 100);
    const earningsKop = Math.round(hours * (state.settings.hourRateKop || 0));
    return { aw, aw100: effectiveAw100, hours, hours100, earningsKop };
  }

  function getActiveRange() {
    const nowIso = toLocalIso(new Date());
    if (periodMode === 'day') {
      return { start: anchorDate, end: anchorDate, label: anchorDate === nowIso ? 'Сегодня' : fmtDateRu(anchorDate) };
    }
    if (periodMode === 'week') {
      const d = parseLocalIso(anchorDate);
      const day = (d.getDay() + 6) % 7;
      const mon = new Date(d); mon.setDate(d.getDate() - day);
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      const s = toLocalIso(mon), e = toLocalIso(sun);
      return { start: s, end: e, label: `${s.slice(8)}.${s.slice(5,7)} — ${e.slice(8)}.${e.slice(5,7)}` };
    }
    if (periodMode === 'custom') {
      const s = customFrom <= customTo ? customFrom : customTo;
      const e = customFrom <= customTo ? customTo : customFrom;
      return { start: s, end: e, label: `${s.slice(8)}.${s.slice(5,7)} — ${e.slice(8)}.${e.slice(5,7)}` };
    }
    const ym = anchorDate.slice(0, 7);
    const [y, m] = ym.split('-').map(Number);
    const lastD = new Date(y, m, 0).getDate();
    return { start: `${ym}-01`, end: `${ym}-${String(lastD).padStart(2, '0')}`, label: fmtMonthTitle(ym) };
  }

  function calcSalaryForRange(start, end) {
    let totalSalaryKop = 0;
    const cur = parseLocalIso(start);
    const last = parseLocalIso(end);
    while (cur <= last) {
      const iso = toLocalIso(cur);
      const ym = iso.slice(0, 7);
      const st = state.days[iso];
      if (st === 'work' || st === 'vacation') {
        const monthWorkDays = Object.entries(state.days).filter(([k, v]) => k.startsWith(ym) && (v === 'work' || v === 'vacation')).length || 15;
        totalSalaryKop += (state.settings.monthlySalaryKop || 0) / monthWorkDays;
      }
      cur.setDate(cur.getDate() + 1);
    }
    return Math.round(totalSalaryKop);
  }

  function applyTheme() {
    const t = state.settings.theme || 'dark';
    const dm = state.settings.driveMode || 'comfort';
    document.documentElement.setAttribute('data-theme', t);
    document.documentElement.setAttribute('data-drive', dm);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#06080D' : '#EEF2F7');

    const shortLabels = { comfort: 'COMFORT', sport: 'M1 SPORT+', mcs: 'M CS' };
    const fullLabels = { comfort: 'COMFORT · ICE BLUE', sport: 'M1 MODE · SPORT+', mcs: 'M CS · TRACK GOLD' };
    const mBtn = document.getElementById('mModeBtn');
    const rBtn = document.getElementById('railDriveBtn');
    if (mBtn) mBtn.textContent = shortLabels[dm] || 'COMFORT';
    if (rBtn) rBtn.textContent = fullLabels[dm] || 'COMFORT';

    const rtBtn = document.getElementById('railThemeBtn');
    if (rtBtn) rtBtn.textContent = t === 'dark' ? 'Светлая' : 'Тёмная';
  }

  // ===== DATABASE INITIALIZATION =====
  async function initDatabaseAndState() {
    try {
      const migResult = await window.MDB.migrateLegacyData();
      const [loadedOrders, loadedDays, loadedSettings, loadedAdj, loadedPresets] = await Promise.all([
        window.MDB.getAllOrders(),
        window.MDB.getDays(),
        window.MDB.getSettings(),
        window.MDB.getMeta('adjustments', []),
        window.MDB.getMeta('customPresets', [])
      ]);

      state.orders = loadedOrders || [];
      state.days = loadedDays || {};
      state.adjustments = loadedAdj || [];
      state.customPresets = loadedPresets || [];

      if (loadedSettings) {
        state.settings = Object.assign({}, DEFAULT_SETTINGS, loadedSettings);
        if (!state.settings.schedule) state.settings.schedule = DEFAULT_SETTINGS.schedule;
      }

      if (migResult && migResult.migrated) {
        toast(`Данные перенесены в IndexedDB (${state.orders.length} З/Н)`);
      }

      applyTheme();
      refreshStorageBadge();
      render();
      if (state.settings.splashEnabled !== false) playBmwIgnition(false);
    } catch (err) {
      console.error('Init error:', err);
      applyTheme();
      render();
    }
  }

  async function persistSettings() {
    await window.MDB.saveSettings(state.settings);
    window.MDB.syncLightweightMirror(state);
  }

  // ===== NAVIGATION =====
  const TAB_ORDER = ['orders', 'schedule', 'stats', 'history', 'settings'];
  const TAB_TITLES = {
    orders: 'Заказы',
    schedule: 'График смен',
    stats: 'Телеметрия',
    history: 'История и Отчеты',
    settings: 'Настройки'
  };

  function updateDockPill() {
    const slider = document.getElementById('tabPillSlider');
    if (!slider) return;
    const idx = Math.max(0, TAB_ORDER.indexOf(currentTab));
    slider.style.transform = `translateX(calc(${idx * 100}% + ${idx * 4}px))`;
  }

  function switchTab(next) {
    if (!next || next === currentTab) return;
    haptic(10);
    currentTab = next;
    navSlideDir = 0;
    document.querySelectorAll('.tab-item, .rail-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === next);
    });
    updateDockPill();
    render();
  }

  document.querySelectorAll('.tab-item, .rail-btn').forEach(btn => {
    btn.onclick = () => switchTab(btn.dataset.tab);
  });

  window.setPeriodMode = (mode) => { haptic(8); navSlideDir = 0; periodMode = mode; render(); };
  window.shiftPeriod = (dir) => {
    haptic(8);
    navSlideDir = dir;
    if (periodMode === 'day') anchorDate = addDaysIso(anchorDate, dir);
    else if (periodMode === 'week') anchorDate = addDaysIso(anchorDate, dir * 7);
    else anchorDate = addMonthsIso(anchorDate, dir);
    selectedCalDay = anchorDate;
    render();
  };
  window.setCustomDate = (which, val) => {
    if (!val) return;
    if (which === 'from') customFrom = val;
    else customTo = val;
    render();
  };

  function renderPeriodSwitcherHtml() {
    const r = getActiveRange();
    return `
      <div class="seg-bar">
        <button class="seg-btn ${periodMode==='day'?'active':''}" onclick="setPeriodMode('day')">День</button>
        <button class="seg-btn ${periodMode==='week'?'active':''}" onclick="setPeriodMode('week')">Неделя</button>
        <button class="seg-btn ${periodMode==='month'?'active':''}" onclick="setPeriodMode('month')">Месяц</button>
        <button class="seg-btn ${periodMode==='custom'?'active':''}" onclick="setPeriodMode('custom')">Период</button>
      </div>
      ${periodMode === 'custom' ? `
        <div class="form-grid" style="margin-top:10px;margin-bottom:4px;">
          <input type="date" class="input-field" style="padding:8px 10px;font-size:13px;" value="${customFrom}" onchange="setCustomDate('from', this.value)">
          <input type="date" class="input-field" style="padding:8px 10px;font-size:13px;" value="${customTo}" onchange="setCustomDate('to', this.value)">
        </div>
      ` : `
        <div class="date-nav-row">
          <button class="nav-arrow" onclick="shiftPeriod(-1)" aria-label="Предыдущий период">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <span class="nav-date-label ${navSlideDir>0?'slide-from-right':navSlideDir<0?'slide-from-left':''}">${r.label}</span>
          <button class="nav-arrow" onclick="shiftPeriod(1)" aria-label="Следующий период">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>
      `}
    `;
  }

  // ===== SHARED HERO COCKPIT CARD =====
  function renderHeroCockpitHtml(r, rangeOrders) {
    const confirmed = rangeOrders.filter(o => o.status !== 'draft');
    const totalAw100 = confirmed.reduce((s, o) => s + (o.aw100 || 0), 0);
    const totalHours = (totalAw100 / 100) / ((state.settings.awPerHour100 || 1200) / 100);
    const pieceKop = confirmed.reduce((s, o) => s + (o.earningsKop || 0), 0);
    const salaryKop = calcSalaryForRange(r.start, r.end);
    const totalKop = pieceKop + salaryKop;

    const workDaysInRange = Object.entries(state.days).filter(([d, v]) => d >= r.start && d <= r.end && v === 'work').length;
    const activeDaysCount = workDaysInRange || new Set(confirmed.map(o => o.date)).size || 1;
    const avgAwShift = (totalAw100 / 100) / activeDaysCount;

    // Goal Ring Calculations
    const goalKop = state.settings.monthlyGoalKop || 20000000;
    const targetAwPeriod = periodMode === 'day' ? (state.settings.shiftGoalAw || 100)
      : periodMode === 'week' ? (state.settings.shiftGoalAw || 100) * 5
      : (state.settings.shiftGoalAw || 100) * 15;

    const goalPct = periodMode === 'month' && goalKop > 0
      ? Math.min(100, Math.round((totalKop / goalKop) * 100))
      : Math.min(100, Math.round(((totalAw100 / 100) / targetAwPeriod) * 100));

    const circumference = 194.8; // 2 * pi * 31
    const dashOffset = (circumference * (1 - goalPct / 100)).toFixed(1);

    const litCount = Math.min(12, Math.round(((totalAw100 / 100) / targetAwPeriod) * 12));
    let ledsHtml = '';
    for (let i = 0; i < 12; i++) {
      const col = i < 4 ? 'c-cyan' : i < 7 ? 'c-blue' : i < 10 ? 'c-gold' : 'c-red';
      ledsHtml += `<span class="shift-led ${i < litCount ? 'lit ' + col : ''}" style="animation-delay:${i * 36}ms"></span>`;
    }

    return `
      <section class="glass-card hero-cockpit" id="ordersHeroCard">
        ${renderPeriodSwitcherHtml()}

        <div class="hero-main-flex">
          <div>
            <div class="hero-eyebrow">ЗАРАБОТОК · ${confirmed.length} З/Н</div>
            <div class="hero-money num" id="heroTotalMoney">${fmtRub(totalKop)}</div>
            <div class="hero-formula num">
              Оклад <b>${fmtRub(salaryKop)}</b> + Выработка <b>${fmtRub(pieceKop)}</b>
            </div>
          </div>

          <div class="ring-gauge" onclick="openGoalModal()" title="Нажмите, чтобы настроить цель">
            <svg class="ring-svg" viewBox="0 0 74 74">
              <defs>
                <linearGradient id="cockpitArcGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stop-color="#00A0E3"/>
                  <stop offset="55%" stop-color="#10B981"/>
                  <stop offset="100%" stop-color="#F59E0B"/>
                </linearGradient>
              </defs>
              <circle class="ring-bg" cx="37" cy="37" r="31"/>
              <circle class="ring-fg" id="heroGoalArc" cx="37" cy="37" r="31" stroke-dasharray="${circumference}" stroke-dashoffset="${circumference}" data-target-offset="${dashOffset}"/>
            </svg>
            <div class="ring-center">
              <span class="ring-val num">${goalPct}%</span>
              <span class="ring-lbl">${periodMode === 'month' ? 'ЦЕЛЬ' : 'ПЛАН'}</span>
            </div>
          </div>
        </div>

        <div class="tiles-3">
          <div class="sub-tile accent">
            <div class="sub-tile-k">ВСЕГО AW</div>
            <div class="sub-tile-v num" id="heroTotalAw">${(totalAw100 / 100).toFixed(0)}</div>
          </div>
          <div class="sub-tile">
            <div class="sub-tile-k">НОРМО-ЧАСЫ</div>
            <div class="sub-tile-v num" id="heroTotalHours">${totalHours.toFixed(1).replace('.', ',')}</div>
          </div>
          <div class="sub-tile">
            <div class="sub-tile-k">ТЕМП / СМЕНА</div>
            <div class="sub-tile-v num">${avgAwShift.toFixed(1).replace('.', ',')} AW</div>
          </div>
        </div>

        <div class="shift-wrap">
          <div class="shift-hdr">
            <span>M-SHIFT · НАГРУЗКА (${Math.round(totalAw100/100)} / ${targetAwPeriod} AW)</span>
            <span class="num" style="color:var(--green);">${Math.min(100, Math.round(((totalAw100/100)/targetAwPeriod)*100))}%</span>
          </div>
          <div class="shift-leds">${ledsHtml}</div>
        </div>
      </section>
    `;
  }

  // ===== 1. ORDERS TAB =====
  function renderOrders(container) {
    const r = getActiveRange();
    const rangeOrders = state.orders
      .filter(o => o.date >= r.start && o.date <= r.end)
      .sort((a, b) => b.date.localeCompare(a.date));

    const filtered = rangeOrders.filter(o => {
      if (statusFilter === 'confirmed' && o.status === 'draft') return false;
      if (statusFilter === 'draft' && o.status !== 'draft') return false;
      if (statusFilter === 'photo' && !o.photoId) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const hay = `${o.number} ${o.brand} ${o.model} ${o.plate} ${o.comment} ${(o.jobs||[]).map(j=>j.title).join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const groups = {};
    filtered.forEach(o => {
      if (!groups[o.date]) groups[o.date] = [];
      groups[o.date].push(o);
    });

    const heroHtml = renderHeroCockpitHtml(r, rangeOrders);

    const actionsAndSearchHtml = `
      <div class="action-strip">
        <button class="btn-primary-cta" onclick="openOrderModal()">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          <span>Новый З/Н</span>
        </button>
        <button class="icon-sq-btn voice-btn" onclick="openVoiceOrder()" title="Голосовой ввод">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
        </button>
        <button class="icon-sq-btn" onclick="triggerPhoto('camera')" title="Камера (OCR)">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
        </button>
        <button class="icon-sq-btn" onclick="document.getElementById('textPasteSheet').classList.add('open')" title="Вставить текст З/Н">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        </button>
      </div>

      <div class="search-strip">
        <div class="search-box">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" class="input-field" id="orderSearchInp" placeholder="Поиск: авто, госномер, № З/Н, работы..." value="${escapeHtml(searchQuery)}">
        </div>
        <button class="mini-btn" style="height:44px;" onclick="openPayslipModal()" title="Сверка / Печать расчётника">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
          <span>Отчет</span>
        </button>
      </div>

      <div class="filter-chips">
        ${[
          { id: 'all', label: `Все (${rangeOrders.length})` },
          { id: 'confirmed', label: 'Подтверждённые' },
          { id: 'draft', label: 'Черновики' },
          { id: 'photo', label: 'С фото' }
        ].map(f => `<button class="f-chip ${statusFilter===f.id?'active':''}" onclick="setStatusFilter('${f.id}')">${f.label}</button>`).join('')}
      </div>
    `;

    let feedHtml = '';
    const dates = Object.keys(groups).sort((a, b) => b.localeCompare(a));

    if (!state.orders.length) {
      feedHtml = `
        <div class="glass-card" style="text-align:center;padding:28px 18px;">
          <div style="font-size:17px;font-weight:800;margin-bottom:6px;">Добро пожаловать в M-Telemetry Pro</div>
          <div style="font-size:13px;color:var(--text-secondary);margin-bottom:16px;line-height:1.5;">
            Добавьте первый заказ-наряд вручную, надиктуйте голосом, сфотографируйте бланк или восстановите данные из JSON.
          </div>
          <div style="display:flex;flex-wrap:wrap;justify-content:center;gap:8px;">
            <button class="mini-btn photo" onclick="openOrderModal()">+ Создать вручную</button>
            <button class="mini-btn" onclick="document.getElementById('jsonFileInput').click()">Импорт JSON</button>
            <button class="mini-btn" onclick="loadSampleShift()" style="color:var(--text-secondary);">Загрузить пример</button>
          </div>
        </div>
      `;
    } else if (!dates.length) {
      feedHtml = `
        <div class="glass-card" style="text-align:center;padding:28px 16px;color:var(--text-secondary);">
          <div style="font-size:15px;font-weight:700;margin-bottom:4px;">За выбранный период нарядов нет</div>
          <div style="font-size:12px;">Переключите период или нажмите «Новый заказ-наряд»</div>
        </div>
      `;
    } else {
      dates.forEach(dt => {
        const list = groups[dt];
        const dKop = list.reduce((s, o) => s + (o.earningsKop || 0), 0);
        const dAw = list.reduce((s, o) => s + (o.aw100 || 0), 0) / 100;
        feedHtml += `<div class="day-hdr"><span>${fmtDateRu(dt)} · ${list.length} З/Н</span><span class="num" style="color:var(--green);">${dAw.toFixed(1).replace('.0','')} AW · ${fmtRub(dKop)}</span></div>`;

        list.forEach((o, oIdx) => {
          const car = [o.brand, o.model].filter(Boolean).join(' ') || 'Заказ-наряд';
          const jobsStr = (o.jobs || []).map(j => `${j.title} (${(j.aw100||0)/100} AW)`).join('; ');
          const mult = o.multiplier && o.multiplier !== 1 ? `<span class="mult-tag num">x${o.multiplier}</span>` : '';
          const isCloned = lastClonedId && lastClonedId === o.id;
          const slideCls = navSlideDir > 0 ? 'slide-from-right' : navSlideDir < 0 ? 'slide-from-left' : '';
          const cardAnim = isCloned ? 'order-clone-in' : (slideCls || (!searchQuery.trim() ? 'anim-card' : ''));
          const staggerStyle = !searchQuery.trim() && !isCloned && oIdx < 10 ? `style="animation-delay:${oIdx * 38}ms"` : '';
          feedHtml += `
            <article class="order-card bmw-ripple-host ${o.status==='draft'?'draft':''} ${cardAnim}" data-order-id="${o.id}" ${staggerStyle}>
              <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
                <div>
                  <div style="font-size:15.5px;font-weight:800;display:flex;align-items:center;flex-wrap:wrap;gap:6px;">
                    <span>${escapeHtml(car)}</span>
                    ${o.status==='draft'?'<span style="font-size:10px;font-weight:800;color:var(--gold);background:rgba(245,158,11,0.12);padding:2px 6px;border-radius:5px;">ЧЕРНОВИК</span>':''}
                    ${mult}
                  </div>
                  <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:5px;">
                    ${o.plate ? renderPlateHtml(o.plate) : ''}
                    ${o.number ? `<span class="order-num-tag num">#${escapeHtml(o.number)}</span>` : ''}
                  </div>
                </div>
                <div style="text-align:right;flex-shrink:0;">
                  <div class="num" style="font-size:16px;font-weight:900;color:var(--green);">${fmtRubDec(o.earningsKop)}</div>
                  <div class="num" style="font-size:11px;font-weight:700;color:var(--text-secondary);">${(o.aw100||0)/100} AW · ${((o.hours100||0)/100).toFixed(2)} н/ч</div>
                </div>
              </div>
              ${jobsStr ? `<div style="margin-top:8px;font-size:12.5px;color:var(--text-secondary);line-height:1.4;">${escapeHtml(jobsStr)}</div>` : ''}
              ${o.comment ? `<div style="margin-top:4px;font-size:11.5px;color:var(--text-muted);font-style:italic;">${escapeHtml(o.comment)}</div>` : ''}
              <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;padding-top:8px;border-top:1px solid var(--border);">
                <div>
                  ${o.photoId ? `<button class="mini-btn photo" onclick="viewPhoto('${o.photoId}')">Фото бланка</button>` : ''}
                </div>
                <div style="display:flex;gap:6px;">
                  <button class="mini-btn" onclick="editOrder('${o.id}')">Изменить</button>
                  <button class="mini-btn" onclick="duplicateOrder('${o.id}')" title="Дублировать">Копия</button>
                  <button class="mini-btn danger" onclick="deleteOrder('${o.id}')" title="Удалить">✕</button>
                </div>
              </div>
            </article>
          `;
        });
      });
    }

    // Bento Split on Desktop (>= 960px): Feed on Left, Hero Cockpit sticky on Right
    container.innerHTML = `
      <div class="bento-split">
        <div class="bento-sticky-col" style="order:2;">
          ${heroHtml}
        </div>
        <div style="order:1;">
          ${actionsAndSearchHtml}
          ${feedHtml}
        </div>
      </div>
    `;

    lastClonedId = null;
    const arcEl = document.getElementById('heroGoalArc');
    if (arcEl) {
      requestAnimationFrame(() => {
        arcEl.style.strokeDashoffset = arcEl.dataset.targetOffset || '194.8';
      });
    }
    if (!searchQuery.trim()) {
      const confirmedOrders = rangeOrders.filter(o => o.status !== 'draft');
      const tAw100 = confirmedOrders.reduce((s, o) => s + (o.aw100 || 0), 0);
      const tHours = (tAw100 / 100) / ((state.settings.awPerHour100 || 1200) / 100);
      const pKop = confirmedOrders.reduce((s, o) => s + (o.earningsKop || 0), 0);
      const sKop = calcSalaryForRange(r.start, r.end);
      animateTelemetryNumbers(pKop + sKop, tAw100 / 100, tHours);
    }

    const sInp = document.getElementById('orderSearchInp');
    if (sInp) {
      sInp.oninput = (e) => {
        searchQuery = e.target.value;
        renderOrders(container);
        const ni = document.getElementById('orderSearchInp');
        if (ni) { ni.focus(); ni.setSelectionRange(searchQuery.length, searchQuery.length); }
      };
    }
  }

  window.setStatusFilter = (f) => { haptic(8); statusFilter = f; render(); };

  window.loadSampleShift = async () => {
    haptic(15);
    const sample1 = {
      id: uid(), number: '7812450', brand: 'BMW', model: 'X5 xDrive40i G05', plate: 'А777АА777', date: anchorDate,
      jobs: [
        { id: uid(), title: 'Замена моторного масла и фильтра', aw100: 400 },
        { id: uid(), title: 'Замена передних тормозных колодок', aw100: 800 },
        { id: uid(), title: 'Сход-развал', aw100: 800 }
      ],
      multiplier: 1, status: 'confirmed', comment: 'ТО-2'
    };
    const m1 = calcOrderMetrics(2000, 1);
    sample1.aw100 = m1.aw100; sample1.hours100 = m1.hours100; sample1.earningsKop = m1.earningsKop;

    const sample2 = {
      id: uid(), number: '7812451', brand: 'BMW', model: 'M3 Competition G80', plate: 'М003ММ777', date: anchorDate,
      jobs: [
        { id: uid(), title: 'Компьютерная диагностика (ISTA)', aw100: 300 },
        { id: uid(), title: 'Замена свечей зажигания', aw100: 600 }
      ],
      multiplier: 1, status: 'confirmed', comment: ''
    };
    const m2 = calcOrderMetrics(900, 1);
    sample2.aw100 = m2.aw100; sample2.hours100 = m2.hours100; sample2.earningsKop = m2.earningsKop;

    state.orders.unshift(sample2, sample1);
    await window.MDB.saveOrder(sample1);
    await window.MDB.saveOrder(sample2);
    refreshStorageBadge();
    toast('Загружены 2 демо заказ-наряда');
    render();
  };

  // ===== 2. SCHEDULE TAB =====
  window.setCalSubView = (v) => { haptic(8); calSubView = v; render(); };
  window.shiftScheduleNav = (dir) => {
    haptic(8);
    navSlideDir = dir;
    if (calSubView === 'day') { selectedCalDay = addDaysIso(selectedCalDay, dir); anchorDate = selectedCalDay; }
    else if (calSubView === 'week') { selectedCalDay = addDaysIso(selectedCalDay, dir * 7); anchorDate = selectedCalDay; }
    else { anchorDate = addMonthsIso(anchorDate, dir); selectedCalDay = anchorDate; }
    render();
  };

  function renderSchedule(container) {
    const ym = anchorDate.slice(0, 7);
    const [y, m] = ym.split('-').map(Number);
    const firstDay = new Date(y, m - 1, 1);
    const daysInMonth = new Date(y, m, 0).getDate();
    const startOffset = (firstDay.getDay() + 6) % 7;

    const monthDaysEntries = Object.entries(state.days || {}).filter(([d]) => d.startsWith(ym));
    const workDaysCount = monthDaysEntries.filter(([, v]) => v === 'work').length;
    const vacDaysCount = monthDaysEntries.filter(([, v]) => v === 'vacation').length;
    const unpaidDaysCount = monthDaysEntries.filter(([, v]) => v === 'unpaid').length;
    const paidDaysCount = workDaysCount + vacDaysCount;
    const daySalaryKop = paidDaysCount > 0 ? Math.round((state.settings.monthlySalaryKop || 0) / paidDaysCount) : 0;

    const monthOrders = state.orders.filter(o => o.date.startsWith(ym) && o.status !== 'draft');
    const monthAw100 = monthOrders.reduce((s, o) => s + (o.aw100 || 0), 0);
    const monthPieceKop = monthOrders.reduce((s, o) => s + (o.earningsKop || 0), 0);
    const totalMonthKop = (paidDaysCount > 0 ? (state.settings.monthlySalaryKop || 0) : 0) + monthPieceKop;

    let navTitle = fmtMonthTitle(ym);
    let bodyHtml = '';

    if (calSubView === 'month') {
      let cellsHtml = '';
      for (let i = 0; i < startOffset; i++) cellsHtml += `<div></div>`;
      for (let d = 1; d <= daysInMonth; d++) {
        const iso = `${ym}-${String(d).padStart(2, '0')}`;
        const st = state.days[iso] || 'off';
        const dayOrdersKop = monthOrders.filter(o => o.date === iso).reduce((s, o) => s + (o.earningsKop || 0), 0);
        const dayBaseKop = (st === 'work' || st === 'vacation') ? daySalaryKop : 0;
        const daySumKop = dayOrdersKop + dayBaseKop;
        const tag = st === 'work' ? 'Р' : st === 'vacation' ? 'О' : st === 'unpaid' ? 'Б' : '';
        const isPulse = lastStatusPulseIso === iso;
        const waveDelay = dominoCalFill ? (d * 18) : (navSlideDir ? ((d % 7) * 20 + Math.floor(d / 7) * 16) : 0);
        const waveCls = (dominoCalFill || navSlideDir) ? 'cal-cell-wave' : '';
        cellsHtml += `
          <div class="cal-cell bmw-ripple-host ${st} ${selectedCalDay===iso?'selected':''} ${waveCls} ${isPulse?'status-flash':''}" style="${waveDelay ? 'animation-delay:'+waveDelay+'ms' : ''}" onclick="openDaySheet('${iso}')">
            <span class="cal-day-num num">${d}</span>
            <span class="cal-day-money num">${daySumKop > 0 ? fmtShortK(daySumKop) : ''}</span>
            <span class="cal-day-tag">${tag}</span>
          </div>
        `;
      }
      bodyHtml = `
        <div class="cal-grid">
          <div class="cal-dow">Пн</div><div class="cal-dow">Вт</div><div class="cal-dow">Ср</div>
          <div class="cal-dow">Чт</div><div class="cal-dow">Пт</div><div class="cal-dow">Сб</div><div class="cal-dow">Вс</div>
          ${cellsHtml}
        </div>
      `;
    } else if (calSubView === 'week') {
      const base = parseLocalIso(selectedCalDay);
      const dow = (base.getDay() + 6) % 7;
      const mon = new Date(base); mon.setDate(base.getDate() - dow);
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      const sIso = toLocalIso(mon), eIso = toLocalIso(sun);
      navTitle = `${sIso.slice(8)}.${sIso.slice(5,7)} — ${eIso.slice(8)}.${eIso.slice(5,7)}`;
      let weekCells = '';
      for (let i = 0; i < 7; i++) {
        const cur = new Date(mon); cur.setDate(mon.getDate() + i);
        const iso = toLocalIso(cur);
        const st = state.days[iso] || 'off';
        const dayOrds = state.orders.filter(o => o.date === iso && o.status !== 'draft');
        const daySumKop = dayOrds.reduce((s, o) => s + (o.earningsKop || 0), 0) + ((st === 'work' || st === 'vacation') ? daySalaryKop : 0);
        const tag = st === 'work' ? 'Р' : st === 'vacation' ? 'О' : st === 'unpaid' ? 'Б' : '';
        weekCells += `
          <div class="cal-cell ${st} ${selectedCalDay===iso?'selected':''}" style="height:76px;" onclick="openDaySheet('${iso}')">
            <span class="cal-day-num num">${cur.getDate()}</span>
            <span class="cal-day-money num">${daySumKop > 0 ? fmtShortK(daySumKop) : ''}</span>
            <span class="cal-day-tag">${tag || (dayOrds.length ? dayOrds.length + ' З/Н' : '')}</span>
          </div>
        `;
      }
      bodyHtml = `
        <div class="cal-grid">
          <div class="cal-dow">Пн</div><div class="cal-dow">Вт</div><div class="cal-dow">Ср</div>
          <div class="cal-dow">Чт</div><div class="cal-dow">Пт</div><div class="cal-dow">Сб</div><div class="cal-dow">Вс</div>
          ${weekCells}
        </div>
      `;
    } else {
      navTitle = fmtDateRu(selectedCalDay);
      const st = state.days[selectedCalDay] || 'off';
      const stNames = { work: 'Рабочий день (Р)', off: 'Выходной (В)', vacation: 'Отпуск (О)', unpaid: 'За свой счёт (Б)' };
      const stColors = { work: 'var(--green)', off: 'var(--text-secondary)', vacation: 'var(--gold)', unpaid: 'var(--red)' };
      const dayOrds = state.orders.filter(o => o.date === selectedCalDay);
      const dayOrdersKop = dayOrds.filter(o => o.status !== 'draft').reduce((s, o) => s + (o.earningsKop || 0), 0);
      const dayAw = dayOrds.filter(o => o.status !== 'draft').reduce((s, o) => s + (o.aw100 || 0), 0) / 100;
      const dayBaseKop = (st === 'work' || st === 'vacation') ? daySalaryKop : 0;
      bodyHtml = `
        <div style="padding:12px;border-radius:14px;background:rgba(255,255,255,0.03);border:1px solid var(--border);">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <span style="font-size:13px;font-weight:800;color:${stColors[st]};">${stNames[st]}</span>
            <button class="mini-btn" onclick="openDaySheet('${selectedCalDay}')">Сменить статус</button>
          </div>
          <div class="tiles-3">
            <div class="sub-tile"><div class="sub-tile-k">ИТОГО ДЕНЬ</div><div class="sub-tile-v num" style="color:var(--green);">${fmtRub(dayOrdersKop + dayBaseKop)}</div></div>
            <div class="sub-tile accent"><div class="sub-tile-k">AW</div><div class="sub-tile-v num">${dayAw}</div></div>
            <div class="sub-tile"><div class="sub-tile-k">ЗАКАЗЫ</div><div class="sub-tile-v num">${dayOrds.length}</div></div>
          </div>
          <button class="btn-primary-full" onclick="openOrderModal('${selectedCalDay}')">+ Добавить заказ-наряд на этот день</button>
        </div>
      `;
    }

    container.innerHTML = `
      <div class="bento-split">
        <section class="glass-card">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;">
            <div class="seg-bar three" style="flex:1;">
              <button class="seg-btn ${calSubView==='month'?'active':''}" onclick="setCalSubView('month')">Месяц</button>
              <button class="seg-btn ${calSubView==='week'?'active':''}" onclick="setCalSubView('week')">Неделя</button>
              <button class="seg-btn ${calSubView==='day'?'active':''}" onclick="setCalSubView('day')">День</button>
            </div>
            <button class="mini-btn photo" onclick="autoFillSchedule()" title="Заполнить месяц по шаблону ${escapeHtml(state.settings.schedule?.pattern||'РРВВ')}">
              Авто (${escapeHtml(state.settings.schedule?.pattern || 'РРВВ')})
            </button>
          </div>

          <div class="date-nav-row">
            <button class="nav-arrow" onclick="shiftScheduleNav(-1)">‹</button>
            <span class="nav-date-label ${navSlideDir>0?'slide-from-right':navSlideDir<0?'slide-from-left':''}">${navTitle}</span>
            <button class="nav-arrow" onclick="shiftScheduleNav(1)">›</button>
          </div>

          ${bodyHtml}

          <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:12px;padding-top:10px;border-top:1px solid var(--border);font-size:11px;color:var(--text-secondary);">
            <span><b style="color:var(--green);">■</b> Рабочий</span>
            <span><b style="color:var(--text-muted);">■</b> Выходной</span>
            <span><b style="color:var(--gold);">■</b> Отпуск</span>
            <span><b style="color:var(--red);">■</b> За свой счёт</span>
          </div>
        </section>

        <section class="glass-card bento-sticky-col">
          <h3 style="font-size:17px;font-weight:800;margin-bottom:10px;">Итоги за ${fmtMonthTitle(ym)}</h3>
          <div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--border);"><span style="color:var(--text-secondary);">Рабочих смен</span><span class="num" style="font-weight:700;">${workDaysCount}</span></div>
          <div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--border);"><span style="color:var(--text-secondary);">Отпуск / За свой счёт</span><span class="num" style="font-weight:700;">${vacDaysCount} / ${unpaidDaysCount}</span></div>
          <div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--border);"><span style="color:var(--text-secondary);">Оклад в день</span><span class="num" style="font-weight:700;">${fmtRubDec(daySalaryKop)}</span></div>
          <div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--border);"><span style="color:var(--text-secondary);">Начислено оклада</span><span class="num" style="font-weight:700;">${fmtRub(paidDaysCount > 0 ? state.settings.monthlySalaryKop : 0)}</span></div>
          <div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--border);"><span style="color:var(--text-secondary);">Нормо-часы (${Math.round(monthAw100/100)} AW)</span><span class="num" style="font-weight:700;">${fmtRub(monthPieceKop)}</span></div>
          <div style="display:flex;justify-content:space-between;padding:12px 0 0;">
            <span style="font-size:16px;font-weight:800;">Итого начислено</span>
            <span class="num" style="font-size:21px;font-weight:900;color:var(--green);">${fmtRub(totalMonthKop)}</span>
          </div>
        </section>
      </div>
    `;
    lastStatusPulseIso = null;
    dominoCalFill = false;
  }

  window.openDaySheet = (iso) => {
    haptic(8);
    selectedCalDay = iso;
    anchorDate = iso;
    document.getElementById('daySheetTitle').textContent = fmtDateRu(iso);
    const curSt = state.days[iso] || 'off';
    const statuses = [
      { id: 'work', label: 'Рабочий (Р)', color: 'var(--green)' },
      { id: 'off', label: 'Выходной', color: 'var(--text-secondary)' },
      { id: 'vacation', label: 'Отпуск (О)', color: 'var(--gold)' },
      { id: 'unpaid', label: 'За свой счёт', color: 'var(--red)' }
    ];
    document.getElementById('dayStatusBtns').innerHTML = statuses.map(s => `
      <button class="mini-btn" style="justify-content:center;padding:11px;${curSt===s.id ? 'border-color:'+s.color+';background:rgba(255,255,255,0.08);color:'+s.color : ''}" onclick="setDayStatus('${iso}','${s.id}')">${s.label}</button>
    `).join('');
    const dayOrds = state.orders.filter(o => o.date === iso);
    document.getElementById('daySheetOrdersInfo').textContent = dayOrds.length
      ? `Заказ-нарядов в этот день: ${dayOrds.length} на сумму ${fmtRub(dayOrds.reduce((s,o)=>s+o.earningsKop,0))}`
      : 'В этот день заказ-нарядов пока нет.';
    document.getElementById('daySheetAddOrderBtn').onclick = () => {
      document.getElementById('dayActionSheet').classList.remove('open');
      openOrderModal(iso);
    };
    document.getElementById('dayActionSheet').classList.add('open');
    render();
  };

  window.setDayStatus = async (iso, st) => {
    haptic(10);
    state.days[iso] = st;
    lastStatusPulseIso = iso;
    await window.MDB.setDayStatus(iso, st);
    window.MDB.syncLightweightMirror(state);
    document.getElementById('dayActionSheet').classList.remove('open');
    toast('Статус дня обновлён');
    render();
  };

  window.autoFillSchedule = async () => {
    haptic(14);
    const ym = anchorDate.slice(0, 7);
    const pat = (state.settings.schedule?.pattern || 'РРВВ').toUpperCase();
    const startStr = state.settings.schedule?.startDate || `${ym}-01`;
    const startMs = parseLocalIso(startStr).getTime();
    const [y, m] = ym.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = `${ym}-${String(d).padStart(2, '0')}`;
      const diff = Math.round((parseLocalIso(iso).getTime() - startMs) / 86400000);
      const idx = ((diff % pat.length) + pat.length) % pat.length;
      state.days[iso] = pat[idx] === 'Р' ? 'work' : 'off';
    }
    dominoCalFill = true;
    await window.MDB.saveAllDays(state.days);
    window.MDB.syncLightweightMirror(state);
    toast('График заполнен по шаблону ' + pat);
    render();
  };

  // ===== 3. STATS & TELEMETRY TAB =====
  function renderStats(container) {
    const r = getActiveRange();
    const orders = state.orders.filter(o => o.date >= r.start && o.date <= r.end && o.status !== 'draft');
    const totalAw = orders.reduce((s, o) => s + (o.aw100 || 0), 0) / 100;
    const totalHours = totalAw / ((state.settings.awPerHour100 || 1200) / 100);
    const pieceKop = orders.reduce((s, o) => s + (o.earningsKop || 0), 0);
    const salaryKop = calcSalaryForRange(r.start, r.end);
    const totalKop = pieceKop + salaryKop;

    const workDaysInRange = Object.entries(state.days).filter(([d, v]) => d >= r.start && d <= r.end && v === 'work').length;
    const activeShiftCount = workDaysInRange || new Set(orders.map(o => o.date)).size || 1;
    const avgEarnDayKop = totalKop / activeShiftCount;
    const avgAwDay = totalAw / activeShiftCount;

    // Goal Pace Prediction
    const goalKop = state.settings.monthlyGoalKop || 20000000;
    const remKop = Math.max(0, goalKop - totalKop);
    const futureWorkDays = Object.entries(state.days)
      .filter(([d, v]) => d >= todayIso && d <= r.end && v === 'work').length;
    const awPerHour = (state.settings.awPerHour100 || 1200) / 100;
    const rubPerAw = (state.settings.hourRateKop || 100000) / awPerHour;
    const reqAwPerShift = futureWorkDays > 0 && rubPerAw > 0
      ? ((remKop / rubPerAw) / futureWorkDays).toFixed(1)
      : '0';

    // Best day, best order, top models
    const dayTotals = {};
    const modelTotals = {};
    orders.forEach(o => {
      dayTotals[o.date] = (dayTotals[o.date] || 0) + (o.earningsKop || 0);
      const mKey = [o.brand, o.model].filter(Boolean).join(' ') || 'Прочее';
      modelTotals[mKey] = (modelTotals[mKey] || 0) + (o.earningsKop || 0);
    });
    const bestDayEntry = Object.entries(dayTotals).sort((a, b) => b[1] - a[1])[0];
    const bestOrder = [...orders].sort((a, b) => (b.earningsKop || 0) - (a.earningsKop || 0))[0];
    const topModels = Object.entries(modelTotals).sort((a, b) => b[1] - a[1]).slice(0, 4);

    // Stacked SVG Bar Chart
    const chartDays = Object.keys(dayTotals).sort();
    const dayBaseKop = workDaysInRange > 0 ? Math.round((state.settings.monthlySalaryKop || 0) / Math.max(1, workDaysInRange)) : 0;
    const maxStack = Math.max(...chartDays.map(d => (dayTotals[d] || 0) + dayBaseKop), 500000);
    let barsSvg = '';
    if (chartDays.length) {
      const colW = 100 / chartDays.length;
      chartDays.forEach((dt, idx) => {
        const pH = Math.round(((dayTotals[dt] || 0) / maxStack) * 105);
        const sH = Math.round((dayBaseKop / maxStack) * 105);
        const x = idx * colW + colW * 0.25;
        const w = chartDays.length === 1 ? 24 : Math.max(8, Math.min(20, colW * 1.5));
        const dly = Math.min(idx * 45, 450);
        barsSvg += `
          <g>
            <title>${fmtDateRu(dt)}: Выработка ${fmtRub(dayTotals[dt])}${dayBaseKop ? ' + Оклад ' + fmtRub(dayBaseKop) : ''}</title>
            <rect class="bar-grow" style="animation-delay:${dly}ms" x="${x}%" y="${115 - sH}" width="${w}" height="${sH}" rx="3" fill="#F59E0B"></rect>
            <rect class="bar-grow" style="animation-delay:${dly + 80}ms" x="${x}%" y="${113 - sH - pH}" width="${w}" height="${pH}" rx="3" fill="#10B981"></rect>
            <text x="${x}%" y="132" fill="var(--text-secondary)" font-size="9" font-weight="700">${dt.slice(8)}</text>
          </g>
        `;
      });
    }

    container.innerHTML = `
      <div class="bento-split">
        <div>
          <section class="glass-card">${renderPeriodSwitcherHtml()}</section>

          <section class="glass-card" style="border-color:rgba(16,185,129,0.28);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
              <span style="font-size:12px;font-weight:800;color:var(--green);letter-spacing:0.06em;">ЦЕЛЬ МЕСЯЦА: ${fmtRub(goalKop)}</span>
              <button class="mini-btn" onclick="openGoalModal()">Изменить цель</button>
            </div>
            <div style="height:8px;border-radius:99px;background:rgba(255,255,255,0.08);overflow:hidden;margin-bottom:8px;">
              <div style="height:100%;width:${Math.min(100, Math.round((totalKop/Math.max(1,goalKop))*100))}%;background:linear-gradient(90deg,var(--m-cyan),var(--green));border-radius:99px;"></div>
            </div>
            <div style="font-size:12px;color:var(--text-secondary);">
              ${remKop === 0
                ? '<b style="color:var(--green);">Цель месяца достигнута!</b>'
                : futureWorkDays > 0
                  ? `До цели осталось <b>${fmtRub(remKop)}</b> · ${futureWorkDays} смен (нужно <b>${reqAwPerShift} AW/смену</b>)`
                  : `До цели осталось <b>${fmtRub(remKop)}</b> (отметьте рабочие смены в Графике для точного темпа)`
              }
            </div>
          </section>

          <section class="glass-card">
            <div style="font-size:15px;font-weight:800;margin-bottom:10px;">Выработка по дням</div>
            ${chartDays.length ? `
              <svg width="100%" height="142">
                <line x1="0" y1="10" x2="100%" y2="10" stroke="var(--border)" stroke-dasharray="3"/>
                <line x1="0" y1="65" x2="100%" y2="65" stroke="var(--border)" stroke-dasharray="3"/>
                ${barsSvg}
              </svg>
              <div style="display:flex;gap:14px;font-size:11px;color:var(--text-secondary);margin-top:6px;">
                <span><b style="color:#10B981;">■</b> Нормо-часы</span>
                <span><b style="color:#F59E0B;">■</b> Оклад</span>
              </div>
            ` : '<div style="font-size:13px;color:var(--text-secondary);">Добавьте заказы для отображения графика</div>'}
          </section>
        </div>

        <div class="bento-sticky-col">
          <div class="form-grid">
            <div class="glass-card" style="margin:0;">
              <div class="field-label">По нормо-часам</div>
              <div class="num" style="font-size:20px;font-weight:900;color:var(--green);">${fmtRub(pieceKop)}</div>
            </div>
            <div class="glass-card" style="margin:0;">
              <div class="field-label">Оклад за период</div>
              <div class="num" style="font-size:20px;font-weight:900;">${fmtRub(salaryKop)}</div>
            </div>
            <div class="glass-card" style="margin:0;">
              <div class="field-label">Всего AW / н/ч</div>
              <div class="num" style="font-size:19px;font-weight:900;color:var(--accent);">${Math.round(totalAw)} AW · ${totalHours.toFixed(1)}</div>
            </div>
            <div class="glass-card" style="margin:0;">
              <div class="field-label">Среднее за смену</div>
              <div class="num" style="font-size:19px;font-weight:900;">${fmtRub(avgEarnDayKop)}</div>
              <div class="num" style="font-size:11px;color:var(--text-secondary);">${avgAwDay.toFixed(1)} AW/смена</div>
            </div>
            <div class="glass-card" style="margin:0;">
              <div class="field-label">Лучший день</div>
              <div class="num" style="font-size:17px;font-weight:900;">${bestDayEntry ? fmtRub(bestDayEntry[1]) : '0 ₽'}</div>
              <div style="font-size:11px;color:var(--text-secondary);">${bestDayEntry ? fmtDateRu(bestDayEntry[0]) : '—'}</div>
            </div>
            <div class="glass-card" style="margin:0;">
              <div class="field-label">Лучший заказ</div>
              <div class="num" style="font-size:17px;font-weight:900;">${bestOrder ? fmtRub(bestOrder.earningsKop) : '0 ₽'}</div>
              <div style="font-size:11px;color:var(--text-secondary);">${bestOrder ? escapeHtml([bestOrder.brand, bestOrder.model].filter(Boolean).join(' ')) : '—'}</div>
            </div>
          </div>

          <section class="glass-card" style="margin-top:10px;">
            <div style="font-size:14px;font-weight:800;margin-bottom:10px;">Топ моделей по выручке</div>
            ${topModels.length ? topModels.map(([mName, mKop]) => {
              const pct = pieceKop > 0 ? Math.round((mKop / pieceKop) * 100) : 0;
              return `
                <div style="margin-bottom:9px;">
                  <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;">
                    <span style="font-weight:700;">${escapeHtml(mName)}</span>
                    <span class="num" style="color:var(--text-secondary);">${fmtRub(mKop)} (${pct}%)</span>
                  </div>
                  <div style="height:5px;border-radius:99px;background:rgba(255,255,255,0.06);overflow:hidden;">
                    <div style="height:100%;width:${pct}%;background:var(--accent-blue);border-radius:99px;"></div>
                  </div>
                </div>
              `;
            }).join('') : '<div style="font-size:12px;color:var(--text-secondary);">Нет данных за период</div>'}
          </section>
        </div>
      </div>
    `;
    container.querySelectorAll('.bento-sticky-col .glass-card').forEach((card, i) => {
      card.classList.add('anim-card');
      card.style.animationDelay = `${i * 40}ms`;
    });
  }

  // ===== 4. HISTORY & REPORTS TAB =====
  function renderHistory(container) {
    const monthsMap = {};
    state.orders.forEach(o => {
      const ym = o.date.slice(0, 7);
      if (!monthsMap[ym]) monthsMap[ym] = { count: 0, aw100: 0, kop: 0 };
      monthsMap[ym].count += 1;
      monthsMap[ym].aw100 += (o.aw100 || 0);
      monthsMap[ym].kop += (o.earningsKop || 0);
    });
    const yms = Object.keys(monthsMap).sort((a, b) => b.localeCompare(a));
    const maxKop = Math.max(...yms.map(ym => monthsMap[ym].kop), 1);

    container.innerHTML = `
      <section class="glass-card">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:14px;">
          <h3 style="font-size:17px;font-weight:800;">Архив по месяцам</h3>
          <div style="display:flex;gap:8px;">
            <button class="mini-btn photo" onclick="openPayslipModal()">Расчётный лист (PDF)</button>
            <button class="mini-btn" style="color:var(--green);" onclick="exportCsv()">Экспорт CSV</button>
          </div>
        </div>
        ${yms.length ? yms.map(ym => {
          const it = monthsMap[ym];
          const h = (it.aw100 / 100) / ((state.settings.awPerHour100 || 1200) / 100);
          const pct = Math.round((it.kop / maxKop) * 100);
          return `
            <div class="order-card" style="cursor:pointer;" onclick="jumpToMonth('${ym}')">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                <div>
                  <div style="font-size:16px;font-weight:800;">${fmtMonthTitle(ym)}</div>
                  <div style="font-size:12px;color:var(--text-secondary);">${it.count} З/Н · ${h.toFixed(1)} н/ч (${Math.round(it.aw100/100)} AW)</div>
                </div>
                <div class="num" style="font-size:17px;font-weight:900;color:var(--green);">${fmtRub(it.kop)} ›</div>
              </div>
              <div style="height:4px;border-radius:99px;background:rgba(255,255,255,0.06);overflow:hidden;">
                <div style="height:100%;width:${pct}%;background:var(--green);border-radius:99px;"></div>
              </div>
            </div>
          `;
        }).join('') : '<div style="text-align:center;padding:24px;color:var(--text-secondary);">Архив пока пуст — добавьте первый заказ-наряд</div>'}
      </section>
    `;
  }

  window.jumpToMonth = (ym) => {
    anchorDate = `${ym}-01`;
    selectedCalDay = `${ym}-01`;
    periodMode = 'month';
    switchTab('orders');
  };

  window.exportCsv = () => {
    haptic(12);
    const rows = [['Дата','Номер З/Н','Марка','Модель','Госномер','Коэф.','AW','Нормо-часы','Сумма (руб)','Работы']];
    state.orders.forEach(o => {
      rows.push([o.date, o.number||'', o.brand||'', o.model||'', o.plate||'', o.multiplier||1, (o.aw100||0)/100, ((o.hours100||0)/100).toFixed(2), ((o.earningsKop||0)/100).toFixed(2), (o.jobs||[]).map(j=>j.title).join('; ')]);
    });
    const csv = '\uFEFF' + rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    a.download = `normo-hours-${anchorDate.slice(0, 7)}.csv`;
    a.click();
    toast('CSV-таблица выгружена');
  };

  window.openPayslipModal = () => {
    haptic(10);
    const r = getActiveRange();
    const ords = state.orders.filter(o => o.date >= r.start && o.date <= r.end && o.status !== 'draft').sort((a, b) => a.date.localeCompare(b.date));
    const pieceKop = ords.reduce((s, o) => s + (o.earningsKop || 0), 0);
    const totalAw = ords.reduce((s, o) => s + (o.aw100 || 0), 0) / 100;
    const salaryKop = calcSalaryForRange(r.start, r.end);

    document.getElementById('payslipContent').innerHTML = `
      <div style="border-bottom:2px solid var(--border-strong);padding-bottom:10px;margin-bottom:12px;">
        <div style="font-size:18px;font-weight:900;">РАСЧЁТНЫЙ ЛИСТ ВЫРАБОТКИ (M-TELEMETRY)</div>
        <div style="font-size:12px;color:var(--text-secondary);">Период: ${r.label} (${r.start} — ${r.end}) · Ставка: ${fmtRub(state.settings.hourRateKop)}/нч (${(state.settings.awPerHour100||1200)/100} AW/ч)</div>
      </div>

      <table style="width:100%;border-collapse:collapse;margin-bottom:14px;font-size:12px;">
        <thead>
          <tr style="border-bottom:1px solid var(--border-strong);text-align:left;">
            <th style="padding:6px 4px;">Дата</th>
            <th style="padding:6px 4px;">№ З/Н</th>
            <th style="padding:6px 4px;">Авто / Госномер</th>
            <th style="padding:6px 4px;text-align:right;">AW</th>
            <th style="padding:6px 4px;text-align:right;">Сумма</th>
          </tr>
        </thead>
        <tbody>
          ${ords.map(o => `
            <tr style="border-bottom:1px solid var(--border);">
              <td style="padding:6px 4px;" class="num">${o.date.split('-').reverse().join('.')}</td>
              <td style="padding:6px 4px;" class="num">${escapeHtml(o.number || '—')}</td>
              <td style="padding:6px 4px;">${escapeHtml([o.brand, o.model].filter(Boolean).join(' '))} ${o.plate ? '('+escapeHtml(o.plate)+')' : ''}</td>
              <td style="padding:6px 4px;text-align:right;" class="num">${((o.aw100||0)/100).toFixed(1)}</td>
              <td style="padding:6px 4px;text-align:right;font-weight:700;" class="num">${fmtRubDec(o.earningsKop)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>

      <div style="display:flex;flex-direction:column;gap:4px;border-top:2px solid var(--border-strong);padding-top:10px;">
        <div style="display:flex;justify-content:space-between;"><span>Всего заказ-нарядов:</span><b class="num">${ords.length}</b></div>
        <div style="display:flex;justify-content:space-between;"><span>Всего выработано AW / нормо-часов:</span><b class="num">${totalAw.toFixed(1)} AW (${(totalAw/((state.settings.awPerHour100||1200)/100)).toFixed(2)} н/ч)</b></div>
        <div style="display:flex;justify-content:space-between;"><span>Сдельно (по нормо-часам):</span><b class="num">${fmtRubDec(pieceKop)}</b></div>
        <div style="display:flex;justify-content:space-between;"><span>Фиксированный оклад за период:</span><b class="num">${fmtRubDec(salaryKop)}</b></div>
        <div style="display:flex;justify-content:space-between;font-size:16px;margin-top:6px;"><span><b>ИТОГО К НАЧИСЛЕНИЮ:</b></span><b class="num" style="color:var(--green);">${fmtRubDec(pieceKop + salaryKop)}</b></div>
      </div>
    `;
    document.getElementById('payslipModal').classList.add('open');
  };

  // ===== 5. SETTINGS TAB =====
  async function renderSettings(container) {
    const s = state.settings;
    const stats = await window.MDB.getStorageStats();
    container.innerHTML = `
      <div class="bento-split">
        <div>
          <section class="glass-card">
            <h3 style="font-size:16px;font-weight:800;margin-bottom:12px;">Ставки, график и цели</h3>
            <div class="form-grid">
              <div><label class="field-label">Оклад в месяц (₽)</label><input type="number" id="setSalary" class="input-field" value="${Math.round((s.monthlySalaryKop || 0) / 100)}"></div>
              <div><label class="field-label">Ставка за 1 н/ч (₽)</label><input type="number" id="setHourRate" class="input-field" value="${Math.round((s.hourRateKop || 0) / 100)}"></div>
            </div>
            <div class="form-grid">
              <div><label class="field-label">AW в 1 нормо-часе</label><input type="number" id="setAwPerHour" class="input-field" value="${(s.awPerHour100 || 1200) / 100}"></div>
              <div><label class="field-label">Цель дохода (₽/мес)</label><input type="number" id="setGoalKop" class="input-field" value="${Math.round((s.monthlyGoalKop || 20000000) / 100)}"></div>
            </div>
            <div class="form-grid">
              <div><label class="field-label">Шаблон смен (Р/В)</label><input type="text" id="setPattern" class="input-field" value="${escapeHtml(s.schedule?.pattern || 'РРВВ')}"></div>
              <div><label class="field-label">Дата старта графика</label><input type="date" id="setSchedStart" class="input-field" value="${escapeHtml(s.schedule?.startDate || todayIso)}"></div>
            </div>
            <div class="form-grid">
              <div>
                <label class="field-label">Тема оформления</label>
                <select id="setTheme" class="input-field">
                  <option value="dark" ${s.theme==='dark'?'selected':''}>M-Dark (OLED Тёмная)</option>
                  <option value="light" ${s.theme==='light'?'selected':''}>Silver (Светлая)</option>
                </select>
              </div>
              <div>
                <label class="field-label">Заставка фар BMW</label>
                <select id="setSplashEnabled" class="input-field">
                  <option value="1" ${s.splashEnabled!==false?'selected':''}>Вкл (при входе)</option>
                  <option value="0" ${s.splashEnabled===false?'selected':''}>Выкл (мгновенно)</option>
                </select>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr auto;gap:8px;">
              <button class="btn-primary-full" onclick="saveSettingsForm()">Сохранить настройки</button>
              <button type="button" class="mini-btn" style="padding:0 14px;color:var(--accent);" onclick="playBmwIgnition(true)">Тест фар</button>
            </div>
          </section>
        </div>

        <div>
          <section class="glass-card">
            <h3 style="font-size:16px;font-weight:800;margin-bottom:6px;">Распознавание фото (OCR)</h3>
            <div style="font-size:12px;color:var(--text-secondary);margin-bottom:10px;">
              <b>OCR.space</b> работает бесплатно и без VPN. <b>Gemini Vision</b> идеально разбирает сложные бланки 1С.
            </div>
            <div style="margin-bottom:10px;">
              <label class="field-label">Провайдер OCR</label>
              <select id="setOcrProvider" class="input-field">
                <option value="ocrspace" ${(s.ocrProvider||'ocrspace')==='ocrspace'?'selected':''}>OCR.space (без VPN)</option>
                <option value="gemini" ${s.ocrProvider==='gemini'?'selected':''}>Gemini Vision AI</option>
              </select>
            </div>
            <label class="field-label">OCR.space API Key</label>
            <div style="display:flex;gap:8px;margin-bottom:10px;">
              <input type="password" id="setOcrSpaceKey" class="input-field" placeholder="Оставьте пустым для демо-ключа" value="${escapeHtml(s.ocrSpaceKey || '')}">
              <button class="mini-btn" onclick="const i=document.getElementById('setOcrSpaceKey');i.type=i.type==='password'?'text':'password'">Показать</button>
            </div>
            <label class="field-label">Gemini API Key</label>
            <div style="display:flex;gap:8px;">
              <input type="password" id="setGeminiKey" class="input-field" placeholder="AIzaSy..." value="${escapeHtml(s.geminiKey || '')}">
              <button class="mini-btn" onclick="const i=document.getElementById('setGeminiKey');i.type=i.type==='password'?'text':'password'">Показать</button>
            </div>
          </section>

          <section class="glass-card">
            <h3 style="font-size:16px;font-weight:800;margin-bottom:6px;">Хранилище IndexedDB и бэкап</h3>
            <div style="font-size:12px;color:var(--text-secondary);margin-bottom:12px;">
              В базе: <b>${stats.ordersCount}</b> заказ-нарядов, <b>${stats.photosCount}</b> фото высокого качества (<b>${stats.photoMb} МБ</b>). Лимит снят.
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
              <button class="mini-btn" style="justify-content:center;padding:11px;" onclick="exportBackupJson()">Экспорт JSON</button>
              <button class="mini-btn" style="justify-content:center;padding:11px;" onclick="document.getElementById('jsonFileInput').click()">Импорт JSON</button>
            </div>
          </section>
        </div>
      </div>
    `;
    container.querySelectorAll('.bento-sticky-col .glass-card').forEach((card, i) => {
      card.classList.add('anim-card');
      card.style.animationDelay = `${i * 40}ms`;
    });
  }

  window.saveSettingsForm = async () => {
    haptic(14);
    state.settings.ocrProvider = document.getElementById('setOcrProvider').value || 'ocrspace';
    state.settings.ocrSpaceKey = document.getElementById('setOcrSpaceKey').value.trim();
    state.settings.geminiKey = document.getElementById('setGeminiKey').value.trim();
    state.settings.monthlySalaryKop = Math.round((parseFloat(document.getElementById('setSalary').value) || 0) * 100);
    state.settings.hourRateKop = Math.round((parseFloat(document.getElementById('setHourRate').value) || 0) * 100);
    const awH = parseFloat(document.getElementById('setAwPerHour').value) || 12;
    state.settings.awPerHour100 = Math.round(awH * 100);
    state.settings.awRateKop = Math.round(state.settings.hourRateKop / awH);
    state.settings.monthlyGoalKop = Math.round((parseFloat(document.getElementById('setGoalKop').value) || 200000) * 100);
    if (!state.settings.schedule) state.settings.schedule = { type: 'custom', startDate: todayIso, pattern: 'РРВВ' };
    state.settings.schedule.pattern = document.getElementById('setPattern').value.trim() || 'РРВВ';
    state.settings.schedule.startDate = document.getElementById('setSchedStart').value || todayIso;
    state.settings.theme = document.getElementById('setTheme').value;
    state.settings.splashEnabled = document.getElementById('setSplashEnabled').value !== '0';

    state.orders.forEach(o => {
      const baseAw = (o.jobs || []).reduce((s, j) => s + (j.aw100 || 0), 0);
      const m = calcOrderMetrics(baseAw || o.aw100 || 0, o.multiplier || 1);
      o.aw100 = m.aw100;
      o.hours100 = m.hours100;
      o.earningsKop = m.earningsKop;
    });

    await window.MDB.saveAllOrders(state.orders);
    await persistSettings();
    applyTheme();
    toast('Настройки сохранены и пересчитаны');
    render();
  };

  window.openGoalModal = () => {
    document.getElementById('goalMoneyInput').value = Math.round((state.settings.monthlyGoalKop || 20000000) / 100);
    document.getElementById('goalAwInput').value = state.settings.shiftGoalAw || 100;
    document.getElementById('goalModal').classList.add('open');
  };

  window.saveGoalSettings = async () => {
    haptic(12);
    state.settings.monthlyGoalKop = Math.round((parseFloat(document.getElementById('goalMoneyInput').value) || 200000) * 100);
    state.settings.shiftGoalAw = parseFloat(document.getElementById('goalAwInput').value) || 100;
    await persistSettings();
    document.getElementById('goalModal').classList.remove('open');
    toast('Цель обновлена');
    render();
  };

  window.exportBackupJson = async () => {
    haptic(14);
    const payload = await window.MDB.exportBackup(true);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    a.download = `normo-hours-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    toast('Полная резервная копия скачана');
  };

  document.getElementById('jsonFileInput').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(reader.result);
        const snap = parsed.snapshot || parsed;
        await window.MDB.importBackup(snap);
        toast('Резервная копия успешно восстановлена');
        initDatabaseAndState();
      } catch (err) {
        toast('Ошибка чтения JSON');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  // ===== ORDER EDITOR, PRESETS, VOICE & OCR =====
  const sheet = document.getElementById('orderSheet');
  document.getElementById('closeSheetBtn').onclick = () => sheet.classList.remove('open');
  sheet.onclick = (e) => { if (e.target === sheet) sheet.classList.remove('open'); };

  function renderPresetsChips() {
    const wrap = document.getElementById('presetsContainer');
    if (!wrap) return;
    const allPresets = [...state.customPresets, ...DEFAULT_PRESETS];
    wrap.innerHTML = allPresets.map(p =>
      `<button type="button" class="preset-chip" onclick="addPresetJob('${escapeHtml(p.title)}', ${p.aw})">${escapeHtml(p.title.split(' ').slice(0, 3).join(' '))} · ${p.aw} AW</button>`
    ).join('');
  }

  window.saveFirstJobAsPreset = async () => {
    const row = document.querySelector('#jobsList .job-item-row');
    if (!row) return;
    const title = row.querySelector('.job-title-inp').value.trim();
    const aw = parseFloat(row.querySelector('.job-aw-inp').value);
    if (!title || isNaN(aw) || aw <= 0) {
      toast('Введите название и AW в первой строке');
      return;
    }
    state.customPresets.unshift({ title, aw });
    await window.MDB.setMeta('customPresets', state.customPresets);
    renderPresetsChips();
    toast('Сохранено в быстрые шаблоны');
  };

  function removeJobRowSmooth(row, list) {
    if (list.children.length <= 1) return;
    haptic(8);
    row.classList.add('job-row-exit');
    setTimeout(() => { row.remove(); updateLiveCalc(); }, 210);
  }

  function renderJobInputs(jobs) {
    const list = document.getElementById('jobsList');
    list.innerHTML = '';
    (jobs && jobs.length ? jobs : [{ id: uid(), title: '', aw100: 0 }]).forEach(j => {
      const row = document.createElement('div');
      row.className = 'job-item-row';
      row.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:7px;';
      row.innerHTML = `
        <input type="text" class="input-field job-title-inp" placeholder="Работа..." value="${escapeHtml(j.title || '')}" style="flex:1;padding:9px 10px;">
        <input type="number" step="0.1" class="input-field job-aw-inp num" placeholder="AW" value="${j.aw100 ? j.aw100 / 100 : ''}" style="width:74px;padding:9px 6px;text-align:center;">
        <button type="button" class="mini-btn danger del-job-btn">✕</button>
      `;
      row.querySelector('.del-job-btn').onclick = () => removeJobRowSmooth(row, list);
      row.querySelector('.job-aw-inp').oninput = updateLiveCalc;
      list.appendChild(row);
    });
    updateLiveCalc();
  }

  window.addPresetJob = (title, aw) => {
    haptic(10);
    const list = document.getElementById('jobsList');
    const firstTitle = list.querySelector('.job-title-inp');
    const firstAw = list.querySelector('.job-aw-inp');
    if (firstTitle && !firstTitle.value.trim() && (!firstAw.value || firstAw.value === '0')) {
      firstTitle.value = title;
      firstAw.value = aw;
      updateLiveCalc();
      return;
    }
    const row = document.createElement('div');
    row.className = 'job-item-row job-row-enter';
    row.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:7px;';
    row.innerHTML = `
      <input type="text" class="input-field job-title-inp" placeholder="Работа..." value="${escapeHtml(title)}" style="flex:1;padding:9px 10px;">
      <input type="number" step="0.1" class="input-field job-aw-inp num" placeholder="AW" value="${aw}" style="width:74px;padding:9px 6px;text-align:center;">
      <button type="button" class="mini-btn danger del-job-btn">✕</button>
    `;
    row.querySelector('.del-job-btn').onclick = () => removeJobRowSmooth(row, list);
    row.querySelector('.job-aw-inp').oninput = updateLiveCalc;
    list.appendChild(row);
    updateLiveCalc();
  };

  document.getElementById('addJobBtn').onclick = () => { haptic(8); window.addPresetJob('', ''); };

  function updateLiveCalc() {
    let totalBaseAw100 = 0;
    document.querySelectorAll('#jobsList .job-aw-inp').forEach(inp => {
      const val = parseFloat(inp.value);
      if (!isNaN(val)) totalBaseAw100 += Math.round(val * 100);
    });
    const mult = parseFloat(document.getElementById('fMultiplier')?.value) || 1;
    const m = calcOrderMetrics(totalBaseAw100, mult);
    document.getElementById('liveCalcAw').textContent = `${m.aw} AW · ${m.hours.toFixed(2)} н/ч${mult !== 1 ? ' (x' + mult + ')' : ''}`;
    document.getElementById('liveCalcMoney').textContent = fmtRubDec(m.earningsKop);
  }
  window.updateLiveCalcGlobal = updateLiveCalc;

  window.openOrderModal = (presetDate) => {
    haptic(10);
    document.getElementById('sheetTitle').textContent = 'Новый заказ-наряд';
    document.getElementById('fId').value = '';
    document.getElementById('fNumber').value = '';
    document.getElementById('fDate').value = presetDate || anchorDate;
    document.getElementById('fBrand').value = 'BMW';
    document.getElementById('fModel').value = '';
    document.getElementById('fPlate').value = '';
    document.getElementById('fMultiplier').value = '1';
    document.getElementById('fStatus').value = 'confirmed';
    document.getElementById('fComment').value = '';
    activePhotoDataUrl = null;
    document.getElementById('photoPreviewBox').classList.add('hidden');
    document.getElementById('aiScanError').classList.add('hidden');
    renderPresetsChips();
    renderJobInputs([{ id: uid(), title: '', aw100: 0 }]);
    sheet.classList.add('open');
  };

  window.editOrder = async (id) => {
    haptic(10);
    const o = state.orders.find(x => x.id === id);
    if (!o) return;
    document.getElementById('sheetTitle').textContent = 'Редактировать З/Н';
    document.getElementById('fId').value = o.id;
    document.getElementById('fNumber').value = o.number || '';
    document.getElementById('fDate').value = o.date;
    document.getElementById('fBrand').value = o.brand || 'BMW';
    document.getElementById('fModel').value = o.model || '';
    document.getElementById('fPlate').value = o.plate || '';
    document.getElementById('fMultiplier').value = String(o.multiplier || 1);
    document.getElementById('fStatus').value = o.status || 'confirmed';
    document.getElementById('fComment').value = o.comment || '';
    activePhotoDataUrl = o.photoId ? await window.MDB.getPhoto(o.photoId) : null;
    if (activePhotoDataUrl) {
      document.getElementById('photoPreviewImg').src = activePhotoDataUrl;
      document.getElementById('photoPreviewBox').classList.remove('hidden');
    } else {
      document.getElementById('photoPreviewBox').classList.add('hidden');
    }
    renderPresetsChips();
    renderJobInputs(o.jobs);
    sheet.classList.add('open');
  };

  window.duplicateOrder = async (id) => {
    haptic(12);
    const o = state.orders.find(x => x.id === id);
    if (!o) return;
    const copy = JSON.parse(JSON.stringify(o));
    copy.id = uid();
    copy.photoId = null; // Не дублируем бинарное фото
    lastClonedId = copy.id;
    state.orders.unshift(copy);
    await window.MDB.saveOrder(copy);
    window.MDB.syncLightweightMirror(state);
    refreshStorageBadge();
    toast('Создана копия З/Н');
    render();
  };

  window.deleteOrder = async (id) => {
    haptic(14);
    const o = state.orders.find(x => x.id === id);
    if (!o) return;
    const card = document.querySelector(`.order-card[data-order-id="${id}"]`);
    const finishDelete = async () => {
      lastDeletedOrder = JSON.parse(JSON.stringify(o));
      lastDeletedPhoto = o.photoId ? await window.MDB.getPhoto(o.photoId) : null;
      if (o.photoId) await window.MDB.deletePhoto(o.photoId);
      state.orders = state.orders.filter(x => x.id !== id);
      await window.MDB.deleteOrder(id);
      window.MDB.syncLightweightMirror(state);
      refreshStorageBadge();
      render();

      toast('Заказ-наряд удалён', async () => {
        if (!lastDeletedOrder) return;
        state.orders.unshift(lastDeletedOrder);
        await window.MDB.saveOrder(lastDeletedOrder);
        if (lastDeletedOrder.photoId && lastDeletedPhoto) {
          await window.MDB.savePhoto(lastDeletedOrder.photoId, lastDeletedPhoto);
        }
        window.MDB.syncLightweightMirror(state);
        refreshStorageBadge();
        render();
        lastDeletedOrder = null;
      });
    };
    if (card) {
      card.classList.add('order-exit');
      setTimeout(finishDelete, 250);
    } else {
      finishDelete();
    }
  };

  window.viewPhoto = async (photoId) => {
    haptic(8);
    const src = await window.MDB.getPhoto(photoId);
    if (!src) { toast('Фото не найдено в базе'); return; }
    document.getElementById('viewerFullImg').src = src;
    document.getElementById('photoViewerModal').classList.add('open');
  };

  document.getElementById('removePhotoBtn').onclick = () => {
    haptic(8);
    activePhotoDataUrl = null;
    document.getElementById('photoPreviewBox').classList.add('hidden');
  };

  document.getElementById('orderForm').onsubmit = async (e) => {
    e.preventDefault();
    haptic(16);
    const id = document.getElementById('fId').value || uid();
    const jobs = [];
    let baseAw100 = 0;
    document.querySelectorAll('#jobsList .job-item-row').forEach(row => {
      const title = row.querySelector('.job-title-inp').value.trim();
      const aw = parseFloat(row.querySelector('.job-aw-inp').value);
      if (title || !isNaN(aw)) {
        const aw100 = Math.round((isNaN(aw) ? 0 : aw) * 100);
        baseAw100 += aw100;
        jobs.push({ id: uid(), title: title || 'Работа без названия', aw100 });
      }
    });

    const mult = parseFloat(document.getElementById('fMultiplier').value) || 1;
    const m = calcOrderMetrics(baseAw100, mult);
    const photoId = activePhotoDataUrl ? 'ph-' + id : null;
    if (photoId) await window.MDB.savePhoto(photoId, activePhotoDataUrl);

    const record = {
      id,
      number: document.getElementById('fNumber').value.trim(),
      brand: document.getElementById('fBrand').value.trim(),
      model: document.getElementById('fModel').value.trim(),
      plate: document.getElementById('fPlate').value.trim().toUpperCase(),
      date: document.getElementById('fDate').value,
      jobs,
      multiplier: mult,
      aw100: m.aw100,
      hours100: m.hours100,
      earningsKop: m.earningsKop,
      comment: document.getElementById('fComment').value.trim(),
      status: document.getElementById('fStatus').value,
      photoId
    };

    const idx = state.orders.findIndex(x => x.id === id);
    if (idx >= 0) state.orders[idx] = record;
    else state.orders.unshift(record);

    if (record.date) {
      anchorDate = record.date;
      selectedCalDay = record.date;
    }

    await window.MDB.saveOrder(record);
    window.MDB.syncLightweightMirror(state);
    refreshStorageBadge();
    sheet.classList.remove('open');
    toast('Заказ-наряд сохранён');
    render();
    triggerMSaveCelebration();
  };

  // ===== VOICE INPUT (Web Speech API) =====
  window.openVoiceOrder = () => {
    openOrderModal();
    setTimeout(() => startVoiceInput(), 250);
  };

  window.startVoiceInput = () => {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
      toast('Голосовой ввод не поддерживается этим браузером (используйте Chrome/Safari)');
      return;
    }
    haptic(15);
    const banner = document.getElementById('voiceListeningBanner');
    const txtEl = document.getElementById('voiceTranscriptText');
    banner.classList.remove('hidden');
    txtEl.textContent = 'Говорите... Например: "БМВ Х5 А777АА777 замена масла 4, колодки 8"';

    const rec = new SpeechRec();
    rec.lang = 'ru-RU';
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    let finalStr = '';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalStr += e.results[i][0].transcript + ' ';
        else interim += e.results[i][0].transcript;
      }
      txtEl.textContent = finalStr || interim || 'Слушаю...';
    };

    rec.onend = () => {
      banner.classList.add('hidden');
      const spoken = finalStr.trim();
      if (spoken) applyVoiceTranscript(spoken);
    };

    rec.onerror = (e) => {
      banner.classList.add('hidden');
      toast('Ошибка микрофона: ' + (e.error || 'проверьте разрешения'));
    };

    rec.start();
  };

  function applyVoiceTranscript(spoken) {
    const lower = spoken.toLowerCase();
    // Detect brand
    if (/бмв|bmw/i.test(lower)) document.getElementById('fBrand').value = 'BMW';
    else if (/мерседес|mercedes/i.test(lower)) document.getElementById('fBrand').value = 'Mercedes-Benz';
    else if (/ауди|audi/i.test(lower)) document.getElementById('fBrand').value = 'Audi';

    // Detect model
    const modM = spoken.match(/\b([xх][1-7]|m[2-8]|z4|[1-8]\d{2}[idxe]?)\b/i);
    if (modM) document.getElementById('fModel').value = modM[1].replace(/х/i, 'X').toUpperCase();

    // Detect plate
    const plM = spoken.match(/[авекмнорстухabekmhopctyx]\s*\d{3}\s*[авекмнорстухabekmhopctyx]{2}\s*\d{2,3}/i);
    if (plM) document.getElementById('fPlate').value = plM[0].replace(/\s+/g, '').toUpperCase();

    // Extract jobs paired with numbers (e.g. "замена масла 4", "передние колодки 8")
    const jobs = [];
    const segs = spoken.split(/,| и (?=[а-яa-z]+\s+.*?\d)/i);
    segs.forEach(seg => {
      const m = seg.match(/([а-яёa-z\s-]{4,}?)\s+(\d+(?:[.,]\d+)?)\s*(?:aw|ав|эйви|нормо|час)?\s*$/i);
      if (m) {
        let title = m[1].replace(/^(бмв|bmw|мерседес|ауди|[xх]\d)\s*/i, '').trim();
        title = title.charAt(0).toUpperCase() + title.slice(1);
        const aw = parseFloat(m[2].replace(',', '.'));
        if (title.length > 2 && aw > 0) jobs.push({ id: uid(), title, aw100: Math.round(aw * 100) });
      }
    });

    if (jobs.length) renderJobInputs(jobs);
    else document.getElementById('fComment').value = spoken;
    toast(jobs.length ? `Распознано работ: ${jobs.length}` : 'Речь добавлена в комментарий');
  }

  // ===== TEXT PASTE & OCR PARSING (Preserved from v16) =====
  window.parsePastedText = () => {
    const txt = document.getElementById('pasteRawArea').value || '';
    document.getElementById('textPasteSheet').classList.remove('open');
    openOrderModal();
    const parsed = parseBmwOrderText(txt);
    if (parsed.number) document.getElementById('fNumber').value = parsed.number;
    if (parsed.date) document.getElementById('fDate').value = parsed.date;
    if (parsed.brand) document.getElementById('fBrand').value = parsed.brand;
    if (parsed.model) document.getElementById('fModel').value = parsed.model;
    if (parsed.plate) document.getElementById('fPlate').value = parsed.plate;
    if (parsed.jobs && parsed.jobs.length) {
      renderJobInputs(parsed.jobs.map(j => ({ id: uid(), title: j.title || '', aw100: Math.round((parseFloat(j.aw) || 0) * 100) })));
    }
    toast(parsed.jobs.length ? `Разобрано работ: ${parsed.jobs.length}` : 'Текст разобран');
  };

  function parseBmwOrderText(txt) {
    const res = { number: '', date: '', brand: 'BMW', model: '', plate: '', jobs: [] };
    if (!txt) return res;
    const norm = txt.replace(/\r/g, '');

    const numM = norm.match(/(?:Заказ-наряд|З\/Н|Заказ\s*наряд)\s*(?:№|#|:)?\s*(\d{6,10})/i)
      || norm.match(/\b(78\d{5,7})\b/) || norm.match(/№\s*(\d{6,10})/);
    if (numM) res.number = numM[1];

    const curYear = new Date().getFullYear();
    const foundDates = [];
    for (const m of norm.matchAll(/(\d{2})\.(\d{2})\.(20\d{2}|\d{2})(?!\d)/g)) {
      const dd = parseInt(m[1], 10), mm = parseInt(m[2], 10);
      let yy = parseInt(m[3], 10);
      if (yy < 100) yy += 2000;
      if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12 && yy >= 2020 && yy <= curYear + 2) {
        foundDates.push({ iso: `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`, yy });
      }
    }
    if (foundDates.length) {
      const best = foundDates.find(d => d.yy === curYear) || foundDates.find(d => d.yy <= curYear) || foundDates[0];
      res.date = best.iso;
    }

    const plateM = norm.match(/[АВЕКМНОРСТУХABEKMHOPCTYX]\s*\d{3}\s*[АВЕКМНОРСТУХABEKMHOPCTYX]{2}\s*\d{2,3}/i);
    if (plateM) res.plate = plateM[0].replace(/\s+/g, '').toUpperCase();

    const modelM = norm.match(/\bBMW\s+([XХZM]\d(?:\s*M)?|[1-8]\s*серии|[1-8]\d{2}[idxe]?)/i)
      || norm.match(/(?:^|\s)([XХ][1-7]|Z4|M[2-8]|[1-8]\s*серии|[1-8]\d{2}[idxe])(?=\s|$)/i);
    if (modelM) res.model = modelM[1].replace(/Х/g, 'X').trim();

    const lines = norm.split('\n').map(l => l.replace(/\t+/g, ' ').replace(/\s{2,}/g, ' ').trim()).filter(Boolean);
    const titles = [], awValues = [];
    const headerOrAddrRe = /^(код|описание|ед\.?\s*изм|работа|итого|всего|ндс|нетто|скидка|сумма|город|г\.|химки|москва|область|шоссе|улица|ул\.|владен|россия|домашний|рабочий|моб|дата|время приема|время выдачи|марка|модель|vin|пробег|гос|заказчик|исполнитель|мастер|подпись|комплект расходных|смазки)/i;
    const skipLineRe = /(?:\+7|8\s*\(\d{3}\)|к-во|ед\.?\s*изм|цена\s+ндс|сумма\s+ндс|всего\s+rub|\b(?:комп|шт|л)\s+\d+[.,]\d+)/i;

    lines.forEach(l => {
      if (skipLineRe.test(l)) return;
      const awM = l.match(/(?:^|\s)[AА][WШV]\s+\d+[.,]\d+\s+(\d+(?:[.,]\d+)?)(?=\s|$)/i);
      if (awM) {
        const v = parseFloat(awM[1].replace(',', '.'));
        if (v > 0 && v <= 300) awValues.push(v);
      }
      const codeM = l.match(/(?:^|\s)(?:\d{7,8}|SERV\d{2,4})\s+([А-ЯЁA-Z].*)/i);
      if (codeM) {
        const desc = codeM[1].replace(/\s+[AА][WШV]\b.*$/i, '').replace(/\s+\d+[.,]\d+.*$/, '').trim();
        if (desc.length >= 4 && !headerOrAddrRe.test(desc)) titles.push(desc);
        return;
      }
      if (/[AА][WШV]\s+\d+[.,]\d+/i.test(l) || /^(время работы|выполнение|замена|диагностика|проверка|снятие|установка|регулировка|программирование|кодирование|[мm][оo0]йка|уборка|обслуживание|ремонт|прокачка|сход|развал|балансировка|шиномонтаж|осмотр|чтение|сброс)/i.test(l)) {
        const desc = l.replace(/^(?:\d{5,8}|SERV\d{2,4})\s+/i, '').replace(/\s+[AА][WШV]\b.*$/i, '').replace(/\s+\d+[.,]\d+.*$/, '').trim();
        if (desc.length >= 5 && !headerOrAddrRe.test(desc) && !/^\d+$/.test(desc)) titles.push(desc);
      }
    });

    const count = Math.max(titles.length, awValues.length);
    for (let i = 0; i < count; i++) {
      res.jobs.push({ title: titles[i] || `Работа ${i + 1}`, aw: awValues[i] || 0 });
    }
    return res;
  }

  // ===== CAMERA / GALLERY OCR =====
  window.triggerPhoto = (source) => {
    haptic(8);
    if (!sheet.classList.contains('open')) openOrderModal();
    if (source === 'camera') document.getElementById('cameraInput').click();
    else document.getElementById('galleryInput').click();
  };

  function compressImage(file, maxW = 1280, quality = 0.8) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, maxW / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function callOcrSpace(apiKey, dataUrl) {
    const form = new FormData();
    form.append('base64Image', dataUrl);
    form.append('language', 'rus');
    form.append('OCREngine', '2');
    form.append('isTable', 'true');
    form.append('scale', 'true');
    const resp = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST', headers: { 'apikey': apiKey || 'helloworld' }, body: form
    });
    const json = await resp.json();
    if (!resp.ok || json.IsErroredOnProcessing) throw new Error(json.ErrorMessage || `HTTP ${resp.status}`);
    const text = (json.ParsedResults || []).map(r => r.ParsedText || '').join('\n').trim();
    if (!text) throw new Error('Текст на фото не найден');
    return parseBmwOrderText(text);
  }

  async function callGeminiVision(apiKey, modelName, prompt, base64Data) {
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: base64Data } }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 1024 }
      })
    });
    const json = await resp.json();
    if (!resp.ok) throw new Error(json.error?.message || `HTTP ${resp.status}`);
    return json;
  }

  async function handlePhotoSelected(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const errBox = document.getElementById('aiScanError');
    const banner = document.getElementById('aiScanStatus');
    const previewBox = document.getElementById('photoPreviewBox');
    errBox.classList.add('hidden');

    try {
      const provider = state.settings.ocrProvider || 'ocrspace';
      const dataUrl = await compressImage(file, 1280, 0.8);
      activePhotoDataUrl = dataUrl;
      document.getElementById('photoPreviewImg').src = dataUrl;
      previewBox.classList.remove('hidden');
      previewBox.classList.add('scanning');
      banner.classList.remove('hidden');

      let parsed = null;
      if (provider === 'ocrspace') {
        parsed = await callOcrSpace((state.settings.ocrSpaceKey || '').trim() || 'helloworld', dataUrl);
      } else {
        const apiKey = (state.settings.geminiKey || '').trim();
        if (!apiKey) {
          banner.classList.add('hidden');
          previewBox.classList.remove('scanning');
          toast('Фото прикреплено (добавьте ключ Gemini в Настройках)');
          return;
        }
        const prompt = 'Извлеки из заказ-наряда JSON: {"number":"","date":"YYYY-MM-DD","brand":"BMW","model":"","plate":"","jobs":[{"title":"","aw":0}]}. Только выполненные работы без кодов и цен запчастей.';
        const mName = state.settings.workingModel || 'gemini-2.5-flash';
        const json = await callGeminiVision(apiKey, mName, prompt, dataUrl.split(',')[1]);
        const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        parsed = JSON.parse(rawText.replace(/^```json\s*/i, '').replace(/```$/i, '').trim());
      }

      banner.classList.add('hidden');
      previewBox.classList.remove('scanning');
      if (parsed) {
        if (parsed.number) document.getElementById('fNumber').value = parsed.number;
        if (parsed.date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) document.getElementById('fDate').value = parsed.date;
        if (parsed.brand) document.getElementById('fBrand').value = parsed.brand;
        if (parsed.model) document.getElementById('fModel').value = parsed.model;
        if (parsed.plate) document.getElementById('fPlate').value = parsed.plate;
        if (Array.isArray(parsed.jobs) && parsed.jobs.length) {
          renderJobInputs(parsed.jobs.map(j => ({ id: uid(), title: j.title || '', aw100: Math.round((parseFloat(j.aw) || 0) * 100) })));
        }
        toast('Бланк распознан');
      }
    } catch (err) {
      banner.classList.add('hidden');
      previewBox.classList.remove('scanning');
      errBox.textContent = 'Ошибка OCR: ' + (err.message || 'проверьте сеть/ключ');
      errBox.classList.remove('hidden');
      toast('Фото прикреплено, ошибка OCR');
    }
  }

  document.getElementById('cameraInput').onchange = handlePhotoSelected;
  document.getElementById('galleryInput').onchange = handlePhotoSelected;

  // ===== IGNITION SPLASH, AUDIO PULSE, DRIVE MODES & VISUALS =====
  let splashTimer = null;
  let splashStatusTimer = null;

  function playIgnitionAudioChime() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const now = ctx.currentTime;

      // Subtle futuristic bass pulse + dual harmonic BMW welcome chime
      const oscLow = ctx.createOscillator();
      const gainLow = ctx.createGain();
      oscLow.type = 'sine';
      oscLow.frequency.setValueAtTime(52, now);
      oscLow.frequency.exponentialRampToValueAtTime(98, now + 0.55);
      gainLow.gain.setValueAtTime(0.001, now);
      gainLow.gain.exponentialRampToValueAtTime(0.14, now + 0.12);
      gainLow.gain.exponentialRampToValueAtTime(0.001, now + 0.85);
      oscLow.connect(gainLow).connect(ctx.destination);
      oscLow.start(now);
      oscLow.stop(now + 0.9);

      [523.25, 659.25].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + 0.35 + i * 0.14);
        g.gain.setValueAtTime(0.001, now + 0.35 + i * 0.14);
        g.gain.exponentialRampToValueAtTime(0.05, now + 0.38 + i * 0.14);
        g.gain.exponentialRampToValueAtTime(0.001, now + 1.05 + i * 0.14);
        osc.connect(g).connect(ctx.destination);
        osc.start(now + 0.35 + i * 0.14);
        osc.stop(now + 1.15 + i * 0.14);
      });
    } catch (e) {}
  }

  window.closeBmwSplash = () => {
    const el = document.getElementById('bmwSplash');
    if (!el || el.classList.contains('gone')) return;
    clearTimeout(splashTimer);
    clearTimeout(splashStatusTimer);
    el.classList.add('closing');
    setTimeout(() => {
      el.classList.add('gone');
      el.classList.remove('closing', 'igniting');
    }, 560);
  };

  window.playBmwIgnition = (force = false) => {
    const el = document.getElementById('bmwSplash');
    if (!el) return;
    if (!force && state.settings.splashEnabled === false) {
      el.classList.add('gone');
      return;
    }

    clearTimeout(splashTimer);
    clearTimeout(splashStatusTimer);
    const stEl = document.getElementById('splashStatusText');

    if (force) {
      haptic(18);
      playIgnitionAudioChime();
      el.classList.remove('gone', 'closing', 'igniting');
      void el.offsetWidth;
      el.classList.add('igniting');
      if (stEl) stEl.textContent = 'WELCOME LIGHTS · IGNITION';
    }

    splashStatusTimer = setTimeout(() => {
      if (stEl && !el.classList.contains('gone')) {
        stEl.textContent = 'M-TELEMETRY · SYSTEM READY';
      }
    }, 1050);

    splashTimer = setTimeout(() => window.closeBmwSplash(), force ? 2550 : 2300);
  };

  // Fallback safeguard: always close startup splash within 2.6s even if IndexedDB is slow
  if (!document.getElementById('bmwSplash')?.classList.contains('gone')) {
    splashStatusTimer = setTimeout(() => {
      const stEl = document.getElementById('splashStatusText');
      if (stEl) stEl.textContent = 'M-TELEMETRY · SYSTEM READY';
    }, 1050);
    splashTimer = setTimeout(() => window.closeBmwSplash(), 2450);
  }

  window.revAppLogo = () => {
    haptic(12);
    document.querySelectorAll('.app-icon-box').forEach(el => {
      el.classList.remove('torque-spin');
      void el.offsetWidth;
      el.classList.add('torque-spin');
    });
  };

  window.cycleDriveMode = async () => {
    haptic(14);
    const modes = ['comfort', 'sport', 'mcs'];
    const labels = {
      comfort: 'COMFORT · ICE BLUE',
      sport: 'M1 MODE · SPORT+',
      mcs: 'M CS · RACING GOLD'
    };
    const cur = state.settings.driveMode || 'comfort';
    const next = modes[(modes.indexOf(cur) + 1) % modes.length];
    state.settings.driveMode = next;
    applyTheme();
    await persistSettings();

    const bar = document.getElementById('mSaveFlash');
    if (bar) {
      bar.classList.remove('fire');
      void bar.offsetWidth;
      bar.classList.add('fire');
      setTimeout(() => bar.classList.remove('fire'), 900);
    }
    const hud = document.getElementById('modeHudBanner');
    const hudTxt = document.getElementById('modeHudText');
    if (hud && hudTxt) {
      hudTxt.textContent = labels[next];
      hud.classList.add('show');
      clearTimeout(modeBannerTimer);
      modeBannerTimer = setTimeout(() => hud.classList.remove('show'), 1800);
    }
  };

  function spawnMSparks() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const colors = ['#00A0E3', '#1D4ED8', '#E22718', '#F8FAFC', '#10B981'];
    const cx = window.innerWidth / 2;
    const cy = Math.min(220, window.innerHeight * 0.28);
    for (let i = 0; i < 16; i++) {
      const sp = document.createElement('span');
      sp.className = 'm-spark';
      const angle = (Math.PI * 2 * i) / 16 + (Math.random() - 0.5) * 0.35;
      const dist = 55 + Math.random() * 85;
      sp.style.left = cx + 'px';
      sp.style.top = cy + 'px';
      sp.style.background = colors[i % colors.length];
      sp.style.boxShadow = `0 0 8px ${colors[i % colors.length]}`;
      sp.style.setProperty('--dx', Math.round(Math.cos(angle) * dist) + 'px');
      sp.style.setProperty('--dy', Math.round(Math.sin(angle) * dist) + 'px');
      document.body.appendChild(sp);
      setTimeout(() => sp.remove(), 760);
    }
  }

  function triggerMSaveCelebration() {
    const bar = document.getElementById('mSaveFlash');
    if (bar) {
      bar.classList.remove('fire');
      void bar.offsetWidth;
      bar.classList.add('fire');
      setTimeout(() => bar.classList.remove('fire'), 900);
    }
    const hero = document.getElementById('ordersHeroCard');
    if (hero) {
      hero.classList.remove('hero-pulse-ok');
      void hero.offsetWidth;
      hero.classList.add('hero-pulse-ok');
    }
    spawnMSparks();
  }

  function animateTelemetryNumbers(targetKop, targetAw, targetHours) {
    const key = `${periodMode}|${anchorDate}|${targetKop}|${targetAw}`;
    if (key === lastTelemetryKey) return;
    lastTelemetryKey = key;

    const moneyEl = document.getElementById('heroTotalMoney');
    const awEl = document.getElementById('heroTotalAw');
    const hoursEl = document.getElementById('heroTotalHours');
    if (!moneyEl || !awEl || !hoursEl) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    cancelAnimationFrame(telemetryRaf);
    const startTs = performance.now();
    const dur = 420;
    const step = (now) => {
      const p = Math.min(1, (now - startTs) / dur);
      const ease = 1 - Math.pow(1 - p, 3);
      moneyEl.textContent = fmtRub(Math.round(targetKop * ease));
      awEl.textContent = Math.round(targetAw * ease).toString();
      hoursEl.textContent = (targetHours * ease).toFixed(1).replace('.', ',');
      if (p < 1) telemetryRaf = requestAnimationFrame(step);
      else {
        moneyEl.textContent = fmtRub(targetKop);
        awEl.textContent = targetAw.toFixed(0);
        hoursEl.textContent = targetHours.toFixed(1).replace('.', ',');
      }
    };
    telemetryRaf = requestAnimationFrame(step);
  }

  // Global Tactile Touch Ripple
  document.addEventListener('pointerdown', (e) => {
    const host = e.target.closest('.bmw-ripple-host, .btn-primary-cta, .btn-primary-full');
    if (!host || e.target.closest('button.mini-btn')) return;
    const rect = host.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 0.45;
    const r = document.createElement('span');
    r.className = 'bmw-ripple';
    r.style.width = r.style.height = size + 'px';
    r.style.left = (e.clientX - rect.left - size / 2) + 'px';
    r.style.top = (e.clientY - rect.top - size / 2) + 'px';
    host.appendChild(r);
    setTimeout(() => r.remove(), 580);
  }, { passive: true });

  // Subtle Ambient Orb Scroll Parallax
  let scrollTicking = false;
  window.addEventListener('scroll', () => {
    if (scrollTicking) return;
    scrollTicking = true;
    requestAnimationFrame(() => {
      const y = window.scrollY || 0;
      const o1 = document.querySelector('.orb-1');
      const o2 = document.querySelector('.orb-2');
      if (o1) o1.style.translate = `0 ${Math.min(55, y * 0.14)}px`;
      if (o2) o2.style.translate = `0 ${-Math.min(50, y * 0.11)}px`;
      scrollTicking = false;
    });
  }, { passive: true });

  window.toggleThemeQuick = async () => {
    haptic(10);
    state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    await persistSettings();
  };

  function render() {
    document.getElementById('pageHeaderTitle').textContent = TAB_TITLES[currentTab] || 'Нормо-часы';
    updateDockPill();
    const main = document.getElementById('mainView');
    const isTabChange = prevRenderedTab && prevRenderedTab !== currentTab;
    prevRenderedTab = currentTab;
    if (currentTab === 'orders') renderOrders(main);
    else if (currentTab === 'schedule') renderSchedule(main);
    else if (currentTab === 'stats') renderStats(main);
    else if (currentTab === 'history') renderHistory(main);
    else if (currentTab === 'settings') renderSettings(main);
    if (isTabChange) {
      main.classList.remove('view-enter');
      void main.offsetWidth;
      main.classList.add('view-enter');
    }
    navSlideDir = 0;
  }

  initDatabaseAndState();
})();
