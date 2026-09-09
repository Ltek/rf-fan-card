// ============================================================================
// RF Fan Test Card
// Version: v2026.09.09.21
// ----------------------------------------------------------------------------
// A Home Assistant custom Dashboard card for BENCH-TESTING the RF codes learned
// from a 433 MHz fan remote (companion to the `rf_fan` integration,
// https://github.com/dasimon135/ha-rf-fan — but this card BYPASSES the
// integration entirely).
//
// Layout: codes are grouped into collapsible SECTIONS (Forward Speeds, Reverse
// Speeds, Light, Dimming, Breeze Forward/Reverse, Breeze Off, Timers). Each row:
//
//   [ (#) ▶ Function name ]   6:0101…   [☑ Tested]  [☑ Working]
//
// • Pressing Trigger transmits the raw RF frame DIRECTLY through the ESPHome
//   gateway: esphome.<gateway>_transmit_rf_fan with { action, code, repeat_count }.
//   The rf_fan Python integration / assumed-state logic is NOT involved.
// • Codes ship baked-in (this fan's full v3 map, protocol 6). Override via the
//   editor's `codes` field if yours differ.
// • Tested / Working don't map to anything on the fan. They're bookkeeping,
//   persisted into an input_text helper as a compact bit-packed string
//   (2 bits/action → base64) so all 34+ flags fit under input_text's 255 cap.
//
// Author: LTek
//
// Design system: follows unified-cards/CARD_DESIGN_SYSTEM.md — the --ltek-*
// editor token block, panel/row idioms, render-once + throttled updateStates,
// byte-stable sparse config, editMode/preview safety.
// ============================================================================

const BUILD_NUMBER = 'v2026.09.09.21';

let DEBUG = false;
function debugLog(...args) { if (DEBUG) { try { console.log('[RFT]', ...args); } catch (e) {} } }

// ============================================================================
// PURE HELPERS
// ============================================================================

function escapeHtml(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatWsError(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err.message && err.code) return `${err.message} (code: ${err.code})`;
  if (err.message) return err.message;
  if (err.code) return `code: ${err.code}`;
  try { return JSON.stringify(err); } catch (e) { return String(err); }
}

