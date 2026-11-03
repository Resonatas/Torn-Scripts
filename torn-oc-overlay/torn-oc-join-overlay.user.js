// ==UserScript==
// @name         Torn OC Join Overlay
// @namespace    https://github.com/local/torn-oc-join-overlay
// @version      0.1.0
// @description  Read-only overlay on the faction OC recruiting list: shows which open slots your own CPR qualifies for.
// @match        *://www.torn.com/factions.php*
// @match        *://torn.com/factions.php*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @connect      raw.githubusercontent.com
// @connect      gist.githubusercontent.com
// ==/UserScript==

/*
 * READ-ONLY: this script never clicks, joins or submits anything. It only reads
 * the page and adds badges / classes / a control bar.
 *
 * STATUS OF THE SELECTORS: written WITHOUT access to the live Torn DOM.
 * By default nothing depends on Torn's (hashed) class names. Panels, slots and
 * values are found from the visible TEXT ("8/10", "Join", numbers, role names).
 * If Torn's markup defeats that, fill in SELECTOR_HINTS below (use the
 * "Copy debug dump" button in the Requirements window to see the real markup).
 */
(function () {
  'use strict';

  // ===================================================================
  // CONFIG SECTION (edit here if you must; requirements live in the editor)
  // ===================================================================

  // Optional CSS selector overrides. Leave '' to use text-based detection.
  // panel: one OC. level/name: inside panel. slot: closest ancestor of a Join
  // button that is one slot. role/cpr: inside slot. join: the Join button.
  const SELECTOR_HINTS = { panel: '', level: '', name: '', slot: '', role: '', cpr: '', join: '' };

  const API_COOLDOWN_MS = 30 * 1000;         // never call the API more often than this
  const AUTO_CHECK_INTERVAL_MS = 60 * 60 * 1000; // remote requirements check: max once per hour
  const RENDER_DEBOUNCE_MS = 300;
  const API_COMMENT = 'OC-Join-Overlay';

  // Built-in default requirements (the editor can replace these; Reset restores them).
  const DEFAULT_CONFIG = {
    schemaVersion: 1,
    lastUpdated: '2026-11-04',
    defaults: { unlistedMin: 65, alwaysPassLevels: [5, 6], notSpawnedLevels: [1, 2, 3, 4] },
    ocs: {
      'Blast From The Past': { level: 7, roles: { 'Muscle': 70, 'Engineer': 70, 'Bomber': 65, 'Picklock 1': 65, 'Hacker': 65, 'Picklock 2': 65 } },
      'Clinical Precision': { level: 8, roles: { 'Imitator': 70, 'Cleaner': 65, 'Cat Burglar': 65, 'Assassin': 65 } },
      'Break The Bank': { level: 8, roles: { 'Muscle 3': 70, 'Thief 2': 70, 'Muscle 1': 65, 'Robber': 65, 'Muscle 2': 65, 'Thief 1': 65 } },
      'Stacking The Deck': { level: 8, roles: { 'Imitator': 65, 'Hacker': 60, 'Cat Burglar': 60, 'Driver': 55 } },
      'Manifest Cruelty': { level: 8, roles: { 'Interrogator': 60, 'Hacker': 60, 'Cat Burglar': 60, 'Reviver': 55 } },
      'Ace in the Hole': { level: 9, roles: { 'Hacker': 55, 'Imitator': 55, 'Muscle 2': 55, 'Muscle 1': 55, 'Driver': 50 } },
      'Gone Fission': { level: 9, roles: { '*': 55 } },
      'Crane Reaction': { level: 10, roles: { 'Sniper': 55, 'Lookout': 50, 'Bomber': 50, 'Muscle 1': 50, 'Muscle 2': 50, 'Engineer': 50 } },
    },
  };

  // ===================================================================
  // STORAGE (GM_* with localStorage fallback for TornPDA)
  // ===================================================================
  const store = {
    get(key, dflt) {
      try {
        if (typeof GM_getValue === 'function') {
          const v = GM_getValue(key);
          return v === undefined ? dflt : v;
        }
      } catch (e) { /* fall through */ }
      try {
        const raw = localStorage.getItem('ocjo_' + key);
        return raw === null ? dflt : JSON.parse(raw);
      } catch (e) { return dflt; }
    },
    set(key, value) {
      try {
        if (typeof GM_setValue === 'function') { GM_setValue(key, value); return; }
      } catch (e) { /* fall through */ }
      try { localStorage.setItem('ocjo_' + key, JSON.stringify(value)); } catch (e) { /* ignore */ }
    },
  };

  const DEFAULT_SETTINGS = { joinableOnly: false, remoteUrl: '', autoCheck: false, apiMode: false };
  let settings = Object.assign({}, DEFAULT_SETTINGS, store.get('settings', {}));
  let config = loadConfig();
  let apiCrimes = null;        // last API result (array) or null
  let apiStatus = '';          // one-line status for the bar
  let apiHalted = false;       // true after a fatal key error
  let lastScan = [];           // last DOM scan, for the API cross-check
  const warned = new Set();    // de-duplicate console warnings

  function saveSettings() { store.set('settings', settings); }

  function loadConfig() {
    const raw = store.get('config', null);
    if (raw) {
      try {
        const c = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (validateConfig(c).length === 0) return c;
      } catch (e) { /* use defaults */ }
    }
    return clone(DEFAULT_CONFIG);
  }
  function saveConfig(c) { config = c; store.set('config', JSON.stringify(c)); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // ===================================================================
  // REQUIREMENTS: validation, lookup, evaluation
  // ===================================================================
  const isPct = (n) => typeof n === 'number' && isFinite(n) && n >= 0 && n <= 100;
  const isLevel = (n) => Number.isInteger(n) && n >= 1 && n <= 10;

  function validateConfig(c) {
    const errs = [];
    if (!c || typeof c !== 'object' || Array.isArray(c)) return ['Top level must be a JSON object.'];
    if (c.schemaVersion !== 1) errs.push('schemaVersion must be 1.');
    if (c.lastUpdated !== undefined && isNaN(Date.parse(c.lastUpdated))) errs.push('lastUpdated must be a date like "2026-11-04".');
    const d = c.defaults;
    if (!d || typeof d !== 'object') {
      errs.push('"defaults" is missing.');
    } else {
      if (!isPct(d.unlistedMin)) errs.push('defaults.unlistedMin must be a number from 0 to 100.');
      ['alwaysPassLevels', 'notSpawnedLevels'].forEach((k) => {
        if (!Array.isArray(d[k]) || !d[k].every(isLevel)) errs.push('defaults.' + k + ' must be an array of levels 1-10.');
      });
    }
    if (!c.ocs || typeof c.ocs !== 'object' || Array.isArray(c.ocs)) {
      errs.push('"ocs" must be an object keyed by OC name.');
    } else {
      Object.keys(c.ocs).forEach((name) => {
        const oc = c.ocs[name];
        if (!oc || typeof oc !== 'object') { errs.push('ocs["' + name + '"] must be an object.'); return; }
        if (oc.level !== undefined && !isLevel(oc.level)) errs.push('ocs["' + name + '"].level must be 1-10.');
        if (!oc.roles || typeof oc.roles !== 'object' || Array.isArray(oc.roles) || !Object.keys(oc.roles).length) {
          errs.push('ocs["' + name + '"].roles must be an object with at least one role (use "*" for all roles).');
          return;
        }
        Object.keys(oc.roles).forEach((r) => {
          if (!isPct(oc.roles[r])) errs.push('ocs["' + name + '"].roles["' + r + '"] must be a number 0-100.');
        });
      });
    }
    return errs;
  }

  const normName = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  // "Muscle #1" -> "muscle 1", "Picklock  #2" -> "picklock 2"
  const normRole = (s) => String(s).toLowerCase().replace(/#/g, ' ').replace(/\s+/g, ' ').trim();
  const stripTrailingNumber = (r) => r.replace(/\s*\d+$/, '');

  function findOc(cfg, ocName) {
    const want = normName(ocName);
    const key = Object.keys(cfg.ocs).find((k) => normName(k) === want);
    return key ? cfg.ocs[key] : null;
  }

  /**
   * Decide what a slot needs.
   * Returns {kind:'skip'} | {kind:'any'|'listed'|'unlisted', req, pass, short}
   */
  function evaluate(cfg, ocName, level, role, cpr) {
    const d = cfg.defaults;
    if (d.notSpawnedLevels.includes(level)) return { kind: 'skip' };
    if (d.alwaysPassLevels.includes(level)) return { kind: 'any', req: 0, pass: true, short: 0 };
    let req = null;
    const oc = findOc(cfg, ocName);
    if (oc) {
      const roles = {};
      Object.keys(oc.roles).forEach((k) => { roles[normRole(k)] = oc.roles[k]; });
      const r = normRole(role);
      const hit = [r, stripTrailingNumber(r), '*'].find((k) => roles[k] !== undefined);
      if (hit !== undefined) req = roles[hit];
    }
    const kind = req === null ? 'unlisted' : 'listed';
    if (req === null) req = d.unlistedMin;
    const pass = cpr >= req;
    return { kind, req, pass, short: pass ? 0 : req - cpr };
  }

  // ===================================================================
  // DOM READING (text based; see SELECTOR_HINTS to override)
  // ===================================================================
  const LEVEL_RE = /^\s*(\d{1,2})\s*\/\s*10\s*$/;
  const TIMER_RE = /^\s*(\d+\s*[dhms]\s*)+$|^\s*\d{1,2}(:\d{2}){1,2}\s*$/i;
  const NOISE_RE = /^\s*(join|hrs?|hours?|\d+\s*hrs?)\s*$/i;

  function isOurs(node) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    return !!(el && el.closest && el.closest('.ocjo'));
  }

  function textNodes(root) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (!n.nodeValue.trim()) continue;
      const p = n.parentElement;
      if (!p || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName) || isOurs(n)) continue;
      out.push(n);
    }
    return out;
  }

  const isNoise = (t) => NOISE_RE.test(t) || TIMER_RE.test(t) || LEVEL_RE.test(t);
  const isNumber = (t) => /^\d{1,3}\s*%?$/.test(t.trim());

  function findPanels() {
    if (SELECTOR_HINTS.panel) {
      return Array.from(document.querySelectorAll(SELECTOR_HINTS.panel)).filter((p) => !isOurs(p));
    }
    // Every "N/10" text marks one OC. Climb while the parent still holds only that one level.
    const levelEls = textNodes(document.body).filter((n) => LEVEL_RE.test(n.nodeValue)).map((n) => n.parentElement);
    const panels = [];
    levelEls.forEach((lv) => {
      let cur = lv;
      while (cur.parentElement && cur.parentElement !== document.body &&
             levelEls.filter((e) => cur.parentElement.contains(e)).length === 1 &&
             !cur.parentElement.querySelector('.ocjo-bar')) {
        cur = cur.parentElement;
      }
      if (!panels.includes(cur)) panels.push(cur);
    });
    return panels;
  }

  function readLevel(panel) {
    let text = null;
    if (SELECTOR_HINTS.level) {
      const e = panel.querySelector(SELECTOR_HINTS.level);
      text = e ? e.textContent : null;
    } else {
      const n = textNodes(panel).find((x) => LEVEL_RE.test(x.nodeValue));
      text = n ? n.nodeValue : null;
    }
    const m = text && text.match(/(\d{1,2})\s*\/\s*10/);
    return m ? parseInt(m[1], 10) : null;
  }

  function findJoins(panel) {
    if (SELECTOR_HINTS.join) return Array.from(panel.querySelectorAll(SELECTOR_HINTS.join));
    const out = [];
    textNodes(panel).forEach((n) => {
      if (/^\s*join\s*$/i.test(n.nodeValue)) {
        const el = n.parentElement.closest('button,a,[role="button"]') || n.parentElement;
        if (!out.includes(el)) out.push(el);
      }
    });
    return out;
  }

  // Role and CPR from the text inside one element (skipping Join / "24hrs" noise).
  function readRoleAndCpr(container) {
    const nodes = textNodes(container);
    let role = null;
    let cpr = null;
    nodes.forEach((n, i) => {
      const t = n.nodeValue.trim();
      if (NOISE_RE.test(t) || TIMER_RE.test(t)) return;
      if (isNumber(t)) {
        const next = nodes[i + 1] && nodes[i + 1].nodeValue.trim();
        if (next && /^hrs?$|^hours?$/i.test(next)) return; // "24" + "hrs" split in two nodes
        if (cpr === null) cpr = parseInt(t, 10);
      } else if (role === null) {
        const m = t.match(/^(.*?[a-z#\d])\s+(\d{1,3})\s*%?$/i); // "Engineer 61" in one node
        if (m && /[a-z]/i.test(m[1]) && cpr === null) { role = m[1].trim(); cpr = parseInt(m[2], 10); } else { role = t; }
      }
    });
    return { role, cpr };
  }

  // Smallest ancestor of the Join button that holds both a role name and a number.
  function readSlot(joinEl, panel) {
    if (SELECTOR_HINTS.slot) {
      const slot = joinEl.closest(SELECTOR_HINTS.slot);
      if (!slot) return null;
      const r = SELECTOR_HINTS.role && slot.querySelector(SELECTOR_HINTS.role);
      const c = SELECTOR_HINTS.cpr && slot.querySelector(SELECTOR_HINTS.cpr);
      const auto = readRoleAndCpr(slot);
      const cprNum = c ? parseInt(c.textContent, 10) : auto.cpr;
      return { el: slot, role: r ? r.textContent.trim() : auto.role, cpr: isNaN(cprNum) ? null : cprNum };
    }
    let cur = joinEl.parentElement;
    while (cur && cur !== panel) {
      const rc = readRoleAndCpr(cur);
      if (rc.role && rc.cpr !== null) return { el: cur, role: rc.role, cpr: rc.cpr };
      cur = cur.parentElement;
    }
    return null;
  }

  function readName(panel, slotEls) {
    if (SELECTOR_HINTS.name) {
      const e = panel.querySelector(SELECTOR_HINTS.name);
      if (e) return e.textContent.trim();
    }
    let first = null;
    const nodes = textNodes(panel);
    for (let i = 0; i < nodes.length; i++) {
      const t = nodes[i].nodeValue.trim();
      if (slotEls.some((s) => s.contains(nodes[i]))) continue;
      if (isNoise(t) || isNumber(t) || !/[a-z]/i.test(t) || t.length < 3) continue;
      if (findOc(config, t)) return t;       // a name we know beats a guess
      if (first === null) first = t;
    }
    return first || '(unknown OC)';
  }

  /** Read the whole page: [{el, level, name, slots:[{el, role, cpr, res}]}] */
  function scanPage() {
    const result = [];
    findPanels().forEach((panel) => {
      const level = readLevel(panel);
      if (level === null) return;
      const slots = [];
      findJoins(panel).forEach((j) => {
        const s = readSlot(j, panel);
        if (s && s.role && s.cpr !== null && !slots.some((x) => x.el === s.el)) slots.push(s);
        else warnOnce('slot', 'Could not read role/CPR for a Join button; see "Copy debug dump".');
      });
      const name = readName(panel, slots.map((s) => s.el));
      slots.forEach((s) => { s.res = evaluate(config, name, level, s.role, s.cpr); });
      result.push({ el: panel, level, name, slots });
    });
    return result;
  }

  function warnOnce(key, msg) {
    if (warned.has(key + msg)) return;
    warned.add(key + msg);
    console.warn('[OC Join Overlay] ' + msg);
  }

  // ===================================================================
  // RENDERING
  // ===================================================================
  const CSS = `
.ocjo-rel{position:relative !important}
.ocjo-badge{position:absolute;top:-8px;right:4px;z-index:5;max-width:92%;padding:1px 6px;border-radius:9px;
  font:600 10px/14px Arial,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;
  border:1px solid transparent;box-shadow:0 1px 3px rgba(0,0,0,.5)}
.ocjo-badge.pass{background:#1f5e2e;color:#d9ffe0;border-color:#3fbf5a}
.ocjo-badge.fail{background:#6b1f1f;color:#ffe0e0;border-color:#e05555}
.ocjo-badge.unlisted.pass{background:#6b5410;color:#fff0c2;border-color:#e0b020}
.ocjo-badge.unlisted.fail{background:#6b1f1f;color:#ffe0e0;border:1px dashed #e0b020}
.ocjo-ok{outline:2px solid #3fbf5a !important;outline-offset:-2px;box-shadow:0 0 10px rgba(63,191,90,.55) !important}
.ocjo-dim{opacity:.45}
.ocjo-hide{display:none !important}
.ocjo-bar{position:sticky;top:0;z-index:50;box-sizing:border-box;width:100%;grid-column:1/-1;display:flex;flex-wrap:wrap;
  gap:6px 12px;align-items:center;padding:5px 8px;margin:0 0 4px;background:#222;color:#ddd;border:1px solid #444;border-radius:4px;
  font:12px/16px Arial,sans-serif}
.ocjo-bar label{display:flex;align-items:center;gap:4px;cursor:pointer}
.ocjo-btn{background:#3a3a3a;color:#eee;border:1px solid #666;border-radius:3px;padding:2px 8px;font:12px Arial,sans-serif;cursor:pointer}
.ocjo-btn:hover{background:#505050}
.ocjo-modal-bg{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center}
.ocjo-modal{box-sizing:border-box;width:94vw;max-width:680px;max-height:90vh;overflow:auto;background:#1e1e1e;color:#ddd;
  border:1px solid #555;border-radius:6px;padding:12px;font:13px/18px Arial,sans-serif}
.ocjo-modal h3{margin:8px 0 4px;font-size:14px;color:#fff}
.ocjo-modal textarea{box-sizing:border-box;width:100%;min-height:150px;background:#111;color:#cfc;border:1px solid #555;font:11px/14px monospace}
.ocjo-modal input[type=text],.ocjo-modal input[type=password],.ocjo-modal input[type=number]{box-sizing:border-box;background:#111;color:#eee;border:1px solid #555;padding:3px;max-width:100%}
.ocjo-modal table{border-collapse:collapse;margin:4px 0;font-size:12px}
.ocjo-modal td{border:1px solid #444;padding:2px 6px}
.ocjo-err{color:#ff8a8a;white-space:pre-wrap}
.ocjo-okmsg{color:#8aff9a}
.ocjo-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:4px 0}
`;

  function injectStyle() {
    if (document.getElementById('ocjo-style')) return;
    const st = document.createElement('style');
    st.id = 'ocjo-style';
    st.className = 'ocjo';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function clearOverlay() {
    document.querySelectorAll('.ocjo-badge').forEach((e) => e.remove());
    ['ocjo-ok', 'ocjo-dim', 'ocjo-hide', 'ocjo-rel'].forEach((c) => {
      document.querySelectorAll('.' + c).forEach((e) => e.classList.remove(c));
    });
  }

  function badgeFor(res) {
    const b = document.createElement('span');
    b.className = 'ocjo ocjo-badge ' + (res.pass ? 'pass' : 'fail') + (res.kind === 'unlisted' ? ' unlisted' : '');
    const mark = res.pass ? '✔' : '✘';
    let text;
    let tip;
    if (res.kind === 'any') {
      text = mark + ' any';
      tip = 'Levels 5-6: any CPR is fine.';
    } else {
      text = mark + ' ' + res.req + (res.pass ? '' : ' (-' + res.short + ')') + (res.kind === 'unlisted' ? ' unlisted' : '');
      tip = 'Needs ' + res.req + (res.kind === 'unlisted' ? ' (OC/role not in the requirements list; default applied)' : '');
    }
    b.textContent = text;
    b.title = tip;
    return b;
  }

  let rendering = false;

  function render() {
    if (rendering) return;
    rendering = true;
    try {
      injectStyle();
      clearOverlay();
      const panels = scanPage();
      lastScan = panels;
      const hasJoin = panels.some((p) => p.slots.length > 0);
      if (!hasJoin) { removeBar(); return; } // not the recruiting tab (or nothing open)

      let joinableOcs = 0;
      let joinableSlots = 0;
      let openSlots = 0;
      panels.forEach((p) => {
        let joinable = 0;
        p.slots.forEach((s) => {
          if (s.res.kind === 'skip') return;
          openSlots++;
          if (getComputedStyle(s.el).position === 'static') s.el.classList.add('ocjo-rel');
          s.el.appendChild(badgeFor(s.res));
          if (s.res.pass) joinable++;
        });
        joinableSlots += joinable;
        if (joinable) joinableOcs++;
        // Don't dim/hide a "panel" that is really most of the page (detection failed).
        if (p.el.querySelectorAll('*').length > 800) return;
        if (joinable) p.el.classList.add('ocjo-ok');
        else {
          p.el.classList.add('ocjo-dim');
          if (settings.joinableOnly) p.el.classList.add('ocjo-hide');
        }
      });
      drawBar(panels[0].el, joinableOcs, joinableSlots, openSlots);
      crossCheckApi();
    } catch (e) {
      console.error('[OC Join Overlay] render failed', e);
    } finally {
      rendering = false;
    }
  }

  // ---------------- control bar ----------------
  function removeBar() { document.querySelectorAll('.ocjo-bar').forEach((b) => b.remove()); }

  function drawBar(firstPanel, ocs, slots, open) {
    let bar = document.querySelector('.ocjo-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'ocjo ocjo-bar';
      firstPanel.parentNode.insertBefore(bar, firstPanel);
    } else if (bar.nextSibling !== firstPanel && !bar.contains(firstPanel) && firstPanel.parentNode) {
      firstPanel.parentNode.insertBefore(bar, firstPanel);
    }
    bar.textContent = '';
    const title = el('strong', {}, 'OC Join');
    const label = el('label', {});
    const cb = el('input', { type: 'checkbox' });
    cb.checked = !!settings.joinableOnly;
    cb.addEventListener('change', () => { settings.joinableOnly = cb.checked; saveSettings(); render(); });
    label.append(cb, 'Only joinable');
    const count = el('span', {}, 'Joinable: ' + ocs + ' OC' + (ocs === 1 ? '' : 's') + ' / ' + slots + ' of ' + open + ' open slots');
    const edit = el('button', { class: 'ocjo-btn', type: 'button' }, 'Requirements');
    edit.addEventListener('click', openEditor);
    bar.append(title, label, count);
    if (settings.apiMode) {
      const st = el('span', { title: 'API cross-check status' }, apiStatus || 'API: not checked yet');
      const rf = el('button', { class: 'ocjo-btn', type: 'button' }, 'Refresh API');
      rf.addEventListener('click', () => apiRefresh(true));
      bar.append(st, rf);
    }
    bar.append(edit);
  }

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, attrs[k]));
    kids.forEach((k) => e.append(k));
    return e;
  }

  // ===================================================================
  // HTTP (Tampermonkey -> TornPDA -> fetch)
  // ===================================================================
  function http(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'GET', url, timeout: 15000,
          onload: (r) => resolve({ status: r.status, text: r.responseText }),
          onerror: () => reject(new Error('network error')),
          ontimeout: () => reject(new Error('timed out')),
        });
      } else if (typeof PDA_httpGet === 'function') {
        PDA_httpGet(url).then((r) => resolve({ status: r.status, text: r.responseText })).catch(reject);
      } else {
        fetch(url).then(async (r) => resolve({ status: r.status, text: await r.text() })).catch(reject);
      }
    });
  }

  // ===================================================================
  // REMOTE REQUIREMENTS IMPORT
  // ===================================================================
  async function importFromUrl(url, force) {
    const r = await http(url);
    if (r.status < 200 || r.status >= 300) throw new Error('HTTP ' + r.status);
    let remote;
    try { remote = JSON.parse(r.text); } catch (e) { throw new Error('Not valid JSON: ' + e.message); }
    const errs = validateConfig(remote);
    if (errs.length) throw new Error('Invalid requirements:\n' + errs.join('\n'));
    if (!force) {
      const rt = Date.parse(remote.lastUpdated);
      const lt = Date.parse(config.lastUpdated);
      if (!(rt > (isNaN(lt) ? 0 : lt))) return false; // not newer
    }
    saveConfig(remote);
    return true;
  }

  async function autoCheck() {
    if (!settings.autoCheck || !settings.remoteUrl) return;
    const last = store.get('lastRemoteCheck', 0);
    if (Date.now() - last < AUTO_CHECK_INTERVAL_MS) return;
    store.set('lastRemoteCheck', Date.now());
    try {
      const changed = await importFromUrl(settings.remoteUrl, false);
      console.info('[OC Join Overlay] remote requirements ' + (changed ? 'updated' : 'already up to date'));
      if (changed) render();
    } catch (e) {
      console.warn('[OC Join Overlay] remote requirements check failed: ' + e.message);
    }
  }

  // ===================================================================
  // OPTIONAL API MODE (cross-check only; never supplies the CPR)
  // ===================================================================
  async function apiRefresh(manual) {
    if (!settings.apiMode || apiHalted) return;
    const key = store.get('apiKey', '');
    if (!key) { apiStatus = 'API: no key set'; render(); return; }
    const wait = API_COOLDOWN_MS - (Date.now() - store.get('lastApiAt', 0));
    if (wait > 0) {
      apiStatus = 'API: cooling down (' + Math.ceil(wait / 1000) + 's)';
      if (manual) render();
      return;
    }
    store.set('lastApiAt', Date.now());
    try {
      const url = 'https://api.torn.com/v2/faction/crimes?cat=recruiting&key=' + encodeURIComponent(key) +
        '&comment=' + API_COMMENT;
      const r = await http(url);
      const json = JSON.parse(r.text);
      if (json.error) { handleApiError(json.error); render(); return; }
      apiCrimes = Array.isArray(json.crimes) ? json.crimes : Object.values(json.crimes || {});
      apiStatus = 'API OK (' + apiCrimes.length + ' recruiting)';
      warned.clear();
    } catch (e) {
      apiStatus = 'API error: ' + e.message;
    }
    render();
  }

  function handleApiError(err) {
    const code = err.code;
    const msg = err.error || err.message || 'unknown';
    apiStatus = 'API error ' + code + ': ' + msg;
    if (code === 2) { store.set('apiKey', ''); apiHalted = true; apiStatus += ' - key cleared, enter a new one in Requirements'; }
    else if (code === 13 || code === 16 || code === 18) { apiHalted = true; apiStatus += ' - requests stopped'; }
    else if (code === 5) { store.set('lastApiAt', Date.now() + 30000); apiStatus += ' - backing off'; }
  }

  // Compare what the page shows with what the API says. Logs mismatches only.
  function crossCheckApi() {
    if (!settings.apiMode || !apiCrimes) return;
    const apiLabels = (c) => {
      const set = new Set();
      (c.slots || []).forEach((s) => {
        const pi = s.position_info || {};
        if (pi.label) {
          set.add(normRole(pi.label));
          if (pi.number !== undefined && pi.number !== null) set.add(normRole(pi.label + ' ' + pi.number));
        }
      });
      return set;
    };
    lastScan.forEach((p) => {
      const same = apiCrimes.filter((c) => normName(c.name || '') === normName(p.name));
      if (!same.length) { warnOnce('api', 'OC "' + p.name + '" is on the page but not in the API recruiting list.'); return; }
      if (!same.some((c) => Number(c.difficulty !== undefined ? c.difficulty : c.level) === p.level)) {
        warnOnce('api', 'OC "' + p.name + '": page level ' + p.level + ' differs from API difficulty.');
      }
      const labels = new Set();
      same.forEach((c) => apiLabels(c).forEach((l) => labels.add(l)));
      p.slots.forEach((s) => {
        const r = normRole(s.role);
        if (!labels.has(r) && !labels.has(stripTrailingNumber(r))) {
          warnOnce('api', 'OC "' + p.name + '": role "' + s.role + '" not found in the API slots.');
        }
      });
    });
  }

  // ===================================================================
  // REQUIREMENTS EDITOR (modal)
  // ===================================================================
  function openEditor() {
    if (document.querySelector('.ocjo-modal-bg')) return;
    const bg = el('div', { class: 'ocjo ocjo-modal-bg' });
    const m = el('div', { class: 'ocjo ocjo-modal' });
    bg.appendChild(m);
    bg.addEventListener('click', (e) => { if (e.target === bg) bg.remove(); });

    const msg = el('div', {});
    const say = (t, bad) => { msg.className = bad ? 'ocjo-err' : 'ocjo-okmsg'; msg.textContent = t; };

    // --- JSON editor
    const ta = el('textarea', { spellcheck: 'false' });
    ta.value = JSON.stringify(config, null, 2);
    const parseTa = (text) => {
      try { return JSON.parse(text); } catch (e) { say('Not valid JSON: ' + e.message, true); return null; }
    };
    const apply = (obj, note) => {
      const errs = validateConfig(obj);
      if (errs.length) { say(errs.join('\n'), true); return false; }
      saveConfig(obj);
      ta.value = JSON.stringify(config, null, 2);
      say(note || 'Saved.');
      render();
      return true;
    };

    const save = el('button', { class: 'ocjo-btn', type: 'button' }, 'Save');
    save.addEventListener('click', () => { const o = parseTa(ta.value); if (o) apply(o); });
    const reset = el('button', { class: 'ocjo-btn', type: 'button' }, 'Reset to built-in defaults');
    reset.addEventListener('click', () => { if (confirm('Replace your requirements with the built-in defaults?')) apply(clone(DEFAULT_CONFIG), 'Reset to defaults.'); });

    // --- default minimum
    const dmin = el('input', { type: 'number', min: '0', max: '100', style: 'width:70px' });
    dmin.value = config.defaults.unlistedMin;
    const dminBtn = el('button', { class: 'ocjo-btn', type: 'button' }, 'Set');
    dminBtn.addEventListener('click', () => {
      const o = parseTa(ta.value); if (!o) return;
      o.defaults = o.defaults || {};
      o.defaults.unlistedMin = Number(dmin.value);
      apply(o, 'Default minimum updated.');
    });

    // --- quick add / change
    const qn = el('input', { type: 'text', placeholder: 'OC name', style: 'width:150px' });
    const ql = el('input', { type: 'number', placeholder: 'level', min: '1', max: '10', style: 'width:60px' });
    const qr = el('input', { type: 'text', placeholder: 'role or *', style: 'width:100px' });
    const qm = el('input', { type: 'number', placeholder: 'min', min: '0', max: '100', style: 'width:60px' });
    const qb = el('button', { class: 'ocjo-btn', type: 'button' }, 'Add / change');
    qb.addEventListener('click', () => {
      const o = parseTa(ta.value); if (!o) return;
      if (!qn.value.trim() || !qr.value.trim() || qm.value === '') { say('Fill in OC name, role and min.', true); return; }
      o.ocs = o.ocs || {};
      const key = Object.keys(o.ocs).find((k) => normName(k) === normName(qn.value)) || qn.value.trim();
      o.ocs[key] = o.ocs[key] || { roles: {} };
      if (ql.value) o.ocs[key].level = Number(ql.value);
      o.ocs[key].roles = o.ocs[key].roles || {};
      o.ocs[key].roles[qr.value.trim()] = Number(qm.value);
      o.lastUpdated = new Date().toISOString().slice(0, 10);
      apply(o, 'Updated "' + key + '".');
    });

    // --- paste import
    const pasteTa = el('textarea', { spellcheck: 'false', style: 'min-height:70px', placeholder: 'Paste requirements JSON here' });
    const mode = el('select', {});
    mode.append(el('option', { value: 'replace' }, 'Replace everything'), el('option', { value: 'merge' }, 'Merge (add/override OCs)'));
    const impBtn = el('button', { class: 'ocjo-btn', type: 'button' }, 'Import pasted JSON');
    impBtn.addEventListener('click', () => {
      const inc = parseTa(pasteTa.value); if (!inc) return;
      if (mode.value === 'replace') { apply(inc, 'Imported (replaced).'); return; }
      const base = clone(config);
      Object.assign(base.ocs, (inc && inc.ocs) || {});
      if (inc && inc.lastUpdated) base.lastUpdated = inc.lastUpdated;
      apply(base, 'Imported (merged).');
    });

    // --- remote URL
    const url = el('input', { type: 'text', placeholder: 'https://raw.githubusercontent.com/.../oc.json', style: 'width:100%' });
    url.value = settings.remoteUrl || '';
    const auto = el('input', { type: 'checkbox' });
    auto.checked = !!settings.autoCheck;
    const urlBtn = el('button', { class: 'ocjo-btn', type: 'button' }, 'Import from URL now');
    urlBtn.addEventListener('click', async () => {
      settings.remoteUrl = url.value.trim(); saveSettings();
      try {
        await importFromUrl(settings.remoteUrl, true);
        ta.value = JSON.stringify(config, null, 2);
        say('Imported from URL.'); render();
      } catch (e) { say(e.message, true); }
    });
    const urlSave = el('button', { class: 'ocjo-btn', type: 'button' }, 'Save URL settings');
    urlSave.addEventListener('click', () => {
      settings.remoteUrl = url.value.trim(); settings.autoCheck = auto.checked; saveSettings(); say('URL settings saved.');
    });

    // --- API section
    const apiOn = el('input', { type: 'checkbox' });
    apiOn.checked = !!settings.apiMode;
    const keyIn = el('input', { type: 'password', placeholder: 'Torn API key', style: 'width:240px', autocomplete: 'off' });
    keyIn.value = store.get('apiKey', '');
    const apiSave = el('button', { class: 'ocjo-btn', type: 'button' }, 'Save API settings');
    apiSave.addEventListener('click', () => {
      settings.apiMode = apiOn.checked; saveSettings();
      store.set('apiKey', keyIn.value.trim());
      apiHalted = false;
      say('API settings saved.');
      if (settings.apiMode) apiRefresh(true); else render();
    });
    const tos = el('table', {});
    [['Data storage', 'Only locally'], ['Data sharing', 'Nobody'],
     ['Purpose', 'Personal use / faction OC joining overlay'], ['Key storage', 'Stored locally, not shared'],
     ['Access level', 'Limited (or custom key: faction → crimes only)']].forEach((r) => {
      const tr = el('tr', {}); tr.append(el('td', {}, r[0]), el('td', {}, r[1])); tos.appendChild(tr);
    });

    // --- debug dump
    const dumpTa = el('textarea', { readonly: 'readonly', style: 'min-height:80px', placeholder: 'Debug dump appears here' });
    const dumpBtn = el('button', { class: 'ocjo-btn', type: 'button' }, 'Copy debug dump');
    dumpBtn.addEventListener('click', () => {
      dumpTa.value = debugDump();
      dumpTa.select();
      try { navigator.clipboard.writeText(dumpTa.value); say('Dump created (copied if the browser allowed it).'); } catch (e) { say('Dump created; copy it from the box.'); }
    });

    const close = el('button', { class: 'ocjo-btn', type: 'button' }, 'Close');
    close.addEventListener('click', () => bg.remove());

    const row = (...k) => { const r = el('div', { class: 'ocjo-row' }); r.append(...k); return r; };
    m.append(
      el('h3', {}, 'OC requirements'), msg, ta, row(save, reset, close),
      el('h3', {}, 'Default minimum for unlisted level 7-10 OCs'), row(dmin, dminBtn),
      el('h3', {}, 'Quick add / change one number'), row(qn, ql, qr, qm, qb),
      el('h3', {}, 'Import pasted JSON'), pasteTa, row(mode, impBtn),
      el('h3', {}, 'Import from URL (raw GitHub / Gist)'), url, row(el('label', {}, auto, ' auto-check on page load (max once an hour, only if newer)')), row(urlBtn, urlSave),
      el('h3', {}, 'API mode (optional, off by default)'),
      el('div', {}, 'The overlay works without a key: your CPR is read from the page. API mode only cross-checks names/levels/roles and shows a status. Needs a Limited key, or a custom key with only faction → crimes.'),
      tos, row(el('label', {}, apiOn, ' enable API mode'), keyIn, apiSave),
      el('h3', {}, 'Troubleshooting'), row(dumpBtn), dumpTa
    );
    document.body.appendChild(bg);
  }

  // Structure-only dump of the first panel so selectors can be fixed.
  function debugDump() {
    const lines = ['Torn OC Join Overlay debug dump', location.href, ''];
    lastScan.forEach((p, i) => {
      lines.push('#' + i + ' name="' + p.name + '" level=' + p.level + ' openSlots=' + p.slots.map((s) => s.role + '=' + s.cpr).join(', '));
    });
    if (!lastScan.length) lines.push('No panels detected (no "N/10" text found).');
    const first = lastScan[0] && lastScan[0].el;
    if (first) {
      const strip = (node) => {
        const c = node.cloneNode(true);
        c.querySelectorAll('.ocjo').forEach((e) => e.remove());
        c.querySelectorAll('*').forEach((e) => {
          Array.from(e.attributes).forEach((a) => { if (!/^(class|id|role|type)$/.test(a.name)) e.removeAttribute(a.name); });
        });
        return c.outerHTML;
      };
      lines.push('', 'First panel HTML:', strip(first).slice(0, 12000));
    }
    return lines.join('\n');
  }

  // ===================================================================
  // BOOT: debounced MutationObserver
  // ===================================================================
  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(render, RENDER_DEBOUNCE_MS);
  }

  function boot() {
    injectStyle();
    const obs = new MutationObserver((muts) => {
      // Ignore our own changes and plain text updates (countdown timers).
      const relevant = muts.some((m) => {
        if (isOurs(m.target)) return false;
        return Array.from(m.addedNodes).concat(Array.from(m.removedNodes))
          .some((n) => n.nodeType === 1 && !isOurs(n));
      });
      if (relevant) schedule();
    });
    obs.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('hashchange', schedule);
    render();
    autoCheck();
    if (settings.apiMode) apiRefresh(false); // once per page load (cooldown enforced inside)
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