// YAML preview helpers (read-only editor preview only).
function yamlScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  if (s === '') return "''";
  if (
    /[:#&*!|>'"%@`{}\[\],]/.test(s) ||
    /^[\s\-?]/.test(s) ||
    /\s$/.test(s) ||
    /^(true|false|null|yes|no|on|off)$/i.test(s) ||
    /^[\d.+-]/.test(s)
  ) {
    return "'" + s.replace(/'/g, "''") + "'";
  }
  return s;
}
function toYaml(value, indent = 0) {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return pad + '[]';
    return value
      .map(item => {
        if (item !== null && typeof item === 'object') {
          const inner = toYaml(item, indent + 1);
          const lines = inner.split('\n');
          const first = lines[0].replace(/^\s+/, '');
          const rest = lines.slice(1).join('\n');
          return pad + '- ' + first + (rest ? '\n' + rest : '');
        }
        return pad + '- ' + yamlScalar(item);
      })
      .join('\n');
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return pad + '{}';
    return keys
      .map(k => {
        const v = value[k];
        if (v !== null && typeof v === 'object') {
          if (
            (Array.isArray(v) && v.length === 0) ||
            (!Array.isArray(v) && Object.keys(v).length === 0)
          ) {
            return pad + k + ': ' + (Array.isArray(v) ? '[]' : '{}');
          }
          return pad + k + ':\n' + toYaml(v, indent + 1);
        }
        return pad + k + ': ' + yamlScalar(v);
      })
      .join('\n');
  }
  return pad + yamlScalar(value);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function cssEscape(s) {
  s = String(s);
  if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') return CSS.escape(s);
  return s.replace(/["\\\]\[:.]/g, '\\$&');
}

// The gateway's transmit_rf_fan action wants a BARE rc_switch bit string. A
// reference-doc "protocol N" prefix like "6:0101…" would be sent verbatim and
// rejected by the node, so strip a leading numeric "<proto>:" here. A pure bit
// string, or any non-numeric-prefixed form (e.g. "raw:…"), is left untouched.
function normalizeTxCode(code) {
  const s = String(code == null ? '' : code).trim();
  const m = s.match(/^(\d+):(.*)$/);
  return m ? m[2] : s;
}

// Light/Dim are MODIFIERS on the current speed base: the first 20 bits select
// the speed, the last 6 are the command. The physical remote keeps the current
// speed in every light/dim frame so it doesn't change speed. A fixed captured
// code carries whatever speed it was captured at, so replaying it re-sends that
// speed. We rebuild the frame from the current speed's prefix + the command's
// suffix so light/dim never disturb a running fan.
const REBASE_ACTIONS = { light_toggle: 1, dim_up: 1, dim_down: 1 };
const CMD_SUFFIX_LEN = 6;   // trailing bits carry direction + command modifier
const SPEED_FIELD_START = 16, SPEED_FIELD_LEN = 4;   // bits 16-19 select the speed

// Base a Light/Dim command rides on so it doesn't change the fan speed. The
// 'fake_*' options put an UNUSED value in the 4-bit speed field (real speeds are
// 0000-1001, breeze uses 1011/1100/1101), betting the fan ignores the unknown
// speed but still reads the light/dim bit. Which one (if any) works is
// firmware-specific — that's what the radios are for.
const LIGHT_BASE_OPTS = [
  { value: 'fwd0',       label: 'Forward Speed-0 (real)' },
  { value: 'rev0',       label: 'Reverse Speed-0 (real)' },
  { value: 'fake_1010',  label: 'Fake speed 1010' },
  { value: 'fake_1110',  label: 'Fake speed 1110' },
  { value: 'fake_1111',  label: 'Fake speed 1111' },
  { value: 'last_speed', label: 'Last speed pressed here' },
  { value: 'literal',    label: 'Literal captured code' }
];
const LIGHT_BASE_VALUES = LIGHT_BASE_OPTS.map(o => o.value);

function _xorBits(a, b) {
  let out = '';
  for (let i = 0; i < a.length; i++) out += (a[i] === b[i] ? '0' : '1');
  return out;
}

// Rebuild a Light/Dim command onto a chosen speed base WITHOUT changing the
// fan's speed. Structure (this fan): first (len-6) bits select the speed; the
// last 6 carry direction + the command modifier. A forward speed's suffix is
// the "baseline"; a command's modifier is (its suffix XOR that baseline). We
// apply that modifier onto the TARGET base's own suffix, so the target keeps
// its speed (prefix) AND its direction bits, only gaining the light/dim bit.
//   result = prefix(target) + (suffix(target) XOR suffix(command) XOR suffix(fwdRef))
// fwdRef is any forward speed code (its suffix = the direction/command baseline).
// Returns the command unchanged if the strings aren't rebaseable bit strings.
function rebaseCommandOntoSpeed(commandCode, targetCode, fwdRefCode) {
  const isBits = s => typeof s === 'string' && /^[01]+$/.test(s);
  if (!isBits(commandCode) || !isBits(targetCode) || !isBits(fwdRefCode)) return commandCode;
  const L = commandCode.length;
  if (targetCode.length !== L || fwdRefCode.length !== L || L <= CMD_SUFFIX_LEN) return commandCode;
  const cut = L - CMD_SUFFIX_LEN;
  const modifier = _xorBits(commandCode.slice(cut), fwdRefCode.slice(cut));   // pure command bits
  const newSuffix = _xorBits(targetCode.slice(cut), modifier);
  return targetCode.slice(0, cut) + newSuffix;
}

function humanizeAction(action) {
  if (!action) return '';
  return String(action)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\bRf\b/i, 'RF');
}

// ============================================================================
// BUILT-IN CODE MAP — this fan's full v3 reference (2026-08-31), protocol 6.
// Bit strings are decoded rc_switch protocol-6 form; sent as "6:<bits>".
// SECTION_DEFS drives BOTH the default codes/labels AND the on-card layout.
// A pasted `codes` override reuses these section groupings; anything unknown
// falls into an "Other" section.
// ============================================================================

// The ESPHome gateway's `transmit_rf_fan` action feeds `code` straight into
// remote_transmitter.transmit_rc_switch_raw, whose protocol is hardcoded in the
// node's YAML. So the code must be a BARE rc_switch bit string — NO "6:" (or any
// "<proto>:") prefix. (Reference docs label these "protocol 6", but that number
// is not part of the transmitted string.)
const PROTO = '';

const SECTION_DEFS = [
  {
    id: 'fwd', title: 'Forward Speeds', icon: 'mdi:fan-chevron-up', numbered: true,
    rows: [
      ['speed_0', 'Speed 0 (Off)', '01011110000000100000010000'],
      ['speed_1', 'Speed 1',       '01011110000000100001010000'],
      ['speed_2', 'Speed 2',       '01011110000000100010010000'],
      ['speed_3', 'Speed 3',       '01011110000000100011010000'],
      ['speed_4', 'Speed 4',       '01011110000000100100010000'],
      ['speed_5', 'Speed 5',       '01011110000000100101010000'],
      ['speed_6', 'Speed 6',       '01011110000000100110010000'],
      ['speed_7', 'Speed 7',       '01011110000000100111010000'],
      ['speed_8', 'Speed 8',       '01011110000000101000010000'],
      ['speed_9', 'Speed 9',       '01011110000000101001010000']
    ]
  },
  {
    id: 'rev', title: 'Reverse Speeds', icon: 'mdi:fan-chevron-down', numbered: true,
    rows: [
      ['reverse_0', 'Speed 0 (Off)', '01011110000000100000100000'],
      ['reverse_1', 'Speed 1',       '01011110000000100001100000'],
      ['reverse_2', 'Speed 2',       '01011110000000100010100000'],
      ['reverse_3', 'Speed 3',       '01011110000000100011100000'],
      ['reverse_4', 'Speed 4',       '01011110000000100100100000'],
      ['reverse_5', 'Speed 5',       '01011110000000100101100000'],
      ['reverse_6', 'Speed 6',       '01011110000000100110100000'],
      ['reverse_7', 'Speed 7',       '01011110000000100111100000'],
      ['reverse_8', 'Speed 8',       '01011110000000101000100000'],
      ['reverse_9', 'Speed 9',       '01011110000000101001100000']
    ]
  },
  {
    id: 'light', title: 'Light', icon: 'mdi:lightbulb', numbered: false,
    rows: [
      ['light_toggle', 'Light Toggle', '01011110000000100000010100']
    ]
  },
  {
    id: 'dim', title: 'Dimming', icon: 'mdi:brightness-6', numbered: false,
    rows: [
      ['dim_up',   'Dim Up',   '01011110000000100101010010'],
      ['dim_down', 'Dim Down', '01011110000000100101010011']
    ]
  },
  {
    id: 'breeze_fwd', title: 'Breeze — Forward', icon: 'mdi:weather-windy', numbered: true,
    rows: [
      ['breeze_1', 'Breeze 1', '01011110000000101011010000'],
      ['breeze_2', 'Breeze 2', '01011110000000101100010000'],
      ['breeze_3', 'Breeze 3', '01011110000000101101010000']
    ]
  },
  {
    id: 'breeze_rev', title: 'Breeze — Reverse', icon: 'mdi:weather-windy', numbered: true,
    rows: [
      ['reverse_breeze_1', 'Breeze 1', '01011110000000101011100000'],
      ['reverse_breeze_2', 'Breeze 2', '01011110000000101100100000'],
      ['reverse_breeze_3', 'Breeze 3', '01011110000000101101100000']
    ]
  },
  {
    id: 'breeze_off', title: 'Breeze Off', icon: 'mdi:fan-off', numbered: false,
    rows: [
      ['breeze_off', 'Breeze Off', '01011110000000100001000000']
    ]
  },
  {
    id: 'timers', title: 'Timers', icon: 'mdi:timer-outline', numbered: false,
    rows: [
      ['timer_off', 'Timer Off', '01011110000000101100101001'],
      ['timer_2h',  'Timer 2 hr', '01011110000000101100101010'],
      ['timer_4h',  'Timer 4 hr', '01011110000000101100101011'],
      ['timer_8h',  'Timer 8 hr', '01011110000000101100101100']
    ]
  }
];

// Flatten SECTION_DEFS into the default codes / labels / action→section maps.
const DEFAULT_CODES = {};
const DEFAULT_LABELS = {};
const ACTION_SECTION = {};   // action -> section id
(function () {
  SECTION_DEFS.forEach(sec => {
    sec.rows.forEach(([action, label, bits]) => {
      DEFAULT_CODES[action] = PROTO + bits;
      DEFAULT_LABELS[action] = label;
      ACTION_SECTION[action] = sec.id;
    });
  });
})();

// ============================================================================
// REMOTE LAYOUT — a physical-remote-style control surface.
// ----------------------------------------------------------------------------
// Forward and Reverse are shown as SEPARATE button sets (each direction is a
// distinct code, so there is no toggle). Buttons whose action has no configured
// code are hidden, so the remote adapts to whatever codes exist.
//
// "Last pressed" per category (speed / breeze / timer) is highlighted so you
// can see the assumed current state. It's persisted to localStorage (browser-
// scoped) — accurate only for presses made from THIS card, since the fan gives
// no feedback and the physical remote can change state unseen.
// ============================================================================

function speedAction(n, dir) { return dir === 'rev' ? `reverse_${n}` : `speed_${n}`; }
function breezeAction(n, dir) { return dir === 'rev' ? `reverse_breeze_${n}` : `breeze_${n}`; }

// Which "last pressed" category an action belongs to (for highlight tracking).
// Speed AND breeze (both directions, incl. offs) share ONE "fan" category: they
// are mutually-exclusive running states, so only a single one is ever lit.
// Timers and lights are tracked independently (they coexist with a fan speed).
function actionCategory(action) {
  if (/^(speed|reverse)_\d+$/.test(action)) return 'fan';
  if (/^(breeze|reverse_breeze)_\d+$/.test(action) || action === 'breeze_off') return 'fan';
  if (/^timer_/.test(action)) return 'timer';
  return null;
}

// ============================================================================
// TEST-STATE OVERLAY — bit-packed into an input_text helper.
// ----------------------------------------------------------------------------
// overlay: { "<action>": {t:1,w:1}, … }. Serialized as "<hash>.<base64>" where
// each action (in a stable sorted order) owns 2 bits: tested, working. The hash
// is a checksum of that ordered action list — if the code map changes so the
// order differs, the stored string is ignored rather than mislabeled. All 34
// actions pack to ~14 chars, well under input_text's 255-char default cap.
// ============================================================================

const HELPER_MAX_LEN = 255;

// Stable order used for bit assignment.
function actionOrder(codes) { return Object.keys(codes || {}).sort(); }

// djb2 → base36, short + deterministic.
function keysHash(order) {
  let h = 5381;
  const s = order.join('|');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function _b64FromBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  try { return btoa(s); } catch (e) { return ''; }
}
function _bytesFromB64(b64) {
  let s;
  try { s = atob(b64); } catch (e) { return []; }
  const out = new Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// Legacy JSON overlay (v1 format) — read-only fallback.
function parseLegacyOverlay(stateStr) {
  try {
    const o = JSON.parse(stateStr);
    return isPlainObject(o) ? o : {};
  } catch (e) { return {}; }
}

function packOverlay(overlay, order) {
  const nbytes = Math.ceil((order.length * 2) / 8);
  const bytes = new Array(nbytes).fill(0);
  order.forEach((action, i) => {
    const v = overlay[action] || {};
    const tBit = i * 2, wBit = i * 2 + 1;
    if (v.t) bytes[tBit >> 3] |= (1 << (7 - (tBit & 7)));
    if (v.w) bytes[wBit >> 3] |= (1 << (7 - (wBit & 7)));
  });
  return keysHash(order) + '.' + _b64FromBytes(bytes);
}

function unpackOverlay(str, order) {
  if (!str || typeof str !== 'string') return {};
  const s = str.trim();
  if (!s || s === 'unknown' || s === 'unavailable') return {};
  const dot = s.indexOf('.');
  if (dot === -1) {
    // No packed marker — treat as legacy JSON, keep only actions we know.
    const legacy = parseLegacyOverlay(s);
    const out = {};
    order.forEach(a => { if (legacy[a]) out[a] = { ...(legacy[a].t ? { t: 1 } : {}), ...(legacy[a].w ? { w: 1 } : {}) }; });
    return out;
  }
  const hash = s.slice(0, dot);
  const b64 = s.slice(dot + 1);
  if (hash !== keysHash(order)) return {};   // code map changed — don't mislabel
  const bytes = _bytesFromB64(b64);
  const out = {};
  order.forEach((action, i) => {
    const tBit = i * 2, wBit = i * 2 + 1;
    const t = (bytes[tBit >> 3] >> (7 - (tBit & 7))) & 1;
    const w = (bytes[wBit >> 3] >> (7 - (wBit & 7))) & 1;
    if (t || w) { const rec = {}; if (t) rec.t = 1; if (w) rec.w = 1; out[action] = rec; }
  });
  return out;
}

// ============================================================================
// CONFIG (sparse + byte-stable)
// ============================================================================

function stubConfig() {
  return {
    type: 'custom:rf-fan-test-card',
    title: '',
    gateway_service: '',   // ESPHome prefix -> esphome.<prefix>_transmit_rf_fan
    codes: {},             // {} => use built-in DEFAULT_CODES
    labels: {},            // optional label overrides (merged over defaults)
    repeat_count: 4,       // these receivers want the frame repeated (1–10)
    state_helper: '',      // input_text.* entity storing tested/working flags
    confirm_send: false,
    sections_open: false,  // test-view sections collapsed by default
    show_remote: true,     // show the remote-control UI section
    show_test: true,       // show the test-table UI section
    default_view: 'remote',// which section is expanded on load: 'remote' | 'test' | 'both'
    hidden_buttons: [],    // action names hidden from the remote (per-button show/hide)
    breeze_with_speed: false, // true: breeze buttons sit inside each direction's speed set
    single_power: false,   // true: one on/off button (top-right) instead of per-direction offs
    single_power_dir: 'fwd', // which off code the single power button sends: 'fwd' | 'rev'
    headers: {},           // per-group section-header visibility (see DEFAULT_HEADERS)
    // Base used when the remote sends a Light/Dim command (which is a modifier
    // layered on a speed base). Options:
    //   'fwd0'       — always the Forward Speed-0 base (fixed; recommended)
    //   'rev0'       — always the Reverse Speed-0 base (fixed; for testing)
    //   'last_speed' — rebase on the last speed pressed FROM THIS CARD
    //   'literal'    — send the captured code as-is (no rebase)
    light_base: 'fake_1111',
    show_capture: false,   // master toggle for the live capture readout
    capture: {},           // per-element show/hide (see DEFAULT_CAPTURE)
    min_refresh_seconds: 0
  };
}

// Remote section-header groups and their default visibility. Light header is
// hidden by default (the bulb/arrows are self-explanatory); the rest show.
const HEADER_GROUPS = ['light', 'forward', 'reverse', 'breeze', 'timer'];
const DEFAULT_HEADERS = { light: false, forward: true, reverse: true, breeze: true, timer: true };

function normalizeHeaders(h) {
  h = isPlainObject(h) ? h : {};
  const out = {};
  HEADER_GROUPS.forEach(k => { out[k] = (typeof h[k] === 'boolean') ? h[k] : DEFAULT_HEADERS[k]; });
  return out;
}
function headersAreDefault(h) { return HEADER_GROUPS.every(k => h[k] === DEFAULT_HEADERS[k]); }

// Capture-readout element visibility. Everything on by default.
const CAPTURE_ELEMS = ['tx', 'rx', 'count', 'match'];
const DEFAULT_CAPTURE = { tx: true, rx: true, count: true, match: true };
function normalizeCapture(cp) {
  cp = isPlainObject(cp) ? cp : {};
  const out = {};
  CAPTURE_ELEMS.forEach(k => { out[k] = (typeof cp[k] === 'boolean') ? cp[k] : DEFAULT_CAPTURE[k]; });
  return out;
}
function captureIsDefault(cp) { return CAPTURE_ELEMS.every(k => cp[k] === DEFAULT_CAPTURE[k]); }

// The full set of actions the remote can show, in display order. Used by the
// renderer and by the editor's per-button show/hide list.
function remoteActionOrder(codes) {
  const order = [];
  ['light_toggle', 'dim_up', 'dim_down'].forEach(a => order.push(a));
  for (let n = 0; n <= 9; n++) order.push(speedAction(n, 'fwd'));
  for (let n = 0; n <= 9; n++) order.push(speedAction(n, 'rev'));
  order.push('breeze_off');
  for (let n = 1; n <= 3; n++) order.push(breezeAction(n, 'fwd'));
  for (let n = 1; n <= 3; n++) order.push(breezeAction(n, 'rev'));
  ['timer_off', 'timer_2h', 'timer_4h', 'timer_8h'].forEach(a => order.push(a));
  return order.filter(a => codes[a] !== undefined);
}

function normalizeStrArray(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  v.forEach(x => { const s = String(x == null ? '' : x).trim(); if (s && !out.includes(s)) out.push(s); });
  return out;
}

function normalizeCodes(c) {
  if (!isPlainObject(c)) return {};
  const out = {};
  Object.keys(c).forEach(k => {
    const key = String(k).trim();
    if (!key) return;
    const val = c[k];
    if (val == null) return;
    out[key] = String(val);
  });
  return out;
}
function normalizeLabels(l) {
  if (!isPlainObject(l)) return {};
  const out = {};
  Object.keys(l).forEach(k => {
    const key = String(k).trim();
    if (key && l[k] != null && String(l[k]).trim() !== '') out[key] = String(l[k]);
  });
  return out;
}

function normalizeConfigFull(config) {
  const stub = stubConfig();
  return {
    ...stub,
    ...config,
    type: 'custom:rf-fan-test-card',
    title: typeof config.title === 'string' ? config.title : '',
    gateway_service: typeof config.gateway_service === 'string' ? config.gateway_service.trim() : '',
    codes: normalizeCodes(config.codes),
    labels: normalizeLabels(config.labels),
    repeat_count: Math.min(10, Math.max(1, Number(config.repeat_count) || stub.repeat_count)),
    state_helper: typeof config.state_helper === 'string' ? config.state_helper.trim() : '',
    confirm_send: !!config.confirm_send,
    sections_open: config.sections_open === true,
    show_remote: config.show_remote !== false,
    show_test: config.show_test !== false,
    default_view: ['remote', 'test', 'both'].includes(config.default_view) ? config.default_view : 'remote',
    hidden_buttons: normalizeStrArray(config.hidden_buttons),
    breeze_with_speed: config.breeze_with_speed === true,
    single_power: config.single_power === true,
    single_power_dir: config.single_power_dir === 'rev' ? 'rev' : 'fwd',
    headers: normalizeHeaders(config.headers),
    light_base: normalizeLightBase(config),
    show_capture: config.show_capture === true,
    capture: normalizeCapture(config.capture),
    min_refresh_seconds: Math.max(0, Number(config.min_refresh_seconds) || 0)
  };
}

// Light/Dim base mode, with back-compat for the old `dynamic_light` bool
// (true → last_speed, false → literal).
function normalizeLightBase(config) {
  if (LIGHT_BASE_VALUES.includes(config.light_base)) return config.light_base;
  if (config.dynamic_light === true) return 'last_speed';
  if (config.dynamic_light === false) return 'literal';
  return 'fake_1111';
}

function normalizeConfig(config) {
  const full = normalizeConfigFull(config || {});
  const out = { type: 'custom:rf-fan-test-card' };
  if (full.title && full.title.trim()) out.title = full.title;
  if (full.gateway_service) out.gateway_service = full.gateway_service;
  if (Object.keys(full.codes).length) out.codes = full.codes;
  if (Object.keys(full.labels).length) out.labels = full.labels;
  if (full.repeat_count !== 4) out.repeat_count = full.repeat_count;
  if (full.state_helper) out.state_helper = full.state_helper;
  if (full.confirm_send) out.confirm_send = true;
  if (full.sections_open === true) out.sections_open = true;
  if (full.show_remote === false) out.show_remote = false;
  if (full.show_test === false) out.show_test = false;
  if (full.default_view !== 'remote') out.default_view = full.default_view;
  if (full.hidden_buttons.length) out.hidden_buttons = full.hidden_buttons.slice();
  if (full.breeze_with_speed === true) out.breeze_with_speed = true;
  if (full.light_base !== 'fake_1111') out.light_base = full.light_base;
  if (full.show_capture === true) out.show_capture = true;
  if (!captureIsDefault(full.capture)) {
    const cp = {};
    CAPTURE_ELEMS.forEach(k => { if (full.capture[k] !== DEFAULT_CAPTURE[k]) cp[k] = full.capture[k]; });
    out.capture = cp;
  }
  if (full.single_power === true) out.single_power = true;
  if (full.single_power_dir === 'rev') out.single_power_dir = 'rev';
  if (!headersAreDefault(full.headers)) {
    const h = {};
    HEADER_GROUPS.forEach(k => { if (full.headers[k] !== DEFAULT_HEADERS[k]) h[k] = full.headers[k]; });
    out.headers = h;
  }
  if (full.min_refresh_seconds > 0) out.min_refresh_seconds = full.min_refresh_seconds;
  return out;
}

// The effective code map: config override if provided, else the built-in map.
function effectiveCodes(config) {
  const c = (config && config.codes) || {};
  return Object.keys(c).length ? c : DEFAULT_CODES;
}
function effectiveLabel(config, action) {
  const over = (config && config.labels) || {};
  return over[action] || DEFAULT_LABELS[action] || humanizeAction(action);
}

// ============================================================================
// RENDERER — RFTCard
// ============================================================================

class RFTCard extends HTMLElement {
  constructor() {
    super();
    this._config = null;
    this._hass = null;
    this._rendered = false;
    this._updateTimer = null;
    this._lastRefreshAt = 0;
    this._edit = false;
    this._prev = false;
    this._editMode = false;
    this._overlay = {};      // { action: {t,w} }
    this._sending = {};      // action -> true while transmitting
    this._sections = [];     // built layout
    this._flat = {};         // action -> row
    this._view = null;       // { remote: bool, test: bool } — live show/hide
    this._lastPressed = {};  // category -> last-pressed action (browser-persisted)
    this._capture = {
      unsub: null,
      tx: { code: null, matched: null, count: 0 },
      rx: { code: null, matched: null, count: 0 }
    };
  }

  disconnectedCallback() {
    if (this._updateTimer) { clearTimeout(this._updateTimer); this._updateTimer = null; }
    this._stopCapture();
  }

  setConfig(config) {
    if (!config) throw new Error('Invalid configuration');
    this._config = normalizeConfigFull(config);
    DEBUG = !!config.debug;
    // Initial visibility for each UI region (user can toggle live afterward).
    const dv = this._config.default_view;
    this._view = {
      remote: this._config.show_remote && (dv === 'remote' || dv === 'both'),
      test: this._config.show_test && (dv === 'test' || dv === 'both')
    };
    // If only one region is enabled, show it regardless of default_view.
    if (this._config.show_remote && !this._config.show_test) this._view.remote = true;
    if (this._config.show_test && !this._config.show_remote) this._view.test = true;
    this._loadLastPressed();
    if (this._hass) { this._syncOverlay(); this._rendered = false; this.renderCard(); this._rendered = true; }
  }

  // Last-pressed highlight state — browser-scoped, keyed per gateway service so
  // separate fan cards don't collide. Best-effort (private mode may block LS).
  _lpKey() { return `rf-fan-test:last:${(this._config && this._config.gateway_service) || 'default'}`; }
  _loadLastPressed() {
    this._lastPressed = {};
    try {
      const raw = window.localStorage.getItem(this._lpKey());
      const o = raw ? JSON.parse(raw) : null;
      if (isPlainObject(o)) this._lastPressed = o;
    } catch (e) { /* LS unavailable — highlight just won't persist */ }
  }
  _saveLastPressed() {
    try { window.localStorage.setItem(this._lpKey(), JSON.stringify(this._lastPressed)); } catch (e) {}
  }
  _noteLastPressed(action) {
    const cat = actionCategory(action);
    if (!cat) return;
    this._lastPressed[cat] = action;
    this._saveLastPressed();
    this._applyLastPressedHighlight();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    if (!this._rendered) {
      this._syncOverlay();
      this.renderCard();
      this._rendered = true;
      return;
    }
    if (this._updateTimer) return;
    const minMs = Math.max(0, Number(this._config.min_refresh_seconds) || 0) * 1000;
    const now = Date.now();
    const sinceLast = now - (this._lastRefreshAt || 0);
    const delay = minMs > 0 ? Math.max(250, minMs - sinceLast) : 250;
    this._updateTimer = setTimeout(() => {
      this._updateTimer = null;
      this._lastRefreshAt = Date.now();
      try { this.updateStates(); } catch (e) { debugLog('updateStates error', e); }
    }, delay);
  }
  get hass() { return this._hass; }

  set editMode(v) { this._edit = !!v; this._editMode = this._edit || this._prev; }
  get editMode() { return this._edit === true; }
  set preview(v) { this._prev = !!v; this._editMode = this._edit || this._prev; }
  get preview() { return this._prev === true; }

  getCardSize() {
    const n = Object.keys(effectiveCodes(this._config)).length || 6;
    return Math.min(30, Math.ceil(n / 2) + 3);
  }

  static getConfigElement() { return document.createElement('rf-fan-test-card-editor'); }
  static getStubConfig() { return { type: 'custom:rf-fan-test-card' }; }

  // ------------------------------------------------------------------------
  // OVERLAY SYNC
  // ------------------------------------------------------------------------
  _helperState() {
    const h = this._config && this._config.state_helper;
    if (!h || !this._hass || !this._hass.states) return null;
    return this._hass.states[h] || null;
  }
  _order() { return actionOrder(effectiveCodes(this._config)); }
  _syncOverlay() {
    const st = this._helperState();
    this._overlay = st ? unpackOverlay(st.state, this._order()) : {};
  }
  _flags(action) {
    const v = this._overlay[action] || {};
    return { tested: !!v.t, working: !!v.w };
  }

  // ------------------------------------------------------------------------
  // BUILD SECTIONS from the effective code map.
  // ------------------------------------------------------------------------
  _buildSections() {
    const codes = effectiveCodes(this._config);
    const flat = {};
    const byId = {};
    const sections = [];

    const ensure = (def) => {
      if (byId[def.id]) return byId[def.id];
      const s = { id: def.id, title: def.title, icon: def.icon, numbered: !!def.numbered, rows: [] };
      byId[def.id] = s; sections.push(s); return s;
    };

    // Seed sections in canonical order, only for actions present in codes.
    SECTION_DEFS.forEach(def => {
      def.rows.forEach(([action]) => {
        if (codes[action] === undefined) return;
        const s = ensure(def);
        const numMatch = def.numbered ? String(action).match(/(\d+)/) : null;
        const row = {
          action,
          code: String(codes[action]),
          label: effectiveLabel(this._config, action),
          num: numMatch ? numMatch[1] : null
        };
        s.rows.push(row);
        flat[action] = row;
      });
    });

    // Anything in codes not covered by a section def → "Other".
    const otherDef = { id: 'other', title: 'Other', icon: 'mdi:dots-horizontal', numbered: false };
    Object.keys(codes).sort().forEach(action => {
      if (flat[action]) return;
      const s = ensure(otherDef);
      const row = { action, code: String(codes[action]), label: effectiveLabel(this._config, action), num: null };
      s.rows.push(row);
      flat[action] = row;
    });

    this._sections = sections;
    this._flat = flat;
  }

  // ------------------------------------------------------------------------
  // RENDER
  // ------------------------------------------------------------------------
  renderCard() {
    if (!this._hass || !this._config) return;
    this._buildSections();
    const c = this._config;
    const hasHelper = !!c.state_helper;
    const helperMissing = hasHelper && !this._helperState();
    const gwMissing = !c.gateway_service;
    const usingDefaults = !Object.keys(c.codes).length;

    let banner = '';
    if (gwMissing) {
      banner = `<div class="rft-banner rft-warn">No <b>ESPHome gateway service</b> set — set it in the card editor so Trigger can transmit (<code>esphome.&lt;service&gt;_transmit_rf_fan</code>).</div>`;
    } else if (hasHelper && helperMissing) {
      banner = `<div class="rft-banner rft-warn">Tested/Working helper <code>${escapeHtml(c.state_helper)}</code> not found. Create an <b>input_text</b> helper and select it in the editor.</div>`;
    } else if (!hasHelper) {
      banner = `<div class="rft-banner rft-info">No Tested/Working helper set — those checkboxes won't persist across reloads. Pick an <b>input_text</b> helper in the editor to save results.</div>`;
    }

    const anyRows = this._sections.some(s => s.rows.length);
    const showRemote = c.show_remote && this._view.remote;
    const showTest = c.show_test && this._view.test;
    // View toggles only make sense when BOTH regions are enabled.
    const bothViews = c.show_remote && c.show_test;
    // Single power button lives in the header top-right (only when the remote is
    // enabled and single_power is on and the chosen off code exists).
    const spAction = speedAction(0, c.single_power_dir);
    const singlePowerBtn = (c.show_remote && c.single_power && this._has(spAction))
      ? `<button class="rft-rbtn rft-roff rft-header-power${this._isLast(spAction) ? ' rft-active' : ''}" data-action="${escapeHtml(spAction)}"${c.gateway_service ? '' : ' disabled'} title="Power (${escapeHtml(spAction)})"><ha-icon icon="mdi:power"></ha-icon></button>`
      : '';

    this.innerHTML = `
      <ha-card class="rft-wrap">
        <style>${this._styles()}</style>
        <div class="rft-header">
          ${c.title ? `<span class="rft-title">${escapeHtml(c.title)}</span>` : '<span class="rft-title">RF Fan</span>'}
          ${usingDefaults ? '<span class="rft-badge-default">built-in codes</span>' : ''}
          <span class="rft-header-toggles">
            ${bothViews ? `
              <button class="rft-vtoggle${showRemote ? ' on' : ''}" data-view="remote" title="Show/hide the remote"><ha-icon icon="mdi:remote"></ha-icon> Remote</button>
              <button class="rft-vtoggle${showTest ? ' on' : ''}" data-view="test" title="Show/hide the test table"><ha-icon icon="mdi:table-check"></ha-icon> Test</button>
            ` : ''}
            ${singlePowerBtn}
          </span>
        </div>
        ${banner}
        ${c.show_capture && (c.capture.tx || c.capture.rx) ? `
          <div class="rft-capture">
            ${c.capture.tx ? `<div class="rft-capture-line rft-cap-tx-line">${this._captureLineHtml(this._capture.tx, 'TX', 'Last Sent')}</div>` : ''}
            ${c.capture.rx ? `<div class="rft-capture-line rft-cap-rx-line">${this._captureLineHtml(this._capture.rx, 'RX', 'Last Received')}</div>` : ''}
          </div>` : ''}
        <div class="rft-body">
          ${c.show_remote ? `<div class="rft-remote-wrap" data-region="remote"${showRemote ? '' : ' hidden'}>${this._renderRemote()}</div>` : ''}
          ${c.show_test ? `<div class="rft-test-wrap" data-region="test"${showTest ? '' : ' hidden'}>
            ${anyRows ? this._sections.map(s => this._renderSection(s)).join('') : `<div class="rft-empty">No RF codes configured.</div>`}
            ${this._renderFooter()}
          </div>` : ''}
        </div>
      </ha-card>
    `;
    this._attachHandlers();
    if (c.show_capture) { this._startCapture(); this._renderCaptureReadout(); }
    else this._stopCapture();
  }

  // ------------------------------------------------------------------------
  // REMOTE UI — physical-remote-style. Forward and Reverse are SEPARATE button
  // sets (no toggle). The last-pressed button per category is highlighted.
  // Buttons with no configured code are hidden.
  // ------------------------------------------------------------------------
  _has(action) { return !!(this._flat && this._flat[action]); }

  // Shown on the remote = code exists AND not hidden via settings.
  _onRemote(action) {
    if (!this._has(action)) return false;
    const hidden = (this._config && this._config.hidden_buttons) || [];
    return hidden.indexOf(action) === -1;
  }

  // Is this action the last-pressed one in its category?
  _isLast(action) {
    const cat = actionCategory(action);
    return !!(cat && this._lastPressed[cat] === action);
  }

  _remoteBtn(action, inner, cls) {
    if (!this._onRemote(action)) return '';
    const sending = !!this._sending[action];
    const canSend = !!this._config.gateway_service && !sending;
    const active = this._isLast(action) ? ' rft-active' : '';
    const row = this._flat[action];
    return `<button class="rft-rbtn ${cls || ''}${sending ? ' rft-sending' : ''}${active}" data-action="${escapeHtml(action)}"${canSend ? '' : ' disabled'} title="${escapeHtml(row.label + ' — ' + action)}">${sending ? '<span class="rft-spinner rft-spinner-dark"></span>' : inner}</button>`;
  }

  // One direction's breeze buttons (no group wrapper), for embedding into a
  // speed set or the standalone breeze row. `withDir` adds an F/R prefix.
  _breezeBtns(dir, withDir) {
    const parts = [];
    const pfx = withDir ? (dir === 'rev' ? 'R' : 'F') : '';
    for (let n = 1; n <= 3; n++) {
      const b = this._remoteBtn(breezeAction(n, dir), `<ha-icon icon="mdi:weather-windy"></ha-icon><span class="rft-rblabel">${pfx}${n}</span>`, 'rft-rbreeze' + (dir === 'rev' ? ' rft-rbreeze-rev' : ''));
      if (b) parts.push(b);
    }
    return parts;
  }

  // Build one direction's Power + Speed block. When breeze_with_speed is on,
  // that direction's breeze buttons are appended to the same button row.
  // Returns '' if it has no visible buttons.
  _renderSpeedSet(dir, title, headerKey) {
    const btns = [];
    // Per-direction Off is suppressed when a single header power button is used.
    if (!this._config.single_power) {
      const hasOff = this._onRemote(speedAction(0, dir));
      if (hasOff) btns.push(this._remoteBtn(speedAction(0, dir), '<ha-icon icon="mdi:power"></ha-icon>', 'rft-roff'));
    }
    for (let n = 1; n <= 9; n++) {
      const b = this._remoteBtn(speedAction(n, dir), `<span class="rft-rnum">${n}</span>`, 'rft-rspeed');
      if (b) btns.push(b);
    }
    if (this._config.breeze_with_speed) btns.push(...this._breezeBtns(dir, false));
    if (!btns.length) return '';
    return `
      <div class="rft-rgroup rft-rgroup-speed">
        ${this._groupHeader(headerKey, title)}
        <div class="rft-rrow">${btns.join('')}</div>
      </div>`;
  }

  // A section header, shown only when that group's header toggle is on.
  _groupHeader(key, title) {
    const headers = (this._config && this._config.headers) || DEFAULT_HEADERS;
    return headers[key] ? `<div class="rft-rglabel">${escapeHtml(title)}</div>` : '';
  }

  // Build the combined Breeze row: Breeze Off first, then Forward 1-3, then
  // Reverse 1-3 — all on ONE row. Returns '' if nothing visible. Skipped when
  // breeze_with_speed folds breeze into the speed sets (Breeze Off then joins
  // its own tiny row so it stays reachable).
  _renderBreezeRow() {
    const merged = this._config.breeze_with_speed;
    const parts = [];
    if (this._onRemote('breeze_off')) parts.push(this._remoteBtn('breeze_off', '<ha-icon icon="mdi:fan-off"></ha-icon> Off', 'rft-rbreeze rft-rbreeze-off'));
    if (!merged) {
      parts.push(...this._breezeBtns('fwd', true));
      parts.push(...this._breezeBtns('rev', true));
    }
    if (!parts.length) return '';
    return `
      <div class="rft-rgroup rft-rgroup-breeze">
        ${this._groupHeader('breeze', 'Breeze' + (merged ? ' Off' : ''))}
        <div class="rft-rrow">${parts.join('')}</div>
      </div>`;
  }

  _renderRemote() {
    // Light: traditional Dim Down (◀/down) — Light on/off (bulb) — Dim Up (▶/up).
    const light = [
      this._remoteBtn('dim_down', '<ha-icon icon="mdi:chevron-down"></ha-icon>', 'rft-rdim'),
      this._remoteBtn('light_toggle', '<ha-icon icon="mdi:lightbulb"></ha-icon>', 'rft-rlight'),
      this._remoteBtn('dim_up', '<ha-icon icon="mdi:chevron-up"></ha-icon>', 'rft-rdim')
    ].join('');

    const timers = ['timer_2h', 'timer_4h', 'timer_8h']
      .map(a => this._remoteBtn(a, `<ha-icon icon="mdi:timer-outline"></ha-icon><span class="rft-rblabel">${a.replace('timer_', '')}</span>`, 'rft-rtimer'))
      .join('') + this._remoteBtn('timer_off', '<ha-icon icon="mdi:timer-off-outline"></ha-icon> Off', 'rft-rtimer');

    const fwdSpeed = this._renderSpeedSet('fwd', 'Forward Speed', 'forward');
    const revSpeed = this._renderSpeedSet('rev', 'Reverse Speed', 'reverse');
    const breeze = this._renderBreezeRow();

    const gwWarn = !this._config.gateway_service
      ? `<div class="rft-banner rft-warn" style="margin:0 0 10px;">Set the ESPHome gateway service in the editor to enable the remote.</div>` : '';

    return `
      <div class="rft-remote">
        ${gwWarn}
        <div class="rft-remote-grid">
          ${light ? `<div class="rft-rgroup rft-rgroup-light">${this._groupHeader('light', 'Light')}<div class="rft-rrow">${light}</div></div>` : ''}
          ${fwdSpeed}
          ${revSpeed}
          ${breeze}
          ${timers ? `<div class="rft-rgroup rft-rgroup-timer">${this._groupHeader('timer', 'Timer')}<div class="rft-rrow">${timers}</div></div>` : ''}
        </div>
      </div>`;
  }

  // Re-apply the .rft-active highlight to remote buttons without re-rendering.
  _applyLastPressedHighlight() {
    this.querySelectorAll('.rft-rbtn').forEach(btn => {
      btn.classList.toggle('rft-active', this._isLast(btn.getAttribute('data-action')));
    });
  }

  _sectionCounts(s) {
    let tested = 0, working = 0;
    s.rows.forEach(r => { const f = this._flags(r.action); if (f.tested) tested++; if (f.working) working++; });
    return { total: s.rows.length, tested, working };
  }

  // Inline Light/Dim base selector (radios) — shown at the top of the Light
  // section in the Test UI so you can A/B the base without opening the editor.
  _renderBaseSelector() {
    return `
      <div class="rft-basesel">
        <label class="rft-basesel-title" for="rft-lightbase-sel">Light/Dim base (remote transmits on this):</label>
        <select id="rft-lightbase-sel" class="rft-basesel-select">
          ${LIGHT_BASE_OPTS.map(o => `<option value="${o.value}"${this._config.light_base === o.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
        </select>
      </div>`;
  }

  _renderSection(s) {
    const open = this._config.sections_open;
    const cc = this._sectionCounts(s);
    const hasRebase = s.rows.some(r => REBASE_ACTIONS[r.action]);
    return `
      <details class="rft-section" data-section="${escapeHtml(s.id)}"${open ? ' open' : ''}>
        <summary class="rft-section-sum">
          <ha-icon class="rft-section-icon" icon="${s.icon}"></ha-icon>
          <span class="rft-section-title">${escapeHtml(s.title)}</span>
          <span class="rft-section-meta">${cc.total} · ${cc.tested}✓ tested · ${cc.working}✓ working</span>
        </summary>
        <div class="rft-section-body">
          ${hasRebase ? this._renderBaseSelector() : ''}
          <table class="rft-table">
            <thead><tr>
              <th class="rft-c-trigger">Function</th>
              <th class="rft-c-code">RF code (rc_switch bits)</th>
              <th class="rft-c-flag">Tested</th>
              <th class="rft-c-flag">Working</th>
            </tr></thead>
            <tbody>${s.rows.map(r => this._renderRow(r)).join('')}</tbody>
          </table>
        </div>
      </details>`;
  }

  _triggerInner(r, sending) {
    const badge = r.num !== null ? `<span class="rft-num">${escapeHtml(r.num)}</span>` : '';
    const glyph = sending ? '<span class="rft-spinner"></span>' : '<ha-icon icon="mdi:play"></ha-icon>';
    return `${badge}${glyph}<span class="rft-trigger-label">${escapeHtml(r.label)}</span>`;
  }

  _renderRow(r) {
    const f = this._flags(r.action);
    const sending = !!this._sending[r.action];
    const canSend = !!this._config.gateway_service && !sending;
    return `
      <tr class="rft-row" data-action="${escapeHtml(r.action)}">
        <td class="rft-c-trigger">
          <button class="rft-trigger${sending ? ' rft-sending' : ''}" data-action="${escapeHtml(r.action)}"${canSend ? '' : ' disabled'} title="Transmit ${escapeHtml(r.action)}">
            ${this._triggerInner(r, sending)}
          </button>
          <span class="rft-action-key">${escapeHtml(r.action)}</span>
        </td>
        <td class="rft-c-code">
          <code class="rft-code" title="${escapeHtml(r.code)}">${escapeHtml(r.code)}</code>
          <button class="rft-edit" data-action="${escapeHtml(r.action)}" title="Edit RF code"><ha-icon icon="mdi:pencil"></ha-icon></button>
        </td>
        <td class="rft-c-flag"><label class="rft-chk"><input type="checkbox" class="rft-tested" data-action="${escapeHtml(r.action)}"${f.tested ? ' checked' : ''}></label></td>
        <td class="rft-c-flag"><label class="rft-chk"><input type="checkbox" class="rft-working" data-action="${escapeHtml(r.action)}"${f.working ? ' checked' : ''}></label></td>
      </tr>`;
  }

  _renderFooter() {
    let total = 0, tested = 0, working = 0;
    this._sections.forEach(s => s.rows.forEach(r => {
      total++; const f = this._flags(r.action); if (f.tested) tested++; if (f.working) working++;
    }));
    if (!total) return '';
    let lenNote = '';
    if (this._config.state_helper) {
      const len = packOverlay(this._overlay, this._order()).length;
      const near = len > HELPER_MAX_LEN - 20;
      lenNote = `<span class="rft-len${near ? ' rft-len-warn' : ''}" title="Length of the packed string stored in the input_text helper (cap ${HELPER_MAX_LEN})">${len}/${HELPER_MAX_LEN} chars</span>`;
    }
    return `<div class="rft-footer">
      <span>${total} action${total === 1 ? '' : 's'}</span><span>·</span>
      <span>${tested} tested</span><span>·</span>
      <span>${working} working</span>
      ${lenNote ? '<span class="rft-footer-spacer"></span>' + lenNote : ''}
    </div>`;
  }

  _styles() {
    return `
      .rft-wrap { padding: 8px 10px 4px; }
      .rft-header { font-size: 18px; font-weight: 700; color: var(--primary-text-color,#e1e1e1); padding: 6px 4px 10px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .rft-title { flex: 0 0 auto; }
      .rft-header-toggles { margin-left: auto; display: inline-flex; gap: 6px; align-items: center; }
      .rft-header-power { min-width: 40px; width: 40px; height: 40px; border-radius: 50%; }
      .rft-vtoggle { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 600; padding: 5px 10px; border-radius: 999px; cursor: pointer; border: 1px solid var(--divider-color,#444); background: transparent; color: var(--secondary-text-color,#aaa); }
      .rft-vtoggle ha-icon { --mdc-icon-size: 15px; }
      .rft-vtoggle.on { border-color: var(--primary-color,#2196F3); background: rgba(var(--rgb-primary-color,33,150,243),0.14); color: var(--primary-text-color,#fff); }
      .rft-vtoggle:hover { border-color: var(--primary-color,#2196F3); }
      .rft-badge-default { font-size: 10px; font-weight: 600; color: var(--secondary-text-color,#aaa); border: 1px solid var(--divider-color,#444); border-radius: 999px; padding: 2px 8px; text-transform: uppercase; letter-spacing: 0.04em; }
      [hidden] { display: none !important; }

      /* ---- Remote UI ---- */
      .rft-remote { border: 1px solid var(--divider-color,#3a3a3a); border-radius: 14px; background: rgba(255,255,255,0.02); padding: 14px; margin-bottom: 8px; display: flex; flex-direction: column; }
      .rft-remote-grid { display: flex; flex-direction: column; gap: 14px; }
      .rft-rgroup { display: flex; flex-direction: column; gap: 8px; }
      .rft-rglabel { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--secondary-text-color,#888); }
      .rft-rrow { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      .rft-rnone { font-size: 12px; color: var(--secondary-text-color,#777); font-style: italic; }
      .rft-rbtn { display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-width: 46px; height: 46px; padding: 0 10px; border-radius: 12px; border: 1px solid var(--divider-color,#444); background: var(--secondary-background-color,#2a2a2a); color: var(--primary-text-color,#e1e1e1); cursor: pointer; font-size: 14px; font-weight: 600; transition: transform 0.05s ease, border-color 0.1s ease; }
      .rft-rbtn:hover:not([disabled]) { border-color: var(--primary-color,#2196F3); }
      .rft-rbtn:active:not([disabled]) { transform: scale(0.94); }
      .rft-rbtn[disabled] { opacity: 0.45; cursor: not-allowed; }
      .rft-rbtn ha-icon { --mdc-icon-size: 20px; }
      .rft-rbtn.rft-sending { border-color: var(--primary-color,#2196F3); }
      .rft-rnum { font-size: 17px; font-weight: 700; }
      .rft-rblabel { font-size: 11px; font-weight: 700; }
      .rft-roff ha-icon { --mdc-icon-size: 22px; color: var(--error-color,#f44336); }
      .rft-roff.rft-active ha-icon { color: #fff; }
      .rft-rspeed { background: rgba(var(--rgb-primary-color,33,150,243),0.10); }
      .rft-rlight ha-icon, .rft-rdim ha-icon { color: var(--warning-color,#ffb300); }
      /* Last-pressed highlight (browser-persisted, per category). */
      .rft-rbtn.rft-active { border-color: var(--primary-color,#2196F3); background: var(--primary-color,#2196F3); color: #fff; box-shadow: 0 0 0 2px rgba(var(--rgb-primary-color,33,150,243),0.30); }
      .rft-rbtn.rft-active ha-icon { color: #fff; }
      .rft-spinner-dark { border: 2px solid var(--divider-color,#555); border-top-color: var(--primary-color,#2196F3); }
      .rft-banner { font-size: 12px; line-height: 1.45; border-radius: 8px; padding: 8px 10px; margin: 2px 2px 10px; }
      .rft-banner code { font-family: var(--code-font-family,monospace); }
      .rft-warn { background: rgba(255,179,0,0.12); color: var(--primary-text-color,#e1e1e1); border: 1px solid var(--warning-color,#ffb300); }
      .rft-info { background: rgba(33,150,243,0.10); color: var(--secondary-text-color,#bbb); border: 1px solid var(--divider-color,#3a3a3a); }
      .rft-capture { display: flex; flex-direction: column; gap: 6px; margin: 2px 2px 10px; padding: 8px 10px; border-radius: 8px; border: 1px dashed var(--divider-color,#444); background: rgba(255,255,255,0.02); font-size: 12px; }
      .rft-capture-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .rft-capture-label { display: inline-flex; align-items: center; gap: 5px; font-weight: 600; color: var(--secondary-text-color,#aaa); white-space: nowrap; }
      .rft-capture-val { flex: 1 1 auto; min-width: 0; }
      .rft-cap-code { font-family: var(--code-font-family,monospace); color: var(--primary-text-color,#e1e1e1); word-break: break-all; }
      .rft-cap-sep { color: var(--secondary-text-color,#666); }
      .rft-cap-match { color: var(--success-color,#4caf50); }
      .rft-cap-nomatch { color: var(--warning-color,#ffb300); }
      .rft-cap-none { color: var(--secondary-text-color,#777); font-style: italic; }
      .rft-cap-count { color: var(--secondary-text-color,#777); font-variant-numeric: tabular-nums; font-weight: 400; }
      .rft-cap-dir { font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 4px; }
      .rft-cap-sent { background: rgba(var(--rgb-primary-color,33,150,243),0.25); color: var(--primary-text-color,#e1e1e1); }
      .rft-cap-recv { background: rgba(76,175,80,0.25); color: var(--primary-text-color,#e1e1e1); }
      .rft-basesel { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 4px 4px 10px; padding: 8px 10px; border-radius: 8px; border: 1px dashed var(--divider-color,#444); background: rgba(255,255,255,0.02); }
      .rft-basesel-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; color: var(--secondary-text-color,#888); }
      .rft-basesel-select { padding: 5px 10px; border-radius: 6px; border: 1px solid var(--divider-color,#444); background: var(--secondary-background-color,#2a2a2a); color: var(--primary-text-color,#e1e1e1); font-size: 12px; }
      .rft-capture-count { color: var(--secondary-text-color,#777); font-variant-numeric: tabular-nums; }
      .rft-body { display: flex; flex-direction: column; gap: 8px; padding: 2px; }
      .rft-empty { color: var(--secondary-text-color,#888); font-size: 13px; padding: 16px 8px; }

      .rft-section { border: 1px solid var(--divider-color,#3a3a3a); border-radius: 12px; background: rgba(255,255,255,0.015); overflow: hidden; }
      .rft-section[open] { border-color: var(--primary-color,#2196F3); }
      .rft-section-sum { list-style: none; cursor: pointer; user-select: none; display: flex; align-items: center; gap: 8px; padding: 9px 12px; font-size: 14px; font-weight: 600; color: var(--primary-text-color,#e1e1e1); }
      .rft-section-sum::-webkit-details-marker { display: none; }
      .rft-section-sum::marker { content: ''; }
      .rft-section-icon { --mdc-icon-size: 20px; color: var(--primary-color,#2196F3); flex: 0 0 auto; }
      .rft-section-title { flex: 1 1 auto; }
      .rft-section-meta { font-size: 11px; font-weight: 500; color: var(--secondary-text-color,#888); white-space: nowrap; }
      .rft-section-body { padding: 0 8px 8px; }

      .rft-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .rft-table th { text-align: left; color: var(--secondary-text-color,#888); font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: 0.03em; padding: 4px 8px; border-bottom: 1px solid var(--divider-color,#333); }
      .rft-table th.rft-c-flag { text-align: center; }
      .rft-table td { padding: 6px 8px; vertical-align: middle; border-bottom: 1px solid var(--divider-color,#2a2a2a); color: var(--primary-text-color,#e1e1e1); }
      .rft-row:hover td { background: rgba(255,255,255,0.02); }
      .rft-c-trigger { width: 44%; }
      .rft-c-flag { width: 62px; text-align: center; }

      .rft-trigger { display: inline-flex; align-items: center; gap: 6px; background: var(--primary-color,#2196F3); color: #fff; border: none; border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 13px; font-weight: 500; max-width: 100%; }
      .rft-trigger:hover:not([disabled]) { filter: brightness(1.08); }
      .rft-trigger[disabled] { opacity: 0.5; cursor: not-allowed; }
      .rft-trigger ha-icon { --mdc-icon-size: 16px; flex: 0 0 auto; }
      .rft-num { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 3px; border-radius: 999px; background: rgba(255,255,255,0.22); font-size: 11px; font-weight: 700; flex: 0 0 auto; }
      .rft-trigger-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .rft-action-key { display: block; font-family: var(--code-font-family,monospace); font-size: 10px; color: var(--secondary-text-color,#777); margin-top: 3px; padding-left: 2px; }
      .rft-c-code { display: flex; align-items: center; gap: 6px; }
      .rft-code { font-family: var(--code-font-family,monospace); font-size: 11px; color: var(--secondary-text-color,#aaa); word-break: break-all; flex: 1 1 auto; }
      .rft-edit { background: transparent; border: none; color: var(--secondary-text-color,#888); cursor: pointer; padding: 2px; display: inline-flex; flex: 0 0 auto; border-radius: 4px; }
      .rft-edit:hover { color: var(--primary-color,#2196F3); background: rgba(255,255,255,0.04); }
      .rft-edit ha-icon { --mdc-icon-size: 15px; }
      .rft-chk { display: inline-flex; cursor: pointer; }
      .rft-chk input { width: 18px; height: 18px; cursor: pointer; accent-color: var(--primary-color,#2196F3); }
      .rft-spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.4); border-top-color: #fff; animation: rft-spin 0.7s linear infinite; flex: 0 0 auto; }
      @keyframes rft-spin { to { transform: rotate(360deg); } }

      .rft-footer { display: flex; align-items: center; gap: 8px; padding: 10px 6px 8px; font-size: 11px; color: var(--secondary-text-color,#888); }
      .rft-footer-spacer { flex: 1 1 auto; }
      .rft-len { font-variant-numeric: tabular-nums; }
      .rft-len-warn { color: var(--warning-color,#ffb300); font-weight: 600; }
    `;
  }

  // ------------------------------------------------------------------------
  // EVENT WIRING
  // ------------------------------------------------------------------------
  _attachHandlers() {
    const root = this;
    // Header show/hide toggles for the Remote / Test regions.
    root.querySelectorAll('.rft-vtoggle').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation(); this._onViewToggle(b.getAttribute('data-view'));
    }));
    // Remote: transmit buttons — fromRemote=true so light/dim rebase onto speed.
    root.querySelectorAll('.rft-rbtn').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation(); this._transmitAction(b.getAttribute('data-action'), true);
    }));
    root.querySelectorAll('.rft-trigger').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation(); this._onTrigger(b.getAttribute('data-action'));
    }));
    root.querySelectorAll('.rft-edit').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation(); e.preventDefault(); this._onEditCode(b.getAttribute('data-action'));
    }));
    root.querySelectorAll('.rft-tested').forEach(cb => cb.addEventListener('change', () => {
      this._onFlag(cb.getAttribute('data-action'), 't', cb.checked);
    }));
    root.querySelectorAll('.rft-working').forEach(cb => cb.addEventListener('change', () => {
      this._onFlag(cb.getAttribute('data-action'), 'w', cb.checked);
    }));
    // Inline Light/Dim base selector (Test UI). Live-only: updates the runtime
    // config so the next light/dim press uses it.
    const baseSel = root.querySelector('#rft-lightbase-sel');
    if (baseSel) baseSel.addEventListener('change', () => {
      this._config.light_base = baseSel.value;
      this._toast(`Light/Dim base: ${baseSel.value}`, false);
    });
  }

  // ------------------------------------------------------------------------
  // TRIGGER — transmit the raw RF code directly via the ESPHome gateway.
  // Both the test-table rows and the remote buttons funnel through here.
  // ------------------------------------------------------------------------
  // Test-table triggers. Light/Dim still rebase onto the chosen base (so the
  // base dropdown works here too); everything else sends literal.
  _onTrigger(action) { return this._transmitAction(action, false); }

  // Resolve the code to actually transmit. Light/Dim are modifiers on a speed
  // base; from the remote we rebuild the frame on the base chosen by light_base
  // so the command doesn't change the fan's speed:
  //   'fwd0'/'rev0' — fixed Forward/Reverse Speed-0 base (reliable; ignores
  //                   physical-remote speed changes)
  //   'last_speed'  — base = last speed pressed from THIS card
  //   'literal'     — no rebase (send the captured code as-is)
  // A usable forward reference code (baseline suffix). Prefer speed_0, else any
  // forward speed_N.
  _fwdRefBits() {
    let r = this._flat['speed_0'];
    if (!r) { for (let n = 1; n <= 9; n++) { if (this._flat['speed_' + n]) { r = this._flat['speed_' + n]; break; } } }
    return r ? normalizeTxCode(r.code) : null;
  }

  // Compute the base bit-string for the current light_base mode (or an explicit
  // override mode). Returns null if it can't be built.
  _lightBaseBits(mode) {
    if (mode === 'fwd0') { const r = this._flat['speed_0']; return r ? normalizeTxCode(r.code) : null; }
    if (mode === 'rev0') { const r = this._flat['reverse_0']; return r ? normalizeTxCode(r.code) : null; }
    if (mode === 'last_speed') { const a = this._lastPressed && this._lastPressed.fan; const r = a && this._flat[a]; return r ? normalizeTxCode(r.code) : null; }
    if (mode && mode.indexOf('fake_') === 0) {
      // Take forward speed-0 and overwrite bits 16-19 with the fake pattern.
      const base = this._flat['speed_0'] ? normalizeTxCode(this._flat['speed_0'].code) : this._fwdRefBits();
      const pat = mode.slice(5);
      if (!base || !/^[01]+$/.test(base) || pat.length !== SPEED_FIELD_LEN || base.length < SPEED_FIELD_START + SPEED_FIELD_LEN) return null;
      return base.slice(0, SPEED_FIELD_START) + pat + base.slice(SPEED_FIELD_START + SPEED_FIELD_LEN);
    }
    return null;
  }

  // Only Light/Dim are rebased (they're speed modifiers); speeds/breeze/timers
  // always send literal. Rebasing applies to BOTH the remote and the test-table
  // Light/Dim rows, so the base dropdown affects what you see in either place.
  _effectiveTxCode(action, literalBits, fromRemote) {
    if (!REBASE_ACTIONS[action]) return literalBits;     // only light/dim rebase
    const mode = this._config.light_base;
    if (mode === 'literal') return literalBits;
    const baseBits = this._lightBaseBits(mode);
    const fwdRef = this._fwdRefBits();
    if (!baseBits || !fwdRef) return literalBits;
    return rebaseCommandOntoSpeed(literalBits, baseBits, fwdRef);
  }

  // ------------------------------------------------------------------------
  // LIVE READOUT — shows the last code that went through the card ("sent",
  // always works) AND the last code the fan's ESPHome node received from a
  // physical remote (via event esphome.rf_fan_received, if that fires). Great
  // for verifying exactly what the card transmits and for capturing codes.
  // ------------------------------------------------------------------------
  _matchAction(code) {
    const bits = normalizeTxCode(code);
    const codes = effectiveCodes(this._config);
    for (const a of Object.keys(codes)) { if (normalizeTxCode(codes[a]) === bits) return a; }
    return null;
  }

  // Record a code for the readout. dir: 'sent' (TX) | 'recv' (RX).
  _noteCapture(code, dir) {
    if (!code) return;
    const slot = dir === 'recv' ? this._capture.rx : this._capture.tx;
    slot.code = String(code);
    slot.matched = this._matchAction(code);
    slot.count++;
    this._renderCaptureReadout();
  }

  _startCapture() {
    if (!this._config.show_capture) return;
    if (this._capture.unsub) return;   // already subscribed
    const hass = this._hass;
    if (!hass || !hass.connection || typeof hass.connection.subscribeEvents !== 'function') return;
    const handler = (ev) => {
      const data = (ev && ev.data) || {};
      const code = data.code != null ? String(data.code) : '';
      if (code) this._noteCapture(code, 'recv');
    };
    try {
      const p = hass.connection.subscribeEvents(handler, 'esphome.rf_fan_received');
      this._capture.unsub = p;   // store the promise; resolve to real unsub below
      p.then(u => { if (this._capture.unsub === p) this._capture.unsub = u; else { try { u(); } catch (e) {} } })
       .catch(() => { this._capture.unsub = null; });
    } catch (e) { debugLog('capture subscribe failed', e); }
  }

  _stopCapture() {
    const rec = this._capture;
    if (!rec || !rec.unsub) return;
    const u = rec.unsub;
    rec.unsub = null;
    if (typeof u === 'function') { try { u(); } catch (e) {} }
    else if (u && typeof u.then === 'function') { u.then(fn => { try { fn(); } catch (e) {} }).catch(() => {}); }
  }

  // Format: [TX] Last Sent (#count)   <code> - match [name] / no match
  _captureLineHtml(slot, dirLabel, text) {
    const cap = this._config.capture || DEFAULT_CAPTURE;
    const dirCls = dirLabel === 'RX' ? 'rft-cap-recv' : 'rft-cap-sent';
    const cnt = (cap.count && slot.count) ? ` <span class="rft-cap-count">(#${slot.count})</span>` : '';
    const label = `<span class="rft-capture-label"><span class="rft-cap-dir ${dirCls}">${dirLabel}</span> ${text}${cnt}</span>`;
    let body;
    if (!slot.code) {
      body = '<span class="rft-cap-none">—</span>';
    } else {
      const code = `<code class="rft-cap-code">${escapeHtml(slot.code)}</code>`;
      let match = '';
      if (cap.match) {
        match = slot.matched
          ? ` <span class="rft-cap-sep">-</span> <span class="rft-cap-match">match: ${escapeHtml(effectiveLabel(this._config, slot.matched))} (${escapeHtml(slot.matched)})</span>`
          : ` <span class="rft-cap-sep">-</span> <span class="rft-cap-nomatch">no match</span>`;
      }
      body = `${code}${match}`;
    }
    return `${label} <span class="rft-capture-val">${body}</span>`;
  }

  _renderCaptureReadout() {
    const txLine = this.querySelector('.rft-cap-tx-line');
    if (txLine) txLine.innerHTML = this._captureLineHtml(this._capture.tx, 'TX', 'Last Sent');
    const rxLine = this.querySelector('.rft-cap-rx-line');
    if (rxLine) rxLine.innerHTML = this._captureLineHtml(this._capture.rx, 'RX', 'Last Received');
  }

  async _transmitAction(action, fromRemote) {
    const c = this._config;
    const hass = this._hass;
    if (!action || !c) return;
    const row = this._flat[action];
    const code = row ? row.code : null;
    const label = row ? row.label : (DEFAULT_LABELS[action] || action);
    if (!code) { this._toast(`No code for "${action}".`, true); return; }
    if (!c.gateway_service) { this._toast('Set the ESPHome gateway service in the editor first.', true); return; }
    if (!hass || typeof hass.callService !== 'function') { this._toast('hass.callService unavailable.', true); return; }

    const txCode = this._effectiveTxCode(action, normalizeTxCode(code), fromRemote);

    if (c.confirm_send) {
      const ok = await this._confirmModal({
        title: 'Transmit RF code?',
        body: `This transmits <b>${escapeHtml(label)}</b> (<code>${escapeHtml(action)}</code>) to the fan.<br><code>${escapeHtml(txCode)}</code>`,
        confirmLabel: 'Transmit'
      });
      if (!ok) return;
    }

    const service = `${c.gateway_service}_transmit_rf_fan`;
    this._sending[action] = true;
    this._patchTriggerButton(action);
    this._patchRemoteButtons(action);
    try {
      await hass.callService('esphome', service, { action, code: txCode, repeat_count: c.repeat_count });
      this._noteLastPressed(action);
      if (this._config.show_capture) this._noteCapture(txCode, 'sent');
      this._toast(`Sent ${label} ✓`, false);
    } catch (err) {
      this._toast(`Send failed: ${formatWsError(err)}`, true);
    } finally {
      this._sending[action] = false;
      this._patchTriggerButton(action);
      this._patchRemoteButtons(action);
    }
  }

  _patchTriggerButton(action) {
    const btn = this.querySelector(`.rft-trigger[data-action="${cssEscape(action)}"]`);
    if (!btn) return;
    const sending = !!this._sending[action];
    const canSend = !!this._config.gateway_service && !sending;
    btn.disabled = !canSend;
    btn.classList.toggle('rft-sending', sending);
    const row = this._flat[action] || { label: action, num: null };
    btn.innerHTML = this._triggerInner(row, sending);
  }

  // Reflect send state on the remote button(s) for this action (spinner/disable)
  // without a full re-render.
  _patchRemoteButtons(action) {
    const sending = !!this._sending[action];
    const canSend = !!this._config.gateway_service && !sending;
    this.querySelectorAll(`.rft-rbtn[data-action="${cssEscape(action)}"]`).forEach(btn => {
      btn.disabled = !canSend;
      btn.classList.toggle('rft-sending', sending);
    });
  }

  // Show/hide a UI region live. Never leaves both hidden when only one exists;
  // if the user hides the last-visible region, we simply allow it (blank body).
  _onViewToggle(view) {
    if (!this._view) return;
    this._view[view] = !this._view[view];
    const region = this.querySelector(`.rft-body [data-region="${view}"]`);
    const btn = this.querySelector(`.rft-vtoggle[data-view="${view}"]`);
    if (region) { if (this._view[view]) region.removeAttribute('hidden'); else region.setAttribute('hidden', ''); }
    if (btn) btn.classList.toggle('on', this._view[view]);
  }

  // ------------------------------------------------------------------------
  // FLAGS -> persist to input_text helper (bit-packed).
  // ------------------------------------------------------------------------
  async _onFlag(action, key, checked) {
    if (!action) return;
    const rec = { ...(this._overlay[action] || {}) };
    if (checked) rec[key] = 1; else delete rec[key];
    if (Object.keys(rec).length) this._overlay[action] = rec;
    else delete this._overlay[action];

    this._updateSectionMeta(action);
    this._updateFooter();

    const c = this._config;
    const hass = this._hass;
    if (!c.state_helper) { this._toast('No helper set — change not saved.', true); return; }
    if (!hass || typeof hass.callService !== 'function') return;

    const value = packOverlay(this._overlay, this._order());
    if (value.length > HELPER_MAX_LEN) {
      this._toast(`Stored string too long (${value.length}/${HELPER_MAX_LEN}). Raise the input_text max length.`, true);
    }
    try {
      await hass.callService('input_text', 'set_value', { entity_id: c.state_helper, value });
    } catch (err) {
      this._toast(`Could not save: ${formatWsError(err)}`, true);
    }
  }

  _updateSectionMeta(action) {
    const secId = ACTION_SECTION[action] || 'other';
    const s = this._sections.find(x => x.id === secId);
    if (!s) return;
    const cc = this._sectionCounts(s);
    const el = this.querySelector(`.rft-section[data-section="${cssEscape(s.id)}"] .rft-section-meta`);
    if (el) el.textContent = `${cc.total} · ${cc.tested}✓ tested · ${cc.working}✓ working`;
  }

  _updateFooter() {
    const footer = this.querySelector('.rft-footer');
    if (!footer) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = this._renderFooter();
    const fresh = wrap.querySelector('.rft-footer');
    if (fresh) footer.replaceWith(fresh);
  }

  // ------------------------------------------------------------------------
  // EDIT CODE — edit a row's RF code string, with a confirm-before-save step.
  // Codes live in the card CONFIG (not a server config entry), so a save writes
  // the edited code into the card's `codes` override and fires config-changed
  // (persists to the dashboard YAML when the card owns its config). We ALSO
  // apply it in-memory immediately, so the change takes effect even in contexts
  // where config-changed isn't captured (a plain, non-editor view).
  // ------------------------------------------------------------------------
  async _onEditCode(action) {
    const row = this._flat[action];
    if (!row) return;
    const current = row.code;
    const result = await this._promptModal({
      title: 'Edit RF code',
      label: `Code for “${escapeHtml(row.label)}” (${escapeHtml(action)})`,
      value: current,
      hint: 'Opaque code string, e.g. <code>6:0101…</code> or <code>raw:150,-5839,…</code>. This is sent verbatim to the ESPHome gateway.',
      confirmLabel: 'Next'
    });
    if (result === null) return;                // cancelled
    const next = String(result).trim();
    if (!next) { this._toast('Code cannot be empty.', true); return; }
    if (next === current) { this._toast('No change.', false); return; }

    // Confirm before the save actually happens.
    const ok = await this._confirmModal({
      title: 'Save code change?',
      body: `This replaces the RF code for <b>${escapeHtml(row.label)}</b> (<code>${escapeHtml(action)}</code>).<br><br>` +
        `<span style="color:var(--secondary-text-color,#aaa);">Old:</span> <code>${escapeHtml(current)}</code><br>` +
        `<span style="color:var(--secondary-text-color,#aaa);">New:</span> <code>${escapeHtml(next)}</code><br><br>` +
        `Saved into the card's <b>codes</b> override (persists in the dashboard config).`,
      confirmLabel: 'Save code'
    });
    if (!ok) return;

    this._persistCodeEdit(action, next);
    this._toast('Code updated ✓', false);
  }

  // Merge the edited code into an explicit codes override (starting from the
  // effective map, so editing a single built-in code snapshots the full set),
  // apply in-memory, emit config-changed, and repaint just that row.
  _persistCodeEdit(action, code) {
    const base = { ...effectiveCodes(this._config) };
    base[action] = code;
    this._config.codes = normalizeCodes(base);

    // In-memory: update the live row + section model so the UI reflects it now.
    if (this._flat[action]) this._flat[action].code = code;

    // Emit config-changed so a card that owns its config persists to YAML.
    try {
      this.dispatchEvent(new CustomEvent('config-changed', {
        detail: { config: normalizeConfig(this._config) },
        bubbles: true,
        composed: true
      }));
    } catch (e) { debugLog('config-changed dispatch failed', e); }

    // Repaint the one code cell in place (no full reflow).
    const rowCodeEl = this.querySelector(`tr.rft-row[data-action="${cssEscape(action)}"] .rft-code`);
    if (rowCodeEl) { rowCodeEl.textContent = code; rowCodeEl.setAttribute('title', code); }
  }

  // ------------------------------------------------------------------------
  // MODAL / TOAST
  // ------------------------------------------------------------------------
  _showModal(contentEl) {
    const dlg = document.createElement('dialog');
    dlg.style.cssText = 'padding:0;border:none;background:transparent;max-width:none;max-height:none;';
    const st = document.createElement('style');
    st.textContent = 'dialog::backdrop{background:rgba(0,0,0,0.55);}';
    dlg.appendChild(st);
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--ha-card-background,var(--card-background-color,#1c1c1c));color:var(--primary-text-color,#e1e1e1);border:1px solid var(--divider-color,#444);border-radius:12px;max-width:520px;width:min(520px,92vw);max-height:85vh;overflow:auto;padding:18px;box-sizing:border-box;box-shadow:0 8px 40px rgba(0,0,0,0.5);';
    box.appendChild(contentEl);
    dlg.appendChild(box);
    const close = () => { try { dlg.close(); } catch (e) {} if (dlg.parentNode) dlg.parentNode.removeChild(dlg); };
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    document.body.appendChild(dlg);
    try { dlg.showModal(); } catch (e) { dlg.setAttribute('open', ''); }
    return { close, box };
  }

  _confirmModal({ title, body, confirmLabel }) {
    return new Promise(resolve => {
      const wrap = document.createElement('div');
      const accent = 'var(--primary-color,#2196F3)';
      wrap.innerHTML = `
        <div style="font-size:16px;font-weight:700;margin-bottom:8px;">${title}</div>
        <div style="font-size:13px;color:var(--secondary-text-color,#bbb);line-height:1.5;margin-bottom:16px;">${body}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="rft-m-cancel" style="padding:8px 14px;border:1px solid var(--divider-color,#444);border-radius:6px;background:transparent;color:var(--primary-text-color,#e1e1e1);cursor:pointer;font-size:13px;">Cancel</button>
          <button class="rft-m-ok" style="padding:8px 16px;border:none;border-radius:6px;background:${accent};color:#fff;cursor:pointer;font-size:13px;">${escapeHtml(confirmLabel || 'Confirm')}</button>
        </div>`;
      const modal = this._showModal(wrap);
      wrap.querySelector('.rft-m-cancel').onclick = () => { modal.close(); resolve(false); };
      wrap.querySelector('.rft-m-ok').onclick = () => { modal.close(); resolve(true); };
    });
  }

  // Text-input modal. Resolves with the entered string, or null if cancelled.
  _promptModal({ title, label, value, hint, confirmLabel }) {
    return new Promise(resolve => {
      const wrap = document.createElement('div');
      const accent = 'var(--primary-color,#2196F3)';
      wrap.innerHTML = `
        <div style="font-size:16px;font-weight:700;margin-bottom:8px;">${title}</div>
        ${label ? `<div style="font-size:12px;color:var(--secondary-text-color,#bbb);margin-bottom:6px;">${label}</div>` : ''}
        <input class="rft-m-input" type="text" value="${escapeHtml(value || '')}" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--divider-color,#444);border-radius:6px;background:var(--secondary-background-color,#2a2a2a);color:var(--primary-text-color,#e1e1e1);font-family:var(--code-font-family,monospace);font-size:12px;">
        ${hint ? `<div style="font-size:11px;color:var(--secondary-text-color,#888);line-height:1.4;margin-top:8px;">${hint}</div>` : ''}
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
          <button class="rft-m-cancel" style="padding:8px 14px;border:1px solid var(--divider-color,#444);border-radius:6px;background:transparent;color:var(--primary-text-color,#e1e1e1);cursor:pointer;font-size:13px;">Cancel</button>
          <button class="rft-m-ok" style="padding:8px 16px;border:none;border-radius:6px;background:${accent};color:#fff;cursor:pointer;font-size:13px;">${escapeHtml(confirmLabel || 'OK')}</button>
        </div>`;
      const modal = this._showModal(wrap);
      const input = wrap.querySelector('.rft-m-input');
      const done = (v) => { modal.close(); resolve(v); };
      wrap.querySelector('.rft-m-cancel').onclick = () => done(null);
      wrap.querySelector('.rft-m-ok').onclick = () => done(input ? input.value : null);
      if (input) {
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); done(input.value); }
        });
        try { input.focus(); input.select(); } catch (e) {}
      }
    });
  }

  _toast(msg, isError) {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = `position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:99999;padding:10px 18px;border-radius:8px;font-size:13px;color:#fff;box-shadow:0 4px 20px rgba(0,0,0,0.4);background:${isError ? 'var(--error-color,#f44336)' : 'var(--success-color,#4caf50)'};`;
    document.body.appendChild(el);
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, isError ? 4500 : 2000);
  }

  // ------------------------------------------------------------------------
  // LIVE PATCH — re-sync overlay if the helper changed externally.
  // ------------------------------------------------------------------------
  updateStates() {
    const hass = this._hass;
    if (!hass || !this._rendered) return;
    const st = this._helperState();
    if (!st) return;
    if (Object.keys(this._sending).some(k => this._sending[k])) return;
    const order = this._order();
    const incoming = unpackOverlay(st.state, order);
    if (packOverlay(incoming, order) === packOverlay(this._overlay, order)) return;
    this._overlay = incoming;
    Object.keys(this._flat).forEach(action => {
      const f = this._flags(action);
      const t = this.querySelector(`.rft-tested[data-action="${cssEscape(action)}"]`);
      const w = this.querySelector(`.rft-working[data-action="${cssEscape(action)}"]`);
      if (t) t.checked = f.tested;
      if (w) w.checked = f.working;
    });
    this._sections.forEach(s => {
      const cc = this._sectionCounts(s);
      const el = this.querySelector(`.rft-section[data-section="${cssEscape(s.id)}"] .rft-section-meta`);
      if (el) el.textContent = `${cc.total} · ${cc.tested}✓ tested · ${cc.working}✓ working`;
    });
    this._updateFooter();
  }
}

// ============================================================================
// EDITOR — RFTCardEditor
// ============================================================================

class RFTCardEditor extends HTMLElement {
  constructor() {
    super();
    this._config = null;
    this._hass = null;
    this._rendered = false;
    this._lastKnownJSON = null;
  }

  setConfig(config) {
    const normalized = normalizeConfig(config || {});
    const json = JSON.stringify(normalized);
    if (this._lastKnownJSON === json) { this._config = normalizeConfigFull(config || {}); return; }
    this._config = normalizeConfigFull(config || {});
    this._rendered = false;
    this.renderEditor();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._config && !this._rendered) this.renderEditor();
  }

  _fireConfigChanged() {
    let normalized;
    try { normalized = normalizeConfig(this._config); }
    catch (e) { normalized = this._config; }
    this._lastKnownJSON = JSON.stringify(normalized);
    this.dispatchEvent(new CustomEvent('config-changed', {
      detail: { config: JSON.parse(JSON.stringify(normalized)) },
      bubbles: true,
      composed: true
    }));
  }

  _inputTextEntities() {
    const hass = this._hass;
    if (!hass || !hass.states) return [];
    return Object.keys(hass.states).filter(e => e.indexOf('input_text.') === 0).sort();
  }

  renderEditor() {
    if (!this._config) return;
    const c = this._config;
    const helpers = this._inputTextEntities();
    const usingDefaults = !Object.keys(c.codes).length;
    const codesText = Object.keys(c.codes).length ? JSON.stringify(c.codes, null, 2) : '';
    const labelsText = Object.keys(c.labels).length ? JSON.stringify(c.labels, null, 2) : '';

    this.innerHTML = `
      <div class="rft-ed">
        <style>${this._edStyles()}</style>

        <div class="rft-ed-header">
          <ha-icon icon="mdi:remote"></ha-icon>
          <span class="rft-ed-title">RF Fan Test Card</span>
          <span class="rft-ed-build">${BUILD_NUMBER}</span>
        </div>

        <details class="rft-ed-row" open>
          <summary class="rft-ed-sum"><span class="rft-ed-sum-title">Gateway &amp; Behavior</span><ha-icon class="rft-ed-chev" icon="mdi:chevron-down"></ha-icon></summary>
          <div class="rft-ed-body">
            <div class="rft-ed-field"><span>Title</span>
              <input id="ed-title" type="text" placeholder="RF Fan Test" value="${escapeHtml(c.title || '')}">
            </div>
            <div class="rft-ed-field"><span>ESPHome gateway service</span>
              <input id="ed-gateway" type="text" placeholder="rf_fan_gateway" value="${escapeHtml(c.gateway_service || '')}">
            </div>
            <div class="rft-ed-subhint">The ESPHome node's service prefix. The card calls <code>esphome.&lt;prefix&gt;_transmit_rf_fan</code> directly — bypassing the rf_fan integration. Find it under <b>Developer Tools → Actions</b> (search <code>_transmit_rf_fan</code>) and enter the part before <code>_transmit_rf_fan</code>.</div>
            <div class="rft-ed-slider-row">
              <span>Repeat count</span>
              <input id="ed-repeat" type="range" min="1" max="10" step="1" value="${Number(c.repeat_count) || 4}">
              <span class="rft-ed-slider-value" id="ed-repeat-val">${Number(c.repeat_count) || 4}</span>
            </div>
            <label class="rft-ed-check"><input type="checkbox" id="ed-confirm"${c.confirm_send ? ' checked' : ''}> Confirm before transmitting</label>
            <label class="rft-ed-check"><input type="checkbox" id="ed-sections-open"${c.sections_open ? ' checked' : ''}> Test-table sections expanded by default</label>
          </div>
        </details>

        <details class="rft-ed-row" open>
          <summary class="rft-ed-sum"><span class="rft-ed-sum-title">Views (Remote / Test)</span><ha-icon class="rft-ed-chev" icon="mdi:chevron-down"></ha-icon></summary>
          <div class="rft-ed-body">
            <div class="rft-ed-hint">The card has two UI regions: a <b>Remote</b> (physical-remote-style buttons) and a <b>Test</b> table (per-code trigger + tested/working). Header chips let you show/hide each live; here you set which are available and which is shown first.</div>
            <label class="rft-ed-check"><input type="checkbox" id="ed-show-remote"${c.show_remote ? ' checked' : ''}> Enable Remote UI</label>
            <label class="rft-ed-check"><input type="checkbox" id="ed-show-test"${c.show_test ? ' checked' : ''}> Enable Test UI</label>
            <div class="rft-ed-field"><span>Show on load</span>
              <select id="ed-default-view">
                <option value="remote"${c.default_view === 'remote' ? ' selected' : ''}>Remote</option>
                <option value="test"${c.default_view === 'test' ? ' selected' : ''}>Test</option>
                <option value="both"${c.default_view === 'both' ? ' selected' : ''}>Both</option>
              </select>
            </div>
            <label class="rft-ed-check"><input type="checkbox" id="ed-breeze-with-speed"${c.breeze_with_speed ? ' checked' : ''}> Show breeze buttons with each direction's speeds</label>
            <div class="rft-ed-subhint">On: each direction's breeze buttons sit in that direction's speed row. Off: all breeze buttons share their own <b>Breeze</b> section.</div>
            <div class="rft-ed-field"><span>Light/Dim base</span>
              <select id="ed-light-base">
                ${LIGHT_BASE_OPTS.map(o => `<option value="${o.value}"${c.light_base === o.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
              </select>
            </div>
            <div class="rft-ed-subhint">Light/Dim are speed modifiers, so the frame carries a speed. To avoid changing the fan speed, the remote rebuilds Light/Dim on a chosen base. The <b>Fake speed</b> options put an unused value in the speed field — try each to find one your fan accepts for light without moving the blades. Also selectable live in the Test UI's Light section.</div>
            <label class="rft-ed-check"><input type="checkbox" id="ed-single-power"${c.single_power ? ' checked' : ''}> Use a single on/off button (top-right)</label>
            <div class="rft-ed-field"><span>Single power sends</span>
              <select id="ed-single-power-dir"${c.single_power ? '' : ' disabled'}>
                <option value="fwd"${c.single_power_dir === 'fwd' ? ' selected' : ''}>Forward Off (speed_0)</option>
                <option value="rev"${c.single_power_dir === 'rev' ? ' selected' : ''}>Reverse Off (reverse_0)</option>
              </select>
            </div>
            <div class="rft-ed-subhint">On: replaces the per-direction Off buttons with one power button in the remote's top-right corner, sending the chosen off code.</div>
            <label class="rft-ed-check"><input type="checkbox" id="ed-show-capture"${c.show_capture ? ' checked' : ''}> Show live capture readout</label>
            <div class="rft-ed-subhint">Displays the last code sent (TX) / received (RX) by the fan's ESPHome node (event <code>esphome.rf_fan_received</code>) and whether it matches a known action. Handy for capturing/verifying codes without opening ESPHome logs.</div>
            <div class="rft-ed-capture-elems" style="padding-left:22px;">
              <label class="rft-ed-check"><input type="checkbox" class="ed-cap" data-cap="tx"${c.capture.tx ? ' checked' : ''}> TX line (Last Sent)</label>
              <label class="rft-ed-check"><input type="checkbox" class="ed-cap" data-cap="rx"${c.capture.rx ? ' checked' : ''}> RX line (Last Received)</label>
              <label class="rft-ed-check"><input type="checkbox" class="ed-cap" data-cap="count"${c.capture.count ? ' checked' : ''}> Count (#N)</label>
              <label class="rft-ed-check"><input type="checkbox" class="ed-cap" data-cap="match"${c.capture.match ? ' checked' : ''}> Match / no-match label</label>
            </div>
          </div>
        </details>

        <details class="rft-ed-row">
          <summary class="rft-ed-sum"><span class="rft-ed-sum-title">Remote Buttons</span><ha-icon class="rft-ed-chev" icon="mdi:chevron-down"></ha-icon></summary>
          <div class="rft-ed-body">
            <div class="rft-ed-group-title">Section headers</div>
            <div class="rft-ed-hint">Show or hide each remote section's header label. (Light is hidden by default.)</div>
            ${HEADER_GROUPS.map(k => `<label class="rft-ed-check"><input type="checkbox" class="ed-header" data-header="${k}"${c.headers[k] ? ' checked' : ''}> ${escapeHtml({ light: 'Light', forward: 'Forward Speed', reverse: 'Reverse Speed', breeze: 'Breeze', timer: 'Timer' }[k])}</label>`).join('')}
            <div class="rft-ed-group-title">Buttons</div>
            <div class="rft-ed-hint">Choose which buttons appear on the Remote. Unchecked buttons are hidden. (Only codes that exist are listed. Note: <b>Breeze Off</b> is included but is known not to work on this fan — hide it here if you don't want it.)</div>
            ${this._renderButtonToggles(c)}
          </div>
        </details>

        <details class="rft-ed-row" open>
          <summary class="rft-ed-sum"><span class="rft-ed-sum-title">Tested / Working storage</span><ha-icon class="rft-ed-chev" icon="mdi:chevron-down"></ha-icon></summary>
          <div class="rft-ed-body">
            <div class="rft-ed-hint">The Tested/Working checkboxes don't map to the fan. They're saved into an <b>input_text</b> helper (bit-packed, ~14 chars for all codes). Create one (Settings → Devices &amp; Services → Helpers → Text) and select it here.</div>
            <div class="rft-ed-field"><span>State helper</span>
              <select id="ed-helper">
                <option value="">— none (won't persist) —</option>
                ${helpers.map(h => `<option value="${escapeHtml(h)}"${h === c.state_helper ? ' selected' : ''}>${escapeHtml(h)}</option>`).join('')}
              </select>
            </div>
            ${c.state_helper && helpers.indexOf(c.state_helper) === -1 ? `<div class="rft-ed-subhint" style="color:var(--ltek-c-warning);">Configured helper <code>${escapeHtml(c.state_helper)}</code> not found in this instance.</div>` : ''}
          </div>
        </details>

        <details class="rft-ed-row">
          <summary class="rft-ed-sum"><span class="rft-ed-sum-title">RF codes ${usingDefaults ? '(built-in)' : '(custom)'}</span><ha-icon class="rft-ed-chev" icon="mdi:chevron-down"></ha-icon></summary>
          <div class="rft-ed-body">
            <div class="rft-ed-hint">This card ships with the full built-in map for this fan (34 codes). Leave blank to use it. To override, paste a JSON object of <code>{ "action": "code" }</code> — bare rc_switch bit strings (e.g. <code>01011110…</code>) or <code>raw:150,-5839,…</code> timings. A leading <code>&lt;proto&gt;:</code> prefix is stripped at transmit.</div>
            <textarea id="ed-codes" class="rft-ed-ta" rows="8" placeholder='(blank = use built-in codes)'>${escapeHtml(codesText)}</textarea>
            <div class="rft-ed-err" id="ed-codes-err"></div>
          </div>
        </details>

        <details class="rft-ed-row">
          <summary class="rft-ed-sum"><span class="rft-ed-sum-title">Label overrides (optional)</span><ha-icon class="rft-ed-chev" icon="mdi:chevron-down"></ha-icon></summary>
          <div class="rft-ed-body">
            <div class="rft-ed-hint">Optional friendly names: <code>{ "action": "Label" }</code>, merged over the built-in labels.</div>
            <textarea id="ed-labels" class="rft-ed-ta" rows="5" placeholder='{\n  "speed_0": "Off"\n}'>${escapeHtml(labelsText)}</textarea>
            <div class="rft-ed-err" id="ed-labels-err"></div>
          </div>
        </details>

        <details class="rft-ed-row">
          <summary class="rft-ed-sum"><span class="rft-ed-sum-title">YAML preview</span><ha-icon class="rft-ed-chev" icon="mdi:chevron-down"></ha-icon></summary>
          <div class="rft-ed-body">
            <div class="rft-ed-hint">Read-only.</div>
            <pre class="rft-ed-yaml">${escapeHtml(toYaml(normalizeConfig(this._config)))}</pre>
          </div>
        </details>
      </div>
    `;
    this._rendered = true;
    this._attachEditorHandlers();
  }

  // Per-button show/hide checkboxes for the remote, grouped by category.
  _renderButtonToggles(c) {
    const codes = effectiveCodes(c);
    const order = remoteActionOrder(codes);
    if (!order.length) return `<div class="rft-ed-hint">No codes configured.</div>`;
    const hidden = c.hidden_buttons || [];
    const groups = [
      ['Light', ['light_toggle', 'dim_up', 'dim_down']],
      ['Forward Speed', order.filter(a => /^speed_\d+$/.test(a))],
      ['Reverse Speed', order.filter(a => /^reverse_\d+$/.test(a))],
      ['Breeze', ['breeze_off'].concat(order.filter(a => /^(breeze|reverse_breeze)_\d+$/.test(a)))],
      ['Timer', ['timer_off', 'timer_2h', 'timer_4h', 'timer_8h']]
    ];
    return groups.map(([title, actions]) => {
      const items = actions.filter(a => codes[a] !== undefined);
      if (!items.length) return '';
      const checks = items.map(a => {
        const shown = hidden.indexOf(a) === -1;
        return `<label class="rft-ed-check"><input type="checkbox" class="ed-btn" data-action="${escapeHtml(a)}"${shown ? ' checked' : ''}> ${escapeHtml(effectiveLabel(c, a))}</label>`;
      }).join('');
      return `<div class="rft-ed-group-title">${escapeHtml(title)}</div>${checks}`;
    }).join('');
  }

  _attachEditorHandlers() {
    const root = this;
    const set = (fn) => { fn(); this._fireConfigChanged(); this._refreshYaml(); };

    const titleEl = root.querySelector('#ed-title');
    if (titleEl) titleEl.addEventListener('input', () => set(() => { this._config.title = titleEl.value; }));

    const gwEl = root.querySelector('#ed-gateway');
    if (gwEl) gwEl.addEventListener('input', () => set(() => { this._config.gateway_service = gwEl.value.trim(); }));

    const helperEl = root.querySelector('#ed-helper');
    if (helperEl) helperEl.addEventListener('change', () => set(() => { this._config.state_helper = helperEl.value; }));

    const confirmEl = root.querySelector('#ed-confirm');
    if (confirmEl) confirmEl.addEventListener('change', () => set(() => { this._config.confirm_send = confirmEl.checked; }));

    const secOpenEl = root.querySelector('#ed-sections-open');
    if (secOpenEl) secOpenEl.addEventListener('change', () => set(() => { this._config.sections_open = secOpenEl.checked; }));

    const showRemoteEl = root.querySelector('#ed-show-remote');
    if (showRemoteEl) showRemoteEl.addEventListener('change', () => set(() => { this._config.show_remote = showRemoteEl.checked; }));
    const showTestEl = root.querySelector('#ed-show-test');
    if (showTestEl) showTestEl.addEventListener('change', () => set(() => { this._config.show_test = showTestEl.checked; }));
    const defViewEl = root.querySelector('#ed-default-view');
    if (defViewEl) defViewEl.addEventListener('change', () => set(() => { this._config.default_view = defViewEl.value; }));

    const bwsEl = root.querySelector('#ed-breeze-with-speed');
    if (bwsEl) bwsEl.addEventListener('change', () => set(() => { this._config.breeze_with_speed = bwsEl.checked; }));

    const lightBaseEl = root.querySelector('#ed-light-base');
    if (lightBaseEl) lightBaseEl.addEventListener('change', () => set(() => { this._config.light_base = lightBaseEl.value; }));
    const showCapEl = root.querySelector('#ed-show-capture');
    if (showCapEl) showCapEl.addEventListener('change', () => set(() => { this._config.show_capture = showCapEl.checked; }));
    root.querySelectorAll('.ed-cap').forEach(cb => cb.addEventListener('change', () => set(() => {
      const k = cb.getAttribute('data-cap');
      this._config.capture = { ...normalizeCapture(this._config.capture), [k]: cb.checked };
    })));

    const spEl = root.querySelector('#ed-single-power');
    const spDirEl = root.querySelector('#ed-single-power-dir');
    if (spEl) spEl.addEventListener('change', () => set(() => {
      this._config.single_power = spEl.checked;
      if (spDirEl) spDirEl.disabled = !spEl.checked;
    }));
    if (spDirEl) spDirEl.addEventListener('change', () => set(() => { this._config.single_power_dir = spDirEl.value === 'rev' ? 'rev' : 'fwd'; }));

    root.querySelectorAll('.ed-header').forEach(cb => cb.addEventListener('change', () => set(() => {
      const key = cb.getAttribute('data-header');
      this._config.headers = { ...normalizeHeaders(this._config.headers), [key]: cb.checked };
    })));

    // Per-button show/hide: checked = shown, so hidden_buttons = unchecked ones.
    root.querySelectorAll('.ed-btn').forEach(cb => cb.addEventListener('change', () => set(() => {
      const action = cb.getAttribute('data-action');
      const hidden = new Set(this._config.hidden_buttons || []);
      if (cb.checked) hidden.delete(action); else hidden.add(action);
      this._config.hidden_buttons = Array.from(hidden);
    })));

    const repEl = root.querySelector('#ed-repeat');
    const repVal = root.querySelector('#ed-repeat-val');
    if (repEl) repEl.addEventListener('input', () => set(() => { this._config.repeat_count = Number(repEl.value) || 4; if (repVal) repVal.textContent = repEl.value; }));

    const codesEl = root.querySelector('#ed-codes');
    const codesErr = root.querySelector('#ed-codes-err');
    if (codesEl) codesEl.addEventListener('input', () => {
      const raw = codesEl.value.trim();
      if (raw === '') { codesErr.textContent = ''; set(() => { this._config.codes = {}; }); return; }
      try {
        const o = JSON.parse(raw);
        if (!isPlainObject(o)) throw new Error('Must be a JSON object.');
        codesErr.textContent = '';
        set(() => { this._config.codes = normalizeCodes(o); });
      } catch (e) { codesErr.textContent = 'Invalid JSON: ' + e.message; }
    });

    const labelsEl = root.querySelector('#ed-labels');
    const labelsErr = root.querySelector('#ed-labels-err');
    if (labelsEl) labelsEl.addEventListener('input', () => {
      const raw = labelsEl.value.trim();
      if (raw === '') { labelsErr.textContent = ''; set(() => { this._config.labels = {}; }); return; }
      try {
        const o = JSON.parse(raw);
        if (!isPlainObject(o)) throw new Error('Must be a JSON object.');
        labelsErr.textContent = '';
        set(() => { this._config.labels = normalizeLabels(o); });
      } catch (e) { labelsErr.textContent = 'Invalid JSON: ' + e.message; }
    });
  }

  _refreshYaml() {
    const pre = this.querySelector('.rft-ed-yaml');
    if (pre) pre.textContent = toYaml(normalizeConfig(this._config));
  }

  _edStyles() {
    return `
        /* ============================================================
           DESIGN TOKENS — single source of truth for the whole editor.
           (Mirrors the ANM/EES/Color editor token block for parity.)
           ============================================================ */
        .rft-ed {
          --ltek-fs-panel-title: 16px;
          --ltek-fs-header: 15px;
          --ltek-fs-group: 14px;
          --ltek-fs-label: 13px;
          --ltek-fs-body: 12px;
          --ltek-fs-small: 11px;
          --ltek-fs-tiny: 10px;
          --ltek-fw-normal: 400;
          --ltek-fw-medium: 500;
          --ltek-fw-semibold: 600;
          --ltek-fw-bold: 700;
          --ltek-c-text: var(--primary-text-color, #e1e1e1);
          --ltek-c-label: #ccc;
          --ltek-c-muted: #888;
          --ltek-c-accent: var(--primary-color, #2196F3);
          --ltek-c-accent-fade: rgba(var(--rgb-primary-color,33,150,243),0.12);
          --ltek-c-accent-fade-soft: rgba(var(--rgb-primary-color,33,150,243),0.08);
          --ltek-c-error-fade: rgba(244,67,54,0.15);
          --ltek-c-error: var(--error-color, #f44336);
          --ltek-c-success: var(--success-color, #4caf50);
          --ltek-c-warning: var(--warning-color, #ffb300);
          --ltek-c-info: var(--info-color, #2196F3);
          --ltek-c-accent-lib: #7fd18a;
          --ltek-c-on-accent: #fff;
          --ltek-c-icon: #aaa;
          --ltek-c-icon-hover: #fff;
          --ltek-c-surface: rgba(255,255,255,0.015);
          --ltek-c-surface-raised: rgba(255,255,255,0.02);
          --ltek-c-panel-border: #3a3a3a;
          --ltek-c-border: #444;
          --ltek-c-border-soft: #333;
          --ltek-r-panel: 12px;
          --ltek-r-card: 10px;
          --ltek-r-md: 8px;
          --ltek-r-ctrl: 6px;
          --ltek-sp-1: 4px;
          --ltek-sp-2: 6px;
          --ltek-sp-3: 8px;
          --ltek-sp-4: 10px;
          --ltek-sp-5: 12px;
          --ltek-sp-6: 16px;
          --ltek-ctrl-pad: 6px 10px;
          --ltek-icon-sm: 16px;
          --ltek-icon-lg: 20px;
          --ltek-slider-val-w: 44px;
          display: flex; flex-direction: column; gap: 8px; padding: 8px 0;
        }

        .rft-ed-header { display: flex; align-items: center; gap: var(--ltek-sp-3); padding: 2px 2px 10px; border-bottom: 1px solid var(--ltek-c-border-soft); }
        .rft-ed-header ha-icon { --mdc-icon-size: 22px; color: var(--ltek-c-accent); }
        .rft-ed-title { font-size: var(--ltek-fs-header); font-weight: var(--ltek-fw-semibold); color: var(--ltek-c-text); }
        .rft-ed-build { margin-left: auto; font-size: var(--ltek-fs-small); color: var(--ltek-c-muted); font-family: var(--code-font-family, monospace); }
        details.rft-ed-row {
          display: block;
          border: 1px solid var(--ltek-c-panel-border);
          border-radius: var(--ltek-r-panel);
          background: var(--ltek-c-surface);
        }
        details.rft-ed-row[open] { border-color: var(--ltek-c-accent); }
        .rft-ed-sum {
          list-style: none; cursor: pointer; user-select: none;
          display: flex; align-items: center; gap: var(--ltek-sp-3);
          padding: 10px 14px;
          font-size: var(--ltek-fs-panel-title);
          font-weight: var(--ltek-fw-bold);
          color: var(--ltek-c-text);
        }
        .rft-ed-sum::-webkit-details-marker { display: none; }
        .rft-ed-sum::marker { content: ''; }
        .rft-ed-sum .rft-ed-sum-title { flex: 1 1 auto; }
        .rft-ed-chev {
          --mdc-icon-size: var(--ltek-icon-lg); color: var(--ltek-c-muted); flex: 0 0 auto;
          transition: transform 0.15s ease;
        }
        details.rft-ed-row[open] .rft-ed-chev { transform: rotate(180deg); color: var(--ltek-c-accent); }
        .rft-ed-body {
          display: flex; flex-direction: column; gap: var(--ltek-sp-4);
          padding: 0 14px 14px;
        }
        .rft-ed-hint { font-size: var(--ltek-fs-small); color: var(--ltek-c-muted); line-height: 1.45; }
        .rft-ed-hint code, .rft-ed-subhint code { font-family: var(--code-font-family, monospace); color: var(--ltek-c-label); }
        .rft-ed-subhint { font-size: var(--ltek-fs-small); color: var(--ltek-c-muted); line-height: 1.4; margin: -4px 0 2px; }
        .rft-ed-subhint b { color: var(--ltek-c-label); font-weight: var(--ltek-fw-semibold); }
        .rft-ed-field { display: flex; align-items: center; gap: var(--ltek-sp-3); flex-wrap: wrap; }
        .rft-ed-field > span { font-size: var(--ltek-fs-label); color: var(--ltek-c-label); min-width: 150px; }
        .rft-ed-field input[type=text], .rft-ed-field select {
          flex: 1 1 180px; padding: var(--ltek-ctrl-pad);
          border: 1px solid var(--ltek-c-border); border-radius: var(--ltek-r-ctrl);
          background: var(--secondary-background-color, #2a2a2a); color: var(--ltek-c-text);
          font-size: var(--ltek-fs-body);
        }
        .rft-ed-check { display: flex; align-items: center; gap: var(--ltek-sp-2); font-size: var(--ltek-fs-label); color: var(--ltek-c-label); cursor: pointer; }
        .rft-ed-group-title { font-size: var(--ltek-fs-small); font-weight: var(--ltek-fw-bold); text-transform: uppercase; letter-spacing: 0.04em; color: var(--ltek-c-accent); margin-top: var(--ltek-sp-2); }
        .rft-ed-slider-row { display: flex; align-items: center; gap: var(--ltek-sp-3); }
        .rft-ed-slider-row > span:first-child { font-size: var(--ltek-fs-label); color: var(--ltek-c-label); min-width: 150px; }
        .rft-ed-slider-row input[type=range] { flex: 1; }
        .rft-ed-slider-value { width: var(--ltek-slider-val-w); text-align: right; font-variant-numeric: tabular-nums; font-size: var(--ltek-fs-body); color: var(--ltek-c-text); }
        .rft-ed-ta {
          width: 100%; box-sizing: border-box; padding: var(--ltek-sp-4);
          border: 1px solid var(--ltek-c-border); border-radius: var(--ltek-r-md);
          background: var(--secondary-background-color, #2a2a2a); color: var(--ltek-c-text);
          font-family: var(--code-font-family, monospace); font-size: var(--ltek-fs-small);
          resize: vertical; line-height: 1.4;
        }
        .rft-ed-err { font-size: var(--ltek-fs-small); color: var(--ltek-c-error); min-height: 14px; }
        .rft-ed-yaml { margin: 0; padding: var(--ltek-sp-4); background: var(--secondary-background-color, #2a2a2a); border-radius: var(--ltek-r-md); font-family: var(--code-font-family, monospace); font-size: var(--ltek-fs-small); color: var(--ltek-c-text); white-space: pre-wrap; overflow-x: auto; }
    `;
  }
}

// ============================================================================
// REGISTER CUSTOM ELEMENTS
// ============================================================================
console.log(`📦 Registering rf-fan-test-card custom elements... [${BUILD_NUMBER}]`);
customElements.define('rf-fan-test-card', RFTCard);
customElements.define('rf-fan-test-card-editor', RFTCardEditor);
console.log('[rf-fan-test-card] Loaded successfully -', BUILD_NUMBER);
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'rf-fan-test-card',
  name: 'RF Fan Test Card',
  description: 'Bench-test RF fan codes directly through the ESPHome gateway; grouped in sections with per-code tested/working tracking.',
});
