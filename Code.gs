/**
 * ============================================================================
 * AGENT PERFORMANCE HUB - GRANULAR MICRO-PARTITIONED DRIVE BACKEND
 * ============================================================================
 * مبني بالكامل على الخوارزميات المعتمدة والدقيقة من agent-dashboard-data.js:
 * 1. معالجة وتطبيع دقيقة لكافة أنواع البيانات والهيدرات ثنائية الأبعاد (Multi-level headers).
 * 2. حسابات دقيقة 100% لمؤشرات الأداء:
 *    - CSAT: استخراج عمود csat_adjusted / score وفحص التقييمات الإيجابية والسلبية بدقة.
 *    - Break Breaches: فحص حصري لأعمدة break exceed (Not Met / دقائق التجاوز) وفصلها تماماً عن التأخير.
 *    - Lateness: فحص حصري لـ exceed mins أو فارق التوقيت بين بداية الوردية الفعلية والمخططة.
 *    - AGBT & ABST: حساب متوسط أوقات المناولة والجلسات الطويلة (أكبر من 20 دقيقة).
 *    - Daily Timeline: استخراج التاريخ اليومي الفعلي لكل صف وبناء مؤشرات كل يوم تلقائياً.
 * 3. منع التكرار الذكي (Deduplication): اعتماد خوارزمية rowKey و alignRowColumns.
 * 4. التجزئة الدقيقة في Google Drive: كل مقياس لكل موظف في ملف مستقل (drills/agent_{email}_{metric}.json).
 * 5. استجابة فائقة السرعة للشاشة الرئيسية عبر summary_overview.json وكاش الذاكرة (CacheService).
 * ============================================================================
 */

// Reuse permission lists and the root folder within ONE synchronous read only.
// The finally block prevents cached authorization from crossing RPC requests.
let dashboardReadContext_ = null;
function withDashboardReadContext_(work) {
  if (dashboardReadContext_) return work();
  dashboardReadContext_ = new Map();
  try { return work(); } finally { dashboardReadContext_ = null; }
}
function memoDashboardRead_(key, read) {
  if (!dashboardReadContext_) return read();
  if (dashboardReadContext_.has(key)) return dashboardReadContext_.get(key);
  const value = read();
  dashboardReadContext_.set(key, value);
  return value;
}

const CONFIG = {
  // اسم المجلد الرئيسي في Google Drive
  DRIVE_FOLDER_NAME: "Agent_Performance_Hub_Data",

  // ملف الملخص الإحصائي السريع والمخصص للشاشة الرئيسية (Serving Model)
  SUMMARY_FILE_NAME: "summary.json",
  LEGACY_SUMMARY_FILE_NAME: "summary_overview.json",

  // مجلد البيانات الوصفية وفهرس الأشهر
  META_FOLDER_NAME: "meta",
  MONTHS_INDEX_FILE: "months.json",
  META_FILE_NAME: "meta.json",

  // رقم إصدار بنية البيانات لضمان التوافق المستقبلي
  SCHEMA_VERSION: 1,

  // اسم المجلد الفرعي لملفات المقاييس المستقلة لكل وكيل
  DRILLS_FOLDER_NAME: "drills",

  // معرف ملف Google Sheet للتخزين الإداري التلخيصي (اختياري)
  SPREADSHEET_ID: "",
  SHEET_SUMMARY: "Daily_Summary",
  SHEET_ARCHIVE: "Historical_Archive",
  SHEET_LOGS: "System_Logs"
};

const METRICS_NAMES = {
  csat: 'CSAT',
  agbt: 'AGBT',
  abst: 'ABST',
  idle: 'Idle',
  breakBreach: 'Break breach',
  lateness: 'Lateness',
  productivity: 'Productivity'
};

/**
 * ============================================================================
 * Phase 3 — Hardening primitives (constants / error taxonomy / logging / lock / validation)
 * ============================================================================
 */
const CURRENT_SCHEMA_VERSION = CONFIG.SCHEMA_VERSION || 1;
const IMPORT_MAX_BYTES = 25 * 1024 * 1024;   // 25MB
const IMPORT_MAX_RESULTS = 2000;
const IMPORT_MAX_ROWS_PER_RESULT = 20000;
const IMPORT_MAX_ROW_CELLS = 200;
const IMPORT_ALLOWED_METRICS = ['csat', 'agbt', 'abst', 'idle', 'breakbreach', 'lateness', 'productivity'];

// رموز أخطاء داخلية مستقرة (Client يعرض رسالة عامة، والسجل يحتفظ بالتفاصيل)
const ERR = {
  INVALID_MONTH: 'INVALID_MONTH',
  INVALID_RANGE: 'INVALID_RANGE',
  UNAUTHORIZED: 'UNAUTHORIZED',
  ADMIN_REQUIRED: 'ADMIN_REQUIRED',
  PRIMARY_ADMIN_REQUIRED: 'PRIMARY_ADMIN_REQUIRED',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  INVALID_JSON: 'INVALID_JSON',
  LOCK_TIMEOUT: 'LOCK_TIMEOUT',
  IMPORT_VALIDATION_FAILED: 'IMPORT_VALIDATION_FAILED',
  DRIVE_ERROR: 'DRIVE_ERROR',
  CONSISTENCY_ERROR: 'CONSISTENCY_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
};

function makeAppError_(code, message) {
  const e = new Error(message || code);
  e.appCode = code;
  return e;
}
function errorCode_(err) {
  return (err && err.appCode) ? err.appCode : ERR.INTERNAL_ERROR;
}

// لا نفسّر إصدارًا غير معروف بصمت كأنه الإصدار الحالي
function isSupportedSchema_(obj) {
  if (!obj || typeof obj !== 'object') return true;
  const v = (obj.version !== undefined) ? obj.version : obj.schemaVersion;
  if (v === undefined || v === null || v === '') return true; // legacy/غير مُوسم => نعتبره المدعوم
  return Number(v) <= CURRENT_SCHEMA_VERSION;
}

// Structured logging (لا بيانات تذاكر/أسرار/حِزم ضخمة — فقط حقول تشغيلية)
function logEvent_(event, fields) {
  try {
    const entry = Object.assign({ event: event, ts: new Date().toISOString() }, fields || {});
    console.log(JSON.stringify(entry));
  } catch (e) { /* تجاهل */ }
}

// قفل ScriptLock بأضيق نطاق للعمليات الذرّية (Read→Modify→Write)
function withScriptLock_(fn, timeoutMs) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(timeoutMs || 30000);
  } catch (e) {
    throw makeAppError_(ERR.LOCK_TIMEOUT, 'تعذر الحصول على القفل. أعد المحاولة.');
  }
  try {
    return fn();
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// تحقق بنيوي صارم لحمولة الاستيراد (Server-side، لا نعتمد على الواجهة)
function validateImportPayload_(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, code: ERR.IMPORT_VALIDATION_FAILED, error: 'صيغة الحمولة غير صالحة.' };
  }
  if (payload.formatVersion !== undefined && Number(payload.formatVersion) !== 1) {
    return { ok: false, code: ERR.IMPORT_VALIDATION_FAILED, error: 'إصدار الصيغة غير مدعوم.' };
  }
  const hasResults = Array.isArray(payload.results);
  const hasAgents = Array.isArray(payload.agents);
  const resultsLen = hasResults ? payload.results.length : 0;
  const agentsLen = hasAgents ? payload.agents.length : 0;
  if (resultsLen === 0 && agentsLen === 0) {
    return { ok: false, code: ERR.IMPORT_VALIDATION_FAILED, error: 'لا توجد بيانات (results/agents).' };
  }
  if (resultsLen > IMPORT_MAX_RESULTS) return { ok: false, code: ERR.IMPORT_VALIDATION_FAILED, error: 'عدد النتائج كبير جدًا.' };
  if (agentsLen > IMPORT_MAX_RESULTS) return { ok: false, code: ERR.IMPORT_VALIDATION_FAILED, error: 'عدد الوكلاء كبير جدًا.' };

  if (resultsLen > 0) {
    for (let i = 0; i < payload.results.length; i++) {
      const r = payload.results[i];
      if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, code: ERR.IMPORT_VALIDATION_FAILED, error: 'عنصر نتيجة غير صالح.' };
      const agent = String(r.agent || r.email || '').trim();
      if (!agent || agent.length > 320) return { ok: false, code: ERR.IMPORT_VALIDATION_FAILED, error: 'اسم/إيميل الوكيل غير صالح.' };
      const metric = String(r.metric || '').trim().toLowerCase();
      if (IMPORT_ALLOWED_METRICS.indexOf(metric) === -1) return { ok: false, code: ERR.IMPORT_VALIDATION_FAILED, error: 'مقياس غير مسموح: ' + metric };
      if (!Array.isArray(r.rows)) return { ok: false, code: ERR.IMPORT_VALIDATION_FAILED, error: 'صفوف غير صالحة.' };
      if (r.rows.length > IMPORT_MAX_ROWS_PER_RESULT) return { ok: false, code: ERR.IMPORT_VALIDATION_FAILED, error: 'عدد الصفوف كبير جدًا.' };
      if (r.header !== undefined && !Array.isArray(r.header)) return { ok: false, code: ERR.IMPORT_VALIDATION_FAILED, error: 'هيدر غير صالح.' };
      for (let j = 0; j < r.rows.length; j++) {
        const row = r.rows[j];
        if (!Array.isArray(row)) return { ok: false, code: ERR.IMPORT_VALIDATION_FAILED, error: 'صف غير صالح.' };
        if (row.length > IMPORT_MAX_ROW_CELLS) return { ok: false, code: ERR.IMPORT_VALIDATION_FAILED, error: 'عدد الأعمدة كبير جدًا.' };
        for (let c = 0; c < row.length; c++) {
          const cell = row[c];
          if (typeof cell === 'number' && (!isFinite(cell) || isNaN(cell))) {
            return { ok: false, code: ERR.IMPORT_VALIDATION_FAILED, error: 'قيمة رقمية غير صالحة (NaN/Infinity).' };
          }
        }
      }
    }
  }
  return { ok: true };
}

/**
 * ============================================================================
 * 1. دوال معالجة وتطبيع البيانات النقية (Pure Data Normalization & Calculations)
 *    مأخوذة ومطابقة بالكامل لـ agent-dashboard-data.js
 * ============================================================================
 */

function textCell(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function findColIndex(headers, ...candidates) {
  if (!Array.isArray(headers)) return -1;
  const lowerHeaders = headers.map(h => String(h).toLowerCase().trim());
  for (const candidate of candidates) {
    const target = candidate.toLowerCase();
    const idx = lowerHeaders.findIndex(h => h === target || h.includes(target));
    if (idx !== -1) return idx;
  }
  return -1;
}

function extractRowTimestamp(row, header) {
  if (!row || !header) return null;
  const h = header.map(c => String(c).toLowerCase().trim());
  const priorityNames = ['day','report_dt','ticket_creation_date','date_resolved_dubai','created_at_dubai','csat_submitted_at_dubai','shift_date','plan_shift_start','fact_shift_start','call_start_date','date'];
  for (const name of priorityNames) {
    const idx = h.findIndex(c => c === name || c.includes(name));
    if (idx !== -1 && row[idx]) {
      const ts = parseTimestampValue(String(row[idx]));
      if (ts) return ts;
    }
  }
  for (let idx = 0; idx < h.length; idx++) {
    const col = h[idx];
    if (col.includes('date') || col.includes('day') || col.includes('dt') || col.includes('time') || col.includes('start') || col.endsWith('_at')) {
      const ts = parseTimestampValue(String(row[idx] || ''));
      if (ts) return ts;
    }
  }
  return null;
}

function parseTimestampValue(str) {
  const s = String(str || '').trim();
  if (!s) return null;
  const dt = s.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
  if (dt) {
    const y = +dt[1], mo = +dt[2], d = +dt[3], hh = +dt[4], mi = +dt[5], ss = +(dt[6] || 0);
    if (y > 2000 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && hh >= 0 && hh <= 23 && mi >= 0 && mi <= 59) {
      return dt[1] + '-' + dt[2].padStart(2, '0') + '-' + dt[3].padStart(2, '0') + ' ' + String(hh).padStart(2, '0') + ':' + String(mi).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
    }
  }
  const dOnly = s.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (dOnly) {
    const y = +dOnly[1], mo = +dOnly[2], d = +dOnly[3];
    if (y > 2000 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return dOnly[1] + '-' + dOnly[2].padStart(2, '0') + '-' + dOnly[3].padStart(2, '0') + ' 00:00:00';
    }
  }
  const dmy = s.match(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/);
  if (dmy) {
    const d1 = +dmy[1], d2 = +dmy[2], y = +dmy[3];
    if (d1 >= 1 && d1 <= 31 && d2 >= 1 && d2 <= 12 && y > 2000) {
      return dmy[3] + '-' + dmy[2].padStart(2, '0') + '-' + dmy[1].padStart(2, '0') + ' 00:00:00';
    }
  }
  const fb = new Date(s);
  if (!isNaN(fb.getTime()) && fb.getFullYear() > 2000) {
    return fb.getFullYear() + '-' + String(fb.getMonth() + 1).padStart(2, '0') + '-' + String(fb.getDate()).padStart(2, '0') + ' ' + String(fb.getHours()).padStart(2, '0') + ':' + String(fb.getMinutes()).padStart(2, '0') + ':00';
  }
  return null;
}

function shiftDayFromTimestamp(ts, cutoffHour) {
  const parts = String(ts).split(/[- :]/);
  const dt = new Date(+parts[0], +parts[1] - 1, +parts[2], +parts[3], +parts[4], +(parts[5] || 0));
  dt.setHours(dt.getHours() - cutoffHour);
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}

const SHIFT_TOTAL_OFFSET_HOURS = 8; // (legacy) لم يعد مستخدمًا — بقي للتوافق المرجعي فقط
function extractRowDate(row, header) {
  const ts = extractRowTimestamp(row, header);
  return ts ? ts.slice(0, 10) : null;
}

/**
 * ============================================================================
 * طبقة الشفت المستقلة (Shift Normalization Layer)
 * - تحويل صريح لتوقيت دبي (UTC+4) إلى توقيت الرياض (UTC+3) عبر Utilities.
 * - استنتاج نافذة الشفت من توزيع ساعات البيانات (فجوة الخمول الأطول).
 * - إسناد كل Timestamp إلى تاريخ بداية الشفت (يتعامل مع عبور منتصف الليل).
 * ملاحظة: هذه الطبقة لا تُستخدم في وضع "حسب اليوم" إطلاقاً.
 * ============================================================================
 */
const SHIFT_MIN_SAMPLES = 12;   // أقل عدد صفوف لاستنتاج الشفت بثقة
const SHIFT_MIN_GAP_HOURS = 4;  // أقل طول فجوة خمول لاعتبارها حد شفت
const SHIFT_CONCENTRATION = 0.75; // نسبة النشاط داخل النافذة النشطة

const DUBAI_TIME_PATTERNS = [
  "yyyy-MM-dd HH:mm:ss", "yyyy/MM/dd HH:mm:ss",
  "yyyy-MM-dd HH:mm", "yyyy/MM/dd HH:mm",
  "yyyy-MM-dd'T'HH:mm:ss", "yyyy/MM/dd'T'HH:mm:ss",
  "yyyy-MM-dd", "yyyy/MM/dd"
];

/**
 * يفسّر قيمة بتوقيت دبي ثم يعيدها كنص بتوقيت الرياض (yyyy-MM-dd HH:mm:ss).
 */
function dubaiTimestampToRiyadh(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return null;
  // المسار الصريح المفضّل: تفسير كتوقيت دبي ثم تحويله إلى الرياض
  for (const pattern of DUBAI_TIME_PATTERNS) {
    try {
      const d = Utilities.parseDate(s, "Asia/Dubai", pattern);
      if (d && !isNaN(d.getTime())) {
        return Utilities.formatDate(d, "Asia/Riyadh", "yyyy-MM-dd HH:mm:ss");
      }
    } catch (e) { /* جرّب النمط التالي */ }
  }
  // احتياطي: تحليل عادي ثم تحويل دبي→الرياض (فرق ساعة واحدة ثابت، لا يوجد DST في المنطقتين)
  const ts = parseTimestampValue(s);
  if (!ts) return null;
  const parts = ts.split(/[- :]/);
  const dt = new Date(+parts[0], +parts[1] - 1, +parts[2], +parts[3], +parts[4], +(parts[5] || 0));
  dt.setHours(dt.getHours() - 1);
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0') + ' ' + String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0') + ':' + String(dt.getSeconds()).padStart(2, '0');
}

/**
 * يستخرج توقيت الصف بصيغة الرياض: يفضّل أعمدة دبي ثم يعود لأي عمود وقت آخر.
 */
function shiftTimestampForRow(row, header) {
  if (!row || !header) return null;
  const h = header.map(c => String(c).toLowerCase().trim());
  const dubaiNames = ['created_at_dubai', 'date_resolved_dubai', 'csat_submitted_at_dubai', 'ticket_creation_date_dubai', 'call_start_date_dubai'];
  for (const name of dubaiNames) {
    const idx = findColIndex(h, name);
    if (idx !== -1 && row[idx]) {
      const ts = dubaiTimestampToRiyadh(row[idx]);
      if (ts) return ts;
    }
  }
  for (let idx = 0; idx < h.length; idx++) {
    if (h[idx].indexOf('_dubai') !== -1 && row[idx]) {
      const ts = dubaiTimestampToRiyadh(row[idx]);
      if (ts) return ts;
    }
  }
  return extractRowTimestamp(row, header);
}

/**
 * يستنتج نافذة الشفت {startHour, endHour} من قائمة توقيتات الرياض (نص).
 * يعيد null إذا لم تكن البيانات كافية لاستنتاج موثوق (بدون تخمين).
 */
function inferShiftWindowFromTimestamps(timestamps) {
  const hist = new Array(24).fill(0);
  let total = 0;
  for (const ts of timestamps) {
    if (!ts) continue;
    const hh = parseInt(String(ts).slice(11, 13), 10);
    if (isNaN(hh) || hh < 0 || hh > 23) continue;
    hist[hh]++;
    total++;
  }
  if (total < SHIFT_MIN_SAMPLES) return null;

  const maxCount = Math.max.apply(null, hist);
  if (maxCount <= 0) return null;
  const threshold = Math.max(1, Math.floor(maxCount * 0.05));

  // أطول فجوة دائرية للخمول (نتضاعف المصفوفة للتعامل مع العبور)
  let bestLen = 0, bestStart = 0, len = 0, runStart = 0;
  for (let k = 0; k < 48; k++) {
    const hour = k % 24;
    if (hist[hour] <= threshold) {
      if (len === 0) runStart = k;
      len++;
      if (len > bestLen && len <= 24) { bestLen = len; bestStart = runStart; }
    } else {
      len = 0;
    }
  }
  if (bestLen < SHIFT_MIN_GAP_HOURS || bestLen >= 24) return null;

  // بداية الشفت = الساعة التي تنتهي عندها فجوة الخمول، ونهايته = بداية الفجوة
  const startHour = (bestStart + bestLen) % 24;
  const endHour = bestStart % 24;

  let activeCount = 0;
  for (let i = 0; i < 24; i++) if (hist[i] > threshold) activeCount += hist[i];
  if (total <= 0 || (activeCount / total) < SHIFT_CONCENTRATION) return null;

  return {
    startHour: startHour,
    endHour: endHour,
    gapHours: bestLen,
    samples: total,
    inferred: true
  };
}

/**
 * يحوّل توقيت الرياض إلى تاريخ بداية الشفت. startHour=0 يطابق اليوم التقويمي تماماً.
 */
function shiftDateFromRiyadhTs(ts, shiftWindow) {
  if (!ts) return null;
  const parts = String(ts).split(/[- :]/);
  if (parts.length < 3) return null;
  const y = +parts[0], mo = +parts[1], d = +parts[2];
  if (isNaN(y) || isNaN(mo) || isNaN(d)) return null;
  const hh = isNaN(+parts[3]) ? 0 : +parts[3];
  const startHour = (shiftWindow && typeof shiftWindow.startHour === 'number') ? shiftWindow.startHour : 0;
  const dt = new Date(y, mo - 1, d, hh, 0, 0);
  if (startHour > 0 && hh < startHour) dt.setDate(dt.getDate() - 1);
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}


/**
 * ============================================================================
 * INTELLIGENT BY-SHIFT INFERENCE (activity-cluster based, adaptive)
 * ----------------------------------------------------------------------------
 * - Does NOT use a fixed shift start/end, a "before X AM = yesterday" rule, or
 *   a universal fixed inactivity threshold.
 * - Prefers explicit shift events (fact_shift_start / plan_shift_start) when present.
 * - Otherwise clusters the agent's chronological activity around the requested
 *   month (plus previous/next month neighbors) and derives the boundary from the
 *   observed gap distribution (Otsu threshold on gaps) — data-driven per agent.
 * - Midnight is never a boundary by itself.
 * - When boundaries are not confidently separable → mark uncertain and fall back
 *   to the safest existing behavior (calendar day) instead of inventing a boundary.
 * - Only the BUCKET DATE changes; every metric formula stays in calculateAnalytics.
 * ============================================================================
 */
function _shiftAddMonths_(month, delta) {
  const y = parseInt(String(month).slice(0, 4), 10);
  const m = parseInt(String(month).slice(5, 7), 10);
  const d = new Date(y, (m - 1) + delta, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function _shiftRowKey_(rec, rowIndex) {
  return String((rec && rec.fileName) || '') + '#' + rowIndex;
}

// يحوّل "YYYY-MM-DD HH:mm:ss" (توقيت الرياض، UTC+3 بدون DST) إلى epoch ms.
function _riyadhTsToEpochMs_(ts) {
  const s = String(ts || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - 3 * 3600 * 1000;
}
function _epochMsToRiyadh_(ms) { return new Date(ms + 3 * 3600 * 1000); }
function _epochMsToRiyadhDate_(ms) {
  const d = _epochMsToRiyadh_(ms);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
function _epochMsToRiyadhHHMM_(ms) {
  const d = _epochMsToRiyadh_(ms);
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}

// عمود المدة الموثوق (جلسة ABST فقط) — نستخدمه لبناء فترات النشاط لا مجرد نقاط.
function _shiftDurationColIdx_(header, metric) {
  const h = header || [];
  if (metric === 'abst') {
    return h.findIndex(c => c === 'basket_session_time_min' || c.includes('basket_session_time') || c === 'abst');
  }
  return -1;
}

// Otsu threshold على log1p(gaps) — بياناتي بالكامل (لا ثابت).
function _otsuThreshold_(values) {
  if (!values || values.length < 2) return { t: null };
  const xs = values.map(v => Math.log1p(Math.max(0, Number(v) || 0)));
  let min = Infinity, max = -Infinity;
  xs.forEach(x => { if (x < min) min = x; if (x > max) max = x; });
  if (!(max > min)) return { t: null };
  const bins = 32;
  const hist = new Array(bins).fill(0);
  xs.forEach(x => {
    let b = Math.floor(((x - min) / (max - min)) * bins);
    if (b >= bins) b = bins - 1; if (b < 0) b = 0;
    hist[b]++;
  });
  const total = xs.length;
  let sumAll = 0; for (let i = 0; i < bins; i++) sumAll += i * hist[i];
  let sumB = 0, wB = 0, best = -1, bestT = -1;
  for (let i = 0; i < bins; i++) {
    wB += hist[i]; if (wB === 0) continue;
    const wF = total - wB; if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; bestT = i; }
  }
  if (bestT < 0) return { t: null };
  const tLog = min + ((bestT + 1) / bins) * (max - min);
  return { t: Math.expm1(tLog) };
}

function _shiftCollectEvents_(records) {
  const events = [];
  for (const r of (records || [])) {
    const header = r.header || [];
    const h = header.map(c => String(c).toLowerCase().trim());
    const factIdx = h.findIndex(c => c === 'fact_shift_start');
    const planIdx = h.findIndex(c => c === 'plan_shift_start');
    const durIdx = _shiftDurationColIdx_(h, r.metric);
    const rows = r.rows || [];
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      const ts = shiftTimestampForRow(row, r.header);
      let explicitEpoch = null;
      let explicitTs = null;
      if (factIdx !== -1 && row[factIdx]) explicitTs = parseTimestampValue(String(row[factIdx]));
      if (!explicitTs && planIdx !== -1 && row[planIdx]) explicitTs = parseTimestampValue(String(row[planIdx]));
      if (explicitTs) explicitEpoch = _riyadhTsToEpochMs_(explicitTs);
      const baseTs = ts || explicitTs;
      if (!baseTs) continue;
      const epoch = _riyadhTsToEpochMs_(baseTs);
      if (!isFinite(epoch)) continue;
      let endEpoch = epoch;
      const dur = durIdx !== -1 ? parseFloat(row[durIdx]) : NaN;
      if (!isNaN(dur) && dur > 0 && dur <= 24 * 60) endEpoch = epoch + dur * 60000;
      events.push({
        epoch: epoch, endEpoch: endEpoch, key: _shiftRowKey_(r, ri),
        explicitEpoch: (explicitEpoch !== null && isFinite(explicitEpoch)) ? explicitEpoch : null,
        metric: r.metric
      });
    }
  }
  return events;
}

/**
 * يعيد { rowShiftDate: Map<rowKey,shiftDate>, diagnostics:[...], confidence, method, uncertain }.
 * لا يخترع حدودًا: عند عدم كفاية البيانات/وضوح الفصل يعيد خريطة فارغة (fallback يومي).
 */
function _inferShiftBuckets_(records) {
  const events = _shiftCollectEvents_(records).sort((a, b) => a.epoch - b.epoch);
  const diagnostics = [];
  const rowShiftDate = new Map();
  if (events.length < 2) {
    return { rowShiftDate: rowShiftDate, diagnostics: diagnostics, confidence: 'low', method: 'fallback-day', uncertain: true };
  }

  const hasExplicit = events.some(e => e.explicitEpoch !== null);

  const gaps = [];
  for (let i = 0; i < events.length - 1; i++) {
    const fromEnd = Math.max(events[i].epoch, events[i].endEpoch);
    gaps.push((events[i + 1].epoch - fromEnd) / 60000);
  }
  const positive = gaps.filter(g => g > 0);

  // (1) إشارة صريحة: boundaries عند بدايات الشفت الصريحة (أقوى إشارة).
  if (hasExplicit) {
    const anchors = [];
    events.forEach(e => { if (e.explicitEpoch !== null) anchors.push(e.explicitEpoch); });
    anchors.sort((a, b) => a - b);
    const uniq = [];
    anchors.forEach(a => { if (!uniq.length || (a - uniq[uniq.length - 1]) > 60000) uniq.push(a); });
    const groups = uniq.map(a => ({ anchor: a, items: [] }));
    events.forEach(e => {
      let gi = 0;
      for (let i = 0; i < uniq.length; i++) { if (uniq[i] <= e.epoch) gi = i; }
      groups[gi].items.push(e);
    });
    groups.forEach(g => {
      if (!g.items.length) return;
      const start = g.items[0].epoch;
      const end = g.items.reduce((mx, e) => Math.max(mx, e.endEpoch), g.items[0].epoch);
      const shiftDate = _epochMsToRiyadhDate_(g.anchor);
      g.items.forEach(e => rowShiftDate.set(e.key, shiftDate));
      diagnostics.push({
        shiftDate: shiftDate, detectedStart: _epochMsToRiyadhHHMM_(start),
        detectedEnd: _epochMsToRiyadhHHMM_(end), sessions: g.items.length,
        gapBefore: null, gapAfter: null, boundaryMethod: 'explicit', confidence: 'high'
      });
    });
    return { rowShiftDate: rowShiftDate, diagnostics: diagnostics, confidence: 'high', method: 'explicit', uncertain: false };
  }

  // (2) نشاط متصل بلا فجوات موجبة (المدد تغطي الفجوات) → شفت واحد (No invented boundary).
  if (positive.length === 0) {
    const start = events[0].epoch;
    const end = events.reduce((mx, e) => Math.max(mx, e.endEpoch), events[0].epoch);
    const shiftDate = _epochMsToRiyadhDate_(start);
    events.forEach(e => rowShiftDate.set(e.key, shiftDate));
    diagnostics.push({
      shiftDate: shiftDate, detectedStart: _epochMsToRiyadhHHMM_(start),
      detectedEnd: _epochMsToRiyadhHHMM_(end), sessions: events.length,
      gapBefore: null, gapAfter: null, boundaryMethod: 'continuous', confidence: 'medium'
    });
    return { rowShiftDate: rowShiftDate, diagnostics: diagnostics, confidence: 'medium', method: 'activity-continuous', uncertain: false };
  }

  let t = null, separated = false;
  if (positive.length >= 2) {
    const otsu = _otsuThreshold_(positive);
    t = otsu.t;
    if (t !== null) {
      const within = positive.filter(g => g < t);
      const between = positive.filter(g => g >= t);
      const maxWithin = within.length ? Math.max.apply(null, within) : 0;
      const minBetween = between.length ? Math.min.apply(null, between) : Infinity;
      separated = between.length > 0 && isFinite(minBetween) && (within.length === 0 || minBetween > maxWithin * 1.5);
    }
  } else if (positive.length === 1) {
    // فجوة موجبة واحدة مع وجود نشاط متصل (فجوات ≤ 0) = حدّ واضح.
    const zeroCount = gaps.filter(g => g <= 0).length;
    if (zeroCount >= 1) { t = positive[0]; separated = true; }
  }

  const confident = hasExplicit || (t !== null && separated);
  if (!confident) {
    return { rowShiftDate: rowShiftDate, diagnostics: diagnostics, confidence: 'low', method: 'fallback-day', uncertain: true };
  }

  const clusters = [];
  let current = [events[0]];
  for (let i = 1; i < events.length; i++) {
    if (gaps[i - 1] >= t) { clusters.push(current); current = [events[i]]; }
    else current.push(events[i]);
  }
  clusters.push(current);

  for (let ci = 0; ci < clusters.length; ci++) {
    const cl = clusters[ci];
    const start = cl[0].epoch;
    const end = cl.reduce((mx, e) => Math.max(mx, e.endEpoch), cl[0].epoch);
    const shiftDate = _epochMsToRiyadhDate_(start);
    const prevCl = ci > 0 ? clusters[ci - 1] : null;
    const nextCl = ci < clusters.length - 1 ? clusters[ci + 1] : null;
    const prevEnd = prevCl ? prevCl.reduce((mx, e) => Math.max(mx, e.endEpoch), prevCl[0].epoch) : null;
    const gapBefore = prevCl ? Math.round((cl[0].epoch - prevEnd) / 60000) : null;
    const gapAfter = nextCl ? Math.round((nextCl[0].epoch - end) / 60000) : null;
    const clHasExplicit = cl.some(e => e.explicitEpoch !== null);
    cl.forEach(e => rowShiftDate.set(e.key, shiftDate));
    diagnostics.push({
      shiftDate: shiftDate,
      detectedStart: _epochMsToRiyadhHHMM_(start),
      detectedEnd: _epochMsToRiyadhHHMM_(end),
      sessions: cl.length,
      gapBefore: gapBefore,
      gapAfter: gapAfter,
      boundaryMethod: clHasExplicit ? 'explicit' : 'activity-gap',
      confidence: 'high'
    });
  }

  return {
    rowShiftDate: rowShiftDate,
    diagnostics: diagnostics,
    confidence: hasExplicit ? 'high' : 'high',
    method: hasExplicit ? 'explicit' : 'activity-cluster',
    uncertain: false
  };
}


/**
 * تطبيع سجلات المقاييس ومعالجة الهيدرات متعددة المستويات
 */
function normalizeRecord(result, index, fileName) {
  if (!result || typeof result !== 'object') {
    throw new Error(`النتيجة ${index + 1}: تنسيق غير صالح للكائن.`);
  }

  const agent = String(result.agent || result.email || '').trim();
  const metric = String(result.metric || '').trim().toLowerCase();
  const rawHeader = Array.isArray(result.header) ? result.header : [];
  const rawRows = Array.isArray(result.rows) ? result.rows : [];

  if (!agent || !metric) {
    throw new Error(`النتيجة ${index + 1}: يلزم وجود agent و metric بتنسيق صحيح.`);
  }

  // معالجة الهيدرات المتعددة (DOM fallback vs Flat)
  const levels = rawHeader.some(Array.isArray)
    ? rawHeader.map(lvl => Array.isArray(lvl) ? lvl : [lvl])
    : [rawHeader];

  let width = levels.reduce((max, lvl) => Math.max(max, lvl.length), 0);
  const objectKeys = [];
  for (const row of rawRows) {
    if (Array.isArray(row)) {
      width = Math.max(width, row.length);
    } else if (row && typeof row === 'object') {
      for (const key of Object.keys(row)) {
        if (!objectKeys.includes(key)) objectKeys.push(key);
      }
    }
  }
  width = Math.max(width, objectKeys.length);

  const header = Array.from({ length: width }, (_, col) => {
    const names = levels.map(lvl => textCell(lvl[col])).filter(Boolean);
    return [...new Set(names)].join(' / ') || objectKeys[col] || `Column ${col + 1}`;
  });

  const rows = rawRows.map(row => Array.from({ length: width }, (_, col) => {
    if (Array.isArray(row)) return textCell(row[col]);
    if (row && typeof row === 'object') {
      const key = Object.prototype.hasOwnProperty.call(row, header[col]) ? header[col] : objectKeys[col];
      return textCell(row[key]);
    }
    return '';
  }));

  return {
    agent: agent,
    metric: metric,
    title: textCell(result.title || `${metric.toUpperCase()} - ${agent}`),
    capturedAt: textCell(result.capturedAt || ''),
    source: textCell(result.source || ''),
    scope: textCell(result.scope || result.note || ''),
    fileName: fileName || 'DATA',
    index: index || 0,
    header: header,
    rows: rows
  };
}

/**
 * توليد مفتاح فريد للصف لمنع التكرار (Deduplication)
 */
function rowKey(row, header) {
  if (!Array.isArray(row) || !Array.isArray(header)) return '';
  let ticketIdIdx = -1;
  let dateIdx = -1;
  let planShiftIdx = -1;

  for (let i = 0; i < header.length; i++) {
    const h = String(header[i]).toLowerCase().trim();
    if (h === 'ticket_id' || h === 'ticket id' || h === 'session_id' || h === 'session id') {
      ticketIdIdx = i;
    } else if (h === 'report_dt' || h === 'date') {
      dateIdx = i;
    } else if (h === 'plan_shift_start' || h === 'fact_shift_start') {
      planShiftIdx = i;
    }
  }

  if (ticketIdIdx !== -1 && row[ticketIdIdx] != null) {
    const idVal = String(row[ticketIdIdx]).trim();
    if (idVal) {
      if (dateIdx !== -1 && row[dateIdx] != null) {
        const dtVal = String(row[dateIdx]).trim();
        if (dtVal) return `dt_id::${dtVal}::${idVal}`;
      }
      return `id::${idVal}`;
    }
  }

  if (planShiftIdx !== -1 && row[planShiftIdx] != null && String(row[planShiftIdx]).trim()) {
    const shiftVal = String(row[planShiftIdx]).trim();
    const dateVal = dateIdx !== -1 && row[dateIdx] != null ? String(row[dateIdx]).trim() : '';
    return `shift::${shiftVal}::${dateVal}`;
  }

  return 'row::' + row.map(cell => textCell(cell).trim()).join('\u0000');
}

/**
 * محاذاة الأعمدة عند الدمج
 */
function alignRowColumns(sourceRow, sourceHeader, targetHeader) {
  if (!Array.isArray(sourceRow)) return [];
  if (sourceHeader.length === targetHeader.length && sourceHeader.every((h, i) => h === targetHeader[i])) {
    return sourceRow;
  }
  const usedIndices = new Set();
  const colMap = targetHeader.map((tCol, tIdx) => {
    if (sourceHeader[tIdx] === tCol && !usedIndices.has(tIdx)) {
      usedIndices.add(tIdx);
      return tIdx;
    }
    const matchIdx = sourceHeader.findIndex((sCol, sIdx) => sCol === tCol && !usedIndices.has(sIdx));
    if (matchIdx !== -1) {
      usedIndices.add(matchIdx);
      return matchIdx;
    }
    return -1;
  });

  return targetHeader.map((_, i) => {
    const src = colMap[i];
    return src !== -1 && src < sourceRow.length ? sourceRow[src] : '';
  });
}

/**
 * دمج السجلات الواردة مع السجلات الحالية مع منع التكرار
 */
function mergeRecords(existingRecords = [], incomingRecords = []) {
  const records = existingRecords.map(r => ({
    ...r,
    header: [...r.header],
    rows: r.rows.map(row => [...row])
  }));

  let totalAdded = 0;
  let totalSkipped = 0;
  const addedDetails = [];

  for (const incoming of incomingRecords) {
    if (!incoming || !incoming.agent || !incoming.metric) continue;

    const incomingAgent = String(incoming.agent).trim().toLowerCase();
    const incomingMetric = String(incoming.metric).trim().toLowerCase();
    const target = records.find(r =>
      String(r.agent).trim().toLowerCase() === incomingAgent &&
      String(r.metric).trim().toLowerCase() === incomingMetric
    );

    if (!target) {
      const newRecord = {
        ...incoming,
        header: [...incoming.header],
        rows: incoming.rows.map(row => [...row])
      };
      records.push(newRecord);
      totalAdded += newRecord.rows.length;
      addedDetails.push({
        agent: incoming.agent,
        metric: incoming.metric,
        added: newRecord.rows.length,
        skipped: 0,
        isNewRecord: true
      });
    } else {
      // Preserve new columns, including repeated labels, before aligning rows.
      const occurrences = new Map();
      const available = new Map();
      target.header.forEach(h => available.set(h, (available.get(h) || 0) + 1));
      incoming.header.forEach(h => {
        const count = (occurrences.get(h) || 0) + 1;
        occurrences.set(h, count);
        if (count > (available.get(h) || 0)) {
          target.header.push(h);
          available.set(h, count);
        }
      });
      target.rows = target.rows.map(row => Array.from({ length: target.header.length }, (_, i) => row[i] == null ? '' : row[i]));
      const existingKeys = new Set(target.rows.map(r => rowKey(r, target.header)));
      const existingRows = new Map(target.rows.map(r => [rowKey(r, target.header), r]));
      let addedCount = 0;
      let skippedCount = 0;

      for (const row of incoming.rows) {
        const alignedRow = alignRowColumns(row, incoming.header, target.header);
        const key = rowKey(alignedRow, target.header);
        if (existingKeys.has(key)) {
          const savedRow = existingRows.get(key);
          if (savedRow) alignedRow.forEach((cell, i) => {
            if ((savedRow[i] === '' || savedRow[i] == null) && cell !== '' && cell != null) savedRow[i] = cell;
          });
          skippedCount++;
        } else {
          existingKeys.add(key);
          target.rows.push(alignedRow);
          existingRows.set(key, alignedRow);
          addedCount++;
        }
      }

      totalAdded += addedCount;
      totalSkipped += skippedCount;
      addedDetails.push({
        agent: incoming.agent,
        metric: incoming.metric,
        added: addedCount,
        skipped: skippedCount,
        isNewRecord: false
      });
    }
  }

  return {
    records,
    totalAdded,
    totalSkipped,
    addedDetails
  };
}

/**
 * استخراج إحصائيات تجاوزات البريك بدقة تامة وبفصل تام عن التأخير
 */
function extractBreakMetrics(recordsList) {
  let breakBreachCount = 0;
  let breakExceedMinsSum = 0;
  let recordedShifts = 0;

  const breakRecs = recordsList.filter(r => r.metric === 'breakBreach' || r.metric === 'breakbreach' || r.metric === 'break');
  for (const rec of breakRecs) {
    const h = (rec.header || []).map(col => String(col).toLowerCase().trim());
    const breakCols = [];
    h.forEach((col, idx) => {
      if (col === 'break exceed' || col === 'break_exceed') {
        breakCols.push(idx);
      }
    });

    for (const row of rec.rows || []) {
      recordedShifts++;
      // "كم مرّة" = كل عمود Break Exceed متجاوز يُحتسب مرة واحدة.
      // عمودا الحالة (Met/Not Met) والدقائق لنفس البريك لا يُحتسبان مرّتين:
      // إذا وُجدت دقائق تجاوز نعتمد عليها، وإلا نعتمد على عمود الحالة.
      let numericBreaches = 0;
      let numericMins = 0;
      let statusBreaches = 0;
      for (const bIdx of breakCols) {
        const val = String(row[bIdx] ?? '').trim();
        const lower = val.toLowerCase();
        const parsed = parseFloat(val);
        if (!isNaN(parsed) && parsed > 0) {
          numericBreaches++;
          numericMins += parsed;
        } else if (lower === 'not met' || lower === 'breached' || lower.includes('breach')) {
          statusBreaches++;
        }
      }
      breakBreachCount += (numericBreaches > 0 ? numericBreaches : statusBreaches);
      breakExceedMinsSum += numericMins;
    }
  }

  return {
    breaches: breakBreachCount,
    exceedMins: Math.round(breakExceedMinsSum * 100) / 100,
    recordedShifts
  };
}

/**
 * استخراج إحصائيات دقائق التأخير بدقة تامة
 */
function extractLatenessMetrics(recordsList) {
  let latenessIncidentCount = 0;
  let latenessMinsSum = 0;
  let recordedShifts = 0;

  const latenessRecs = recordsList.filter(r => r.metric === 'lateness');
  const targetRecs = latenessRecs.length > 0
    ? latenessRecs
    : recordsList.filter(r => (r.header || []).some(c => {
        const norm = String(c).toLowerCase().trim();
        return norm === 'exceed mins' || norm === 'exceed_mins';
      }));

  const seenRows = new Set();
  for (const rec of targetRecs) {
    const h = (rec.header || []).map(col => String(col).toLowerCase().trim());
    let latenessMinsIdx = -1;
    let planStartIdx = -1;
    let factStartIdx = -1;

    h.forEach((col, idx) => {
      if (col === 'exceed mins' || col === 'exceed_mins') {
        latenessMinsIdx = idx;
      } else if (col === 'plan_shift_start') {
        planStartIdx = idx;
      } else if (col === 'fact_shift_start') {
        factStartIdx = idx;
      }
    });

    for (const row of rec.rows || []) {
      const rKey = (rec.agent || '') + '|' + (row.join('|'));
      if (seenRows.has(rKey)) continue;
      seenRows.add(rKey);
      recordedShifts++;

      let isLate = false;
      let rowLateMins = 0;
      if (latenessMinsIdx !== -1) {
        const m = parseFloat(row[latenessMinsIdx]);
        if (!isNaN(m) && m > 0) {
          rowLateMins = m;
          isLate = true;
        }
      } else if (planStartIdx !== -1 && factStartIdx !== -1) {
        const p = new Date(row[planStartIdx]).getTime();
        const f = new Date(row[factStartIdx]).getTime();
        if (f > p) {
          const diff = Math.round((f - p) / 60000);
          if (diff > 0) {
            rowLateMins = diff;
            isLate = true;
          }
        }
      }
      if (isLate) {
        latenessIncidentCount++;
        latenessMinsSum += rowLateMins;
      }
    }
  }

  return {
    incidents: latenessIncidentCount,
    totalMins: Math.round(latenessMinsSum * 100) / 100,
    recordedShifts
  };
}

/**
 * المحرك الإحصائي الشامل لحساب كافة المقاييس (طِبق الأصل من agent-dashboard-data.js)
 */

/**
 * تصفية السجلات حسب نطاق تاريخ (شامل الطرفين). startDay/endDay بصيغة YYYY-MM-DD أو فارغة.
 * تُستخدم لمخطط المقارنة حسب الوكيل مع الاحتفاظ بنفس محرك الحساب calculateAnalytics.
 */
function filterRecordsToDateRange(records, startDay, endDay) {
  if (!startDay && !endDay) return records;
  return records.map(rec => {
    const header = rec.header || [];
    const rows = (rec.rows || []).filter(row => {
      const d = extractRowDate(row, header);
      if (!d) return false;
      if (startDay && d < startDay) return false;
      if (endDay && d > endDay) return false;
      return true;
    });
    return Object.assign({}, rec, { rows: rows });
  }).filter(rec => (rec.rows || []).length > 0);
}

/**
 * يربط قيمة المقياس المطلوب من إحصائيات الوكيل المحسوبة مسبقًا (نفس منطق النظام).
 * الوحدات: csat=%, agbt/abst/lateness=دقائق، idle=ساعات، breakBreach=دقائق التجاوز (الأساسي).
 */
function getAgentMetricValue(stat, metric) {
  if (!stat) return null;
  switch (metric) {
    case 'csat':
      return (stat.csatPct === null || stat.csatPct === undefined) ? null : stat.csatPct;
    case 'agbt':
      return (stat.agbtAvg === null || stat.agbtAvg === undefined) ? null : stat.agbtAvg;
    case 'abst':
      return (stat.abstAvgMins === null || stat.abstAvgMins === undefined) ? null : stat.abstAvgMins;
    case 'idle':
      return (stat.idleHours === null || stat.idleHours === undefined) ? null : stat.idleHours;
    case 'lateness':
      return stat.latenessMins || 0;
    case 'breakBreach':
      // الأساسي = دقائق تجاوز البريك (وليس عدد المرات)
      return (stat.breakExceedMins === null || stat.breakExceedMins === undefined) ? null : stat.breakExceedMins;
    default:
      return null;
  }
}

function calculateAnalytics(records, agentFilter = null, shiftCutoffHour = 0, shiftWindow = null, bucketDateResolver = null) {
  if (!Array.isArray(records) || !records.length) {
    return {
      totalRecords: 0,
      totalRows: 0,
      totalSessions: 0,
      totalLongSessions: 0,
      activeDays: 0,
      avgDailySessions: 0,
      uniqueAgents: [],
      metricCounts: {},
      csat: { total: 0, good: 0, bad: 0, pct: null, byCountry: { KSA: 0, UAE: 0, OTHER: 0 }, byChannel: {} },
      agbt: { avg: null, tickets: 0, basketHours: 0 },
      abst: { avg: null },
      breakBreach: { breaches: 0, met: 0, exceedMins: 0, recordedShifts: 0 },
      lateness: { incidents: 0, totalMins: 0, recordedShifts: 0 },
      idle: { avgHours: null, totalHours: 0 },
      agentStats: {},
      timeline: []
    };
  }

  const list = agentFilter ? records.filter(r => r.agent === agentFilter) : records;
  const totalRecords = list.length;
  const totalRows = list.reduce((sum, r) => sum + (Array.isArray(r.rows) ? r.rows.length : 0), 0);
  const uniqueAgents = [...new Set(records.map(r => r.agent))].sort();

  const metricCounts = {};
  for (const r of list) {
    metricCounts[r.metric] = (metricCounts[r.metric] || 0) + (r.rows ? r.rows.length : 0);
  }

  // 1. حساب CSAT
  let csatTotal = 0, csatGood = 0, csatBad = 0;
  const csatByCountry = { KSA: 0, UAE: 0, OTHER: 0 };
  const csatByChannel = {};
  const csatRecords = list.filter(r => r.metric === 'csat');

  for (const rec of csatRecords) {
    const h = (rec.header || []).map(col => String(col).toLowerCase().trim());
    const csatColIdx = h.findIndex(col => col.includes('csat_adjusted') || col === 'csat' || col.includes('score'));
    const countryColIdx = h.findIndex(col => col.includes('country'));
    const channelColIdx = h.findIndex(col => col.includes('channel'));

    for (const row of rec.rows || []) {
      csatTotal++;
      const val = csatColIdx !== -1 ? String(row[csatColIdx] || '').toLowerCase().trim() : '';
      if (val === 'good' || val === '5' || val === '4' || val === 'positive' || val.includes('ممتاز') || val.includes('جيد')) {
        csatGood++;
      } else if (val === 'bad' || val === '1' || val === '2' || val === 'negative' || val.includes('سيء')) {
        csatBad++;
      }

      if (countryColIdx !== -1) {
        const cVal = String(row[countryColIdx] || '').toUpperCase().trim();
        if (cVal === 'KSA') csatByCountry.KSA++;
        else if (cVal === 'UAE') csatByCountry.UAE++;
        else if (cVal) csatByCountry.OTHER++;
      }

      if (channelColIdx !== -1) {
        const chVal = String(row[channelColIdx] || '').toLowerCase().trim();
        if (chVal) csatByChannel[chVal] = (csatByChannel[chVal] || 0) + 1;
      }
    }
  }
  const csatEvaluated = csatGood + csatBad;
  const csatPct = csatEvaluated > 0 ? Math.round((csatGood / csatEvaluated) * 100 * 10) / 10 : (csatTotal > 0 && csatGood > 0 ? 100 : null);

  // 2. حساب AGBT
  let agbtSum = 0, agbtCount = 0, agbtTickets = 0, agbtBasketHours = 0;
  const agbtRecords = list.filter(r => r.metric === 'agbt');

  for (const rec of agbtRecords) {
    const h = (rec.header || []).map(col => String(col).toLowerCase().trim());
    const agbtColIdx = findColIndex(h, 'sum_basket_time_for_ticket_per_hour_min_ONLINE_WOMT', 'sum_basket_time_for_ticket_per_hour_min', 'basket_time', 'agbt', 'time');
    const ticketsColIdx = findColIndex(h, 'tickets', 'ticket', 'sessions count', 'sessions');
    const basketColIdx = findColIndex(h, 'basket_time_h', 'basket_time', 'basket_session_time_min');

    for (const row of rec.rows || []) {
      if (agbtColIdx !== -1) {
        const val = parseFloat(row[agbtColIdx]);
        if (!isNaN(val)) {
          agbtSum += val;
          agbtCount++;
        }
      }
      if (ticketsColIdx !== -1) {
        const t = parseFloat(row[ticketsColIdx]);
        if (!isNaN(t)) agbtTickets += t;
      }
      if (basketColIdx !== -1) {
        const b = parseFloat(row[basketColIdx]);
        if (!isNaN(b)) agbtBasketHours += b;
      }
    }
  }
  const agbtAvg = agbtCount > 0 ? Math.round((agbtSum / agbtCount) * 100) / 100 : null;

  // 3. حساب تجاوزات البريك ودقائق التأخير
  const overallBreak = extractBreakMetrics(list);
  const overallLateness = extractLatenessMetrics(list);

  // 4. حساب وقت الخمول (Idle Time)
  let idleHoursSum = 0, idleCount = 0;
  const idleRecords = list.filter(r => r.metric === 'idle');

  for (const rec of idleRecords) {
    const h = (rec.header || []).map(col => String(col).toLowerCase().trim());
    // مطابق لمنطق agent-dashboard-data.js: أول عمود يحتوي idle أو not_working
    const idleColIdx = h.findIndex(col => col.indexOf('idle') !== -1 || col.indexOf('not_working') !== -1);

    for (const row of rec.rows || []) {
      if (idleColIdx !== -1) {
        const val = parseFloat(row[idleColIdx]);
        if (!isNaN(val)) {
          idleHoursSum += val;
          idleCount++;
        }
      }
    }
  }
  const idleAvg = idleCount > 0 ? Math.round((idleHoursSum / idleCount) * 100) / 100 : null;

  // 5. إحصائيات كل وكيل بدقة متناهية (Per-Agent Stats)
  const agentStats = {};
  const agentsToAnalyze = agentFilter ? [agentFilter] : uniqueAgents;

  for (const ag of agentsToAnalyze) {
    const agRecs = records.filter(r => r.agent === ag);
    const agRows = agRecs.reduce((sum, r) => sum + (r.rows ? r.rows.length : 0), 0);

    const hasCsat = agRecs.some(r => r.metric === 'csat');
    const hasAgbt = agRecs.some(r => r.metric === 'agbt');
    const hasAbst = agRecs.some(r => r.metric === 'abst');
    const hasBreak = agRecs.some(r => r.metric === 'breakBreach');
    const hasLateness = agRecs.some(r => r.metric === 'lateness');
    const hasIdle = agRecs.some(r => r.metric === 'idle');

    // CSAT
    let agCsatGood = 0, agCsatTotal = 0, agCsatBad = 0;
    for (const r of agRecs.filter(r => r.metric === 'csat')) {
      const h = (r.header || []).map(c => String(c).toLowerCase().trim());
      const cIdx = findColIndex(h, 'csat_adjusted', 'csat', 'score', 'rating');
      for (const row of r.rows || []) {
        agCsatTotal++;
        const v = cIdx !== -1 ? String(row[cIdx] || '').toLowerCase().trim() : '';
        if (v === 'good' || v === '5' || v === '4' || v === 'positive' || v.includes('ممتاز') || v.includes('جيد')) agCsatGood++;
        else if (v === 'bad' || v === '1' || v === '2' || v === 'negative' || v.includes('سيء')) agCsatBad++;
      }
    }

    // AGBT
    let agAgbtSum = 0, agAgbtCount = 0, agAgbtSessions = 0;
    for (const r of agRecs.filter(r => r.metric === 'agbt')) {
      const h = (r.header || []).map(c => String(c).toLowerCase().trim());
      const aIdx = findColIndex(h, 'sum_basket_time_for_ticket_per_hour_min_ONLINE_WOMT', 'sum_basket_time_for_ticket_per_hour_min', 'basket_time', 'agbt', 'time');
      const sessionsIdx = h.findIndex(c => c === 'sessions count' || c.includes('sessions count') || c === 'sessions');
      const ticketsIdx = h.findIndex(c => c === 'tickets' || c.includes('tickets'));
      for (const row of r.rows || []) {
        let sCount = 1;
        if (sessionsIdx !== -1) { const s = parseInt(row[sessionsIdx], 10); if (!isNaN(s) && s > 0) sCount = s; }
        else if (ticketsIdx !== -1) { const t = parseInt(row[ticketsIdx], 10); if (!isNaN(t) && t > 0) sCount = t; }
        agAgbtSessions += sCount;
        if (aIdx !== -1) {
          const val = parseFloat(row[aIdx]);
          if (!isNaN(val)) {
            agAgbtSum += val;
            agAgbtCount++;
          }
        }
      }
    }

    // ABST
    let agAbstSum = 0, agAbstCount = 0, agAbstSessions = 0;
    for (const r of agRecs.filter(r => r.metric === 'abst')) {
      const h = (r.header || []).map(c => String(c).toLowerCase().trim());
      const sIdx = findColIndex(h, 'basket_session_time_min', 'session_time', 'basket_session_time', 'abst', 'time');
      for (const row of r.rows || []) {
        agAbstSessions++;
        if (sIdx !== -1) {
          const val = parseFloat(row[sIdx]);
          if (!isNaN(val)) {
            agAbstSum += val;
            agAbstCount++;
          }
        }
      }
    }

    const agBreak = extractBreakMetrics(agRecs);
    const agLateness = extractLatenessMetrics(agRecs);

    // Idle
    let agIdleSum = 0, agIdleCount = 0;
    for (const r of agRecs.filter(r => r.metric === 'idle')) {
      const h = (r.header || []).map(c => String(c).toLowerCase().trim());
      const iIdx = h.findIndex(c => c.indexOf('idle') !== -1 || c.indexOf('not_working') !== -1);
      for (const row of r.rows || []) {
        if (iIdx !== -1) {
          const v = parseFloat(row[iIdx]);
          if (!isNaN(v)) {
            agIdleSum += v;
            agIdleCount++;
          }
        }
      }
    }

    const agEvaluated = agCsatGood + agCsatBad;
    const agAbstAvgMins = agAbstCount > 0 ? (agAbstSum / agAbstCount) : 0;
    const agAbstFormatted = agAbstAvgMins > 0 ? `${Math.floor(agAbstAvgMins)}:${String(Math.round((agAbstAvgMins % 1) * 60)).padStart(2, '0')}` : null;
    const agAgbtAvgMins = agAgbtCount > 0 ? (agAgbtSum / agAgbtCount) : 0;
    const agAgbtFormatted = agAgbtAvgMins > 0 ? `${Math.floor(agAgbtAvgMins)}:${String(Math.round((agAgbtAvgMins % 1) * 60)).padStart(2, '0')}` : null;
    // إجمالي سيشنات الوكيل — نفس دلالات الخط الزمني (abstSessions → agbtSessions → csatTotal)
    const agSessions = agAbstSessions > 0 ? agAbstSessions : (agAgbtSessions > 0 ? agAgbtSessions : agCsatTotal);

    agentStats[ag] = {
      agent: ag,
      recordsCount: agRecs.length,
      rowsCount: agRows,
      sessions: agSessions,
      hasCsat,
      hasAgbt,
      hasAbst,
      hasBreak,
      hasLateness,
      hasIdle,
      csatPct: agEvaluated > 0 ? Math.round((agCsatGood / agEvaluated) * 100 * 10) / 10 : (agCsatTotal > 0 && agCsatGood > 0 ? 100 : null),
      csatTotal: agCsatTotal,
      csatGood: agCsatGood,
      csatBad: agCsatBad,
      agbtAvg: agAgbtCount > 0 ? Math.round((agAgbtSum / agAgbtCount) * 100) / 100 : null,
      agbtDisplay: agAgbtFormatted,
      abstAvg: agAbstFormatted,
      abstAvgMins: agAbstCount > 0 ? Math.round((agAbstSum / agAbstCount) * 100) / 100 : null,
      breakBreaches: agBreak.breaches,
      breakExceedMins: hasBreak ? agBreak.exceedMins : null,
      latenessIncidents: agLateness.incidents,
      latenessMins: agLateness.totalMins,
      idleHours: agIdleCount > 0 ? Math.round(agIdleSum * 100) / 100 : null
    };
  }

  // 6. استخراج الخط الزمني اليومي الفعلي (Daily Timeline Trend)
  const dailyMap = {};
  function getDayEntry(day) {
    if (!dailyMap[day]) {
      dailyMap[day] = {
        day,
        displayDay: day.slice(5),
        abstSessions: 0,
        abstTotalMins: 0,
        abstCount: 0,
        longSessions: 0,
        agbtSessions: 0,
        agbtTotalMins: 0,
        agbtCount: 0,
        csatGood: 0,
        csatBad: 0,
        csatTotal: 0,
        breakExceedMins: 0,
        breakBreaches: 0,
        latenessMins: 0,
        latenessIncidents: 0
      };
    }
    return dailyMap[day];
  }

  for (const r of list) {
    const h = (r.header || []).map(c => String(c).toLowerCase().trim());
    const metric = r.metric;

    const abstMinsIdx = h.findIndex(c => c === 'basket_session_time_min' || c.includes('basket_session_time') || c === 'abst');
    const over20Idx = h.findIndex(c => c === '> 20' || c.includes('> 20') || c.includes('over_20'));
    const agbtSessionsIdx = h.findIndex(c => c === 'sessions count' || c.includes('sessions count') || c === 'sessions');
    const agbtTicketsIdx = h.findIndex(c => c === 'tickets' || c.includes('tickets'));
    const agbtMinsIdx = h.findIndex(c => c.includes('sum_basket_time') || c === 'agbt' || c.includes('basket_time'));
    const csatScoreIdx = h.findIndex(c => c === 'csat_adjusted' || c.includes('csat_adjusted') || c === 'csat' || c.includes('score'));

    const breakMetIdx = findColIndex(h, 'break exceed', 'break_exceed', 'status');
    const breakExceedIdx = findColIndex(h, 'break exceed time', 'exceed_time', 'exceed_mins', 'exceed');
    const lateIdx = findColIndex(h, 'exceed mins', 'exceed_mins', 'lateness', 'late_mins', 'delay_mins', 'delay');
    const idleIdx = h.findIndex(c => c.indexOf('idle') !== -1 || c.indexOf('not_working') !== -1);

    const rows = r.rows || [];
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      // وضع الشفت المُستنتَج: bucketDateResolver يحدّد تاريخ الشفت (بدون لمس أي معادلة مقياس).
      // وضع الشفت الثابت (legacy) و وضع اليوم: نفس المنطق السابق.
      let day = null;
      if (bucketDateResolver) {
        day = bucketDateResolver(r, row, ri);
      } else {
        day = shiftWindow
          ? shiftDateFromRiyadhTs(shiftTimestampForRow(row, r.header), shiftWindow)
          : (function () {
              const ts = extractRowTimestamp(row, r.header);
              return ts ? ((shiftCutoffHour > 0) ? shiftDayFromTimestamp(ts, shiftCutoffHour) : ts.slice(0, 10)) : null;
            })();
      }
      if (!day) continue;
      const entry = getDayEntry(day);

      if (metric === 'abst') {
        entry.abstSessions++;
        let isLong = false;
        if (abstMinsIdx !== -1) {
          const m = parseFloat(row[abstMinsIdx]);
          if (!isNaN(m)) {
            entry.abstTotalMins += m;
            entry.abstCount++;
            if (m >= 20) isLong = true;
          }
        }
        if (over20Idx !== -1) {
          const v = String(row[over20Idx] || '').toLowerCase().trim();
          if (v === 'high' || v === 'yes') isLong = true;
        }
        if (isLong) entry.longSessions++;
      } else if (metric === 'agbt') {
        let sCount = 1;
        if (agbtSessionsIdx !== -1) {
          const s = parseInt(row[agbtSessionsIdx], 10);
          if (!isNaN(s) && s > 0) sCount = s;
        } else if (agbtTicketsIdx !== -1) {
          const t = parseInt(row[agbtTicketsIdx], 10);
          if (!isNaN(t) && t > 0) sCount = t;
        }
        entry.agbtSessions += sCount;
        if (agbtMinsIdx !== -1) {
          const m = parseFloat(row[agbtMinsIdx]);
          if (!isNaN(m)) {
            entry.agbtTotalMins += m;
            entry.agbtCount++;
          }
        }
      } else if (metric === 'csat') {
        entry.csatTotal++;
        if (csatScoreIdx !== -1) {
          const score = String(row[csatScoreIdx] || '').toLowerCase().trim();
          if (score === 'good' || score === '5' || score === '4' || score === 'positive') {
            entry.csatGood++;
          } else if (score === 'bad' || score === '1' || score === '2' || score === 'negative') {
            entry.csatBad++;
          }
        }
      } else if (metric === 'breakBreach' || metric === 'break' || metric === 'breakbreach') {
        let breached = false;
        if (breakMetIdx !== -1) {
          const v = String(row[breakMetIdx] || '').toLowerCase().trim();
          if (v === 'not met' || v === 'breached' || v.includes('breach')) breached = true;
        }
        let exceedM = 0;
        if (breakExceedIdx !== -1) {
          const v = parseFloat(row[breakExceedIdx]);
          if (!isNaN(v) && v > 0) { exceedM = v; breached = true; }
        }
        if (breached) entry.breakBreaches++;
        entry.breakExceedMins += exceedM;
      } else if (metric === 'lateness' || metric === 'late') {
        if (lateIdx !== -1) {
          const v = parseFloat(row[lateIdx]);
          if (!isNaN(v) && v > 0) {
            entry.latenessIncidents++;
            entry.latenessMins += v;
          }
        }
      } else if (metric === 'idle') {
        if (idleIdx !== -1) {
          const v = parseFloat(row[idleIdx]);
          if (!isNaN(v) && v > 0) {
            entry.idleHours += v;
            entry.idleCount = (entry.idleCount || 0) + 1;
          }
        }
      }
    }
  }

  const timeline = Object.keys(dailyMap).sort().map(d => {
    const entry = dailyMap[d];
    let sessions = 0;
    if (entry.abstSessions > 0) sessions = entry.abstSessions;
    else if (entry.agbtSessions > 0) sessions = entry.agbtSessions;
    else if (entry.csatTotal > 0) sessions = entry.csatTotal;

    let abstMins = 0;
    if (entry.abstCount > 0) {
      abstMins = Math.round((entry.abstTotalMins / entry.abstCount) * 100) / 100;
    } else if (entry.agbtCount > 0) {
      abstMins = Math.round((entry.agbtTotalMins / entry.agbtCount) * 100) / 100;
    }

    const csatEvaluatedDaily = entry.csatGood + entry.csatBad;
    const csatPctDaily = csatEvaluatedDaily > 0 ? Math.round((entry.csatGood / csatEvaluatedDaily) * 100 * 10) / 10 : null;

    return {
      day: d,
      displayDay: entry.displayDay,
      sessions,
      abstMins,
      abstSecs: Math.round(abstMins * 60),
      agbtMins: entry.agbtCount > 0 ? Math.round((entry.agbtTotalMins / entry.agbtCount) * 100) / 100 : 0,
      agbtSecs: entry.agbtCount > 0 ? Math.round((entry.agbtTotalMins / entry.agbtCount) * 60) : 0,
      longSessions: entry.longSessions,
      long: entry.longSessions,
      csatPct: csatPctDaily,
      csat: csatPctDaily !== null ? Math.round(csatPctDaily) : 0,
      csatGood: entry.csatGood,
      csatBad: entry.csatBad,
      csatTotal: entry.csatTotal,
      breakBreaches: entry.breakBreaches || 0,
      breakExceedMins: Math.round((entry.breakExceedMins || 0) * 10) / 10,
      latenessIncidents: entry.latenessIncidents || 0,
      latenessMins: Math.round((entry.latenessMins || 0) * 10) / 10,
      idleHours: (entry.idleCount > 0) ? Math.round(entry.idleHours * 100) / 100 : 0,
      count: sessions || 1
    };
  });

  const totalTimelineSessions = timeline.reduce((s, t) => s + t.sessions, 0);
  const totalSessions = Math.max(totalTimelineSessions, agbtTickets || 0);
  const totalLongSessions = timeline.reduce((s, t) => s + t.longSessions, 0);
  const activeDays = timeline.filter(t => t.sessions > 0 || t.abstMins > 0 || t.csatTotal > 0).length;
  const avgDailySessions = activeDays > 0 ? Math.round((totalSessions / activeDays) * 10) / 10 : 0;

  return {
    totalRecords,
    totalRows,
    totalSessions,
    totalLongSessions,
    activeDays,
    avgDailySessions,
    uniqueAgents,
    metricCounts,
    csat: { total: csatTotal, good: csatGood, bad: csatBad, pct: csatPct, byCountry: csatByCountry, byChannel: csatByChannel },
    agbt: { avg: agbtAvg, tickets: agbtTickets, basketHours: Math.round(agbtBasketHours * 100) / 100 },
    breakBreach: {
      breaches: overallBreak.breaches,
      met: 0,
      exceedMins: overallBreak.exceedMins,
      recordedShifts: overallBreak.recordedShifts
    },
    lateness: {
      incidents: overallLateness.incidents,
      totalMins: overallLateness.totalMins,
      recordedShifts: overallLateness.recordedShifts
    },
    idle: { avgHours: idleAvg, totalHours: Math.round(idleHoursSum * 100) / 100 },
    agentStats,
    timeline
  };
}

/**
 * ============================================================================
 * 2. دوال تخديم الواجهة (Web App Endpoints)
 * ============================================================================
 */
function doGet(e) {
  const page = (e && e.parameter && (e.parameter.page || e.parameter.p || '')) || '';
  const openAdmin = (page.toLowerCase() === 'admin');
  const currentUserEmail = getCurrentUserEmail();
  const userIsAdmin = isCurrentUserAdmin();
  const userIsAllowed = isCurrentUserAllowed();

  // تقييد الموقع كاملاً: فقط المدراء + قائمة المستخدمين المصرح لهم
  if (!userIsAllowed) {
    return HtmlService.createHtmlOutput(getAccessDeniedHtml())
      .setTitle('Access Denied')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // صفحة الإدارة مدمجة داخل اللوحة كنافذة منبثقة (تجنب صفحة فارغة)
  if (openAdmin && !userIsAdmin) {
    return HtmlService.createHtmlOutput(getAccessDeniedHtml())
      .setTitle('Access Denied')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  const template = HtmlService.createTemplateFromFile('Index');
  template.initialData = JSON.stringify({
    title: "Agent Dashboard",
    timestamp: new Date().toISOString(),
    openAdmin: openAdmin,
    isAdmin: userIsAdmin,
    isPrimaryAdmin: isCurrentUserPrimaryAdmin(),
    currentUserEmail: currentUserEmail
  });

  return template.evaluate()
    .setTitle(openAdmin ? 'Admin Portal — Import & Save Data' : 'Agent Dashboard — Results & Performance')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function getAccessDeniedHtml() {
  return '<!DOCTYPE html><html dir="ltr" lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Access Denied</title></head>' +
    '<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#0a0f1d;color:#f1f5f9;font-family:system-ui,sans-serif;text-align:center;">' +
    '<div><div style="font-size:64px;">🔒</div>' +
    '<h1 style="margin:16px 0 8px;font-size:22px;">Access Denied</h1>' +
    '<p style="color:#94a3b8;font-size:15px;margin:0;">This dashboard is available only to authorized users.</p>' +
    '<p style="color:#64748b;font-size:13px;">If you believe this is a mistake, contact your admin.</p></div></body></html>';
}

/**
 * ============================================================================
 * 3. إدارة المجلدات والتخزين بالتجزئة الدقيقة في Google Drive
 * ============================================================================
 */

function getOrCreateDataFolder() {
  return memoDashboardRead_('folder', () => getOrCreateDataFolderImpl_());
}

function getOrCreateDataFolderImpl_() {
  const folderName = CONFIG.DRIVE_FOLDER_NAME || "Agent_Performance_Hub_Data";
  const folders = DriveApp.getFoldersByName(folderName);
  if (folders.hasNext()) {
    return folders.next();
  }
  return DriveApp.createFolder(folderName);
}

function getOrCreateMetaFolder(parentFolder) {
  const p = parentFolder || getOrCreateDataFolder();
  const name = CONFIG.META_FOLDER_NAME || "meta";
  const folders = p.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return p.createFolder(name);
}

function getOrCreateMonthFolder(parentFolder, monthStr) {
  const p = parentFolder || getOrCreateDataFolder();
  const m = String(monthStr || '').trim();
  const safeName = /^\d{4}-\d{2}$/.test(m) ? m : Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM');
  const folders = p.getFoldersByName(safeName);
  if (folders.hasNext()) return folders.next();
  return p.createFolder(safeName);
}

function getMonthFolder(parentFolder, monthStr, createIfMissing) {
  const p = parentFolder || getOrCreateDataFolder();
  const m = String(monthStr || '').trim();
  const safeName = /^\d{4}-\d{2}$/.test(m) ? m : Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM');
  const folders = p.getFoldersByName(safeName);
  if (folders.hasNext()) return folders.next();
  return createIfMissing ? p.createFolder(safeName) : null;
}

function getOrCreateMonthDrillsFolder(monthFolder) {
  const name = CONFIG.DRILLS_FOLDER_NAME || "drills";
  const folders = monthFolder.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return monthFolder.createFolder(name);
}

function getOrCreateDrillsFolder() {
  const parentFolder = getOrCreateDataFolder();
  const subName = CONFIG.DRILLS_FOLDER_NAME || "drills";
  const subFolders = parentFolder.getFoldersByName(subName);
  if (subFolders.hasNext()) {
    return subFolders.next();
  }
  return parentFolder.createFolder(subName);
}

function getAgentFileSlug(email) {
  return 'agent_' + String(email || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '_');
}

function getAgentMetricFileSlug(email, metric) {
  const safeEmail = String(email || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '_');
  const safeMetric = String(metric || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '_');
  return `agent_${safeEmail}_${safeMetric}`;
}

// التحقق من صيغة الشهر المعتمدة في النظام: YYYY-MM (شهر 01-12)
function isValidMonthFormat(monthStr) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(monthStr || '').trim());
}

// فهرس الأشهر المتاحة في النظام (meta/months.json)
function getMonthsIndex() {
  try {
    const cache = CacheService.getScriptCache();
    const cachedRaw = cache.get("MONTHS_INDEX");
    if (cachedRaw) {
      const parsed = JSON.parse(cachedRaw);
      if (parsed && Array.isArray(parsed.availableMonths) && parsed.availableMonths.length > 0) {
        return parsed;
      }
    }
  } catch (e) {}

  const parentFolder = getOrCreateDataFolder();
  const metaFolder = getOrCreateMetaFolder(parentFolder);
  const files = metaFolder.getFilesByName(CONFIG.MONTHS_INDEX_FILE || "months.json");

  if (files.hasNext()) {
    try {
      const content = files.next().getBlob().getDataAsString();
      if (content && content.trim()) {
        const data = JSON.parse(content);
        if (data && Array.isArray(data.availableMonths)) {
          try { CacheService.getScriptCache().put("MONTHS_INDEX", JSON.stringify(data), 21600); } catch (e) {}
          return data;
        }
      }
    } catch (e) {}
  }

  // إذا لم يكن الملف منشأ بعد: فحص المجلدات الشهرية YYYY-MM
  const availableMonths = [];
  const folders = parentFolder.getFolders();
  while (folders.hasNext()) {
    const f = folders.next();
    const name = f.getName();
    if (/^\d{4}-\d{2}$/.test(name)) {
      availableMonths.push(name);
    }
  }
  availableMonths.sort().reverse();

  const nowMonth = Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM');
  const currentMonth = availableMonths.length > 0 ? availableMonths[0] : nowMonth;
  if (availableMonths.length === 0) availableMonths.push(nowMonth);

  const indexObj = { currentMonth: currentMonth, availableMonths: availableMonths };
  try {
    const jsonStr = JSON.stringify(indexObj);
    const existing = metaFolder.getFilesByName(CONFIG.MONTHS_INDEX_FILE || "months.json");
    if (existing.hasNext()) existing.next().setContent(jsonStr);
    else metaFolder.createFile(CONFIG.MONTHS_INDEX_FILE || "months.json", jsonStr, MimeType.PLAIN_TEXT);
    CacheService.getScriptCache().put("MONTHS_INDEX", jsonStr, 21600);
  } catch (e) {}

  return indexObj;
}

function updateMonthsIndex_(newMonthStr) {
  if (!newMonthStr || !/^\d{4}-\d{2}$/.test(newMonthStr)) return;
  const parentFolder = getOrCreateDataFolder();
  const metaFolder = getOrCreateMetaFolder(parentFolder);
  const curIdx = getMonthsIndex();

  const set = new Set(curIdx.availableMonths || []);
  set.add(newMonthStr);
  const sorted = Array.from(set).sort().reverse();
  const updated = {
    currentMonth: sorted[0] || newMonthStr,
    availableMonths: sorted
  };

  try {
    const jsonStr = JSON.stringify(updated);
    const existing = metaFolder.getFilesByName(CONFIG.MONTHS_INDEX_FILE || "months.json");
    if (existing.hasNext()) existing.next().setContent(jsonStr);
    else metaFolder.createFile(CONFIG.MONTHS_INDEX_FILE || "months.json", jsonStr, MimeType.PLAIN_TEXT);
    CacheService.getScriptCache().put("MONTHS_INDEX", jsonStr, 21600);
  } catch (e) {}
}

// الذاكرة المؤقتة السريعة (CacheService)
function getCachedOverview(month) {
  if (!requireAllowed()) return null;
  try {
    const key = "SUMMARY_OVERVIEW_" + String(month || 'DEFAULT').replace(/[^a-zA-Z0-9_-]/g, '_');
    const cached = CacheService.getScriptCache().get(key);
    if (cached) return JSON.parse(cached);
  } catch (e) {
    console.warn("Cache read warning:", e);
  }
  return null;
}

function setCachedOverview_(overviewObj, month) {
  try {
    const key = "SUMMARY_OVERVIEW_" + String(month || 'DEFAULT').replace(/[^a-zA-Z0-9_-]/g, '_');
    const jsonStr = JSON.stringify(overviewObj);
    if (jsonStr.length < 95000) {
      CacheService.getScriptCache().put(key, jsonStr, 21600); // 6 ساعات
    }
  } catch (e) {
    console.warn("Cache write warning:", e);
  }
}

function clearCachedOverview_(month) {
  try {
    const cache = CacheService.getScriptCache();
    if (month) {
      cache.remove("SUMMARY_OVERVIEW_" + String(month).replace(/[^a-zA-Z0-9_-]/g, '_'));
      return;
    }
    cache.remove("SUMMARY_OVERVIEW_DATA");
    cache.remove("SUMMARY_OVERVIEW_DEFAULT");
    cache.remove("MONTHS_INDEX");
    // إبطال مفاتيح ملخص كل الأشهر المتاحة (ضروري بعد ban/delete/migration حتى لا يبقى ملخص قديم حتى 6 ساعات)
    try {
      const idx = getMonthsIndex();
      const months = [].concat(idx.availableMonths || [], idx.currentMonth ? [idx.currentMonth] : []);
      months.forEach(m => {
        if (m) cache.remove("SUMMARY_OVERVIEW_" + String(m).replace(/[^a-zA-Z0-9_-]/g, '_'));
      });
    } catch (e) { /* تجاهل */ }
  } catch (e) {}
}

function getCachedMetricRecord(fileName) {
  if (!requireAllowed()) return null;
  try {
    const raw = CacheService.getScriptCache().get('MRC_' + fileName);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.warn('Metric record cache read warning:', e);
  }
  return null;
}

function setCachedMetricRecord_(fileName, record) {
  try {
    const s = JSON.stringify(record);
    if (s.length < 90000) {
      CacheService.getScriptCache().put('MRC_' + fileName, s, 21600); // 6 ساعات
    }
  } catch (e) {
    console.warn('Metric record cache write warning:', e);
  }
}

/**
 * ============================================================================
 * 4. حفظ وتجزئة كل مقياس لكل موظف داخل مجلد الشهر مع نموذج العرض الجاهز
 *    (Time-Partitioned Data Marts & Pre-Aggregated Serving Model)
 * ============================================================================
 */
function savePayloadToMicroPartitionedDrive_(payload, rebuildSummary) {
  rebuildSummary = rebuildSummary !== false;

  const dateStr = payload.date || Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM-dd');
  const defaultMonth = dateStr.length >= 7 ? dateStr.substring(0, 7) : Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM');
  const nowStr = Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM-dd HH:mm:ss');
  const parentFolder = getOrCreateDataFolder();

  // قفل شامل لعملية الكتابة: يمنع تضارب عمليات الحفظ المتزامنة
  const writeLock = LockService.getScriptLock();
  let writeLockAcquired = false;
  try {
    writeLock.waitLock(40000);
    writeLockAcquired = true;
  } catch (lockErr) {
    // فشل الحصول على القفل => نرفض بدل الكتابة بدون قفل (fail-safe ضد Lost Update)
    throw makeAppError_(ERR.LOCK_TIMEOUT, 'تعذر الحصول على القفل. أعد المحاولة.');
  }

  // 1. استخراج وتطبيع السجلات الواردة بدقة
  const rawResults = payload.results || (Array.isArray(payload) && payload[0]?.metric ? payload : (payload.header ? [payload] : []));
  const incomingNormalized = [];

  rawResults.forEach((res, idx) => {
    try {
      incomingNormalized.push(normalizeRecord(res, idx, payload.fileName || 'PAYLOAD'));
    } catch (e) {
      console.warn(`Record normalization warning at index ${idx}:`, e.message);
    }
  });

  // 2. تقسيم السجلات والصفوف بحسب الشهر (Monthly Partitioning)
  // كل صف يذهب مباشرة إلى شهر تاريخه الفعلي
  const monthBuckets = {};

  incomingNormalized.forEach(rec => {
    const header = rec.header || [];
    const rowBuckets = {};

    (rec.rows || []).forEach(row => {
      const d = extractRowDate(row, header);
      const mKey = (d && /^\d{4}-\d{2}/.test(d)) ? d.substring(0, 7) : defaultMonth;
      if (!rowBuckets[mKey]) rowBuckets[mKey] = [];
      rowBuckets[mKey].push(row);
    });

    const mKeys = Object.keys(rowBuckets);
    if (mKeys.length === 0) {
      if (!monthBuckets[defaultMonth]) monthBuckets[defaultMonth] = [];
      monthBuckets[defaultMonth].push(rec);
    } else {
      mKeys.forEach(mKey => {
        if (!monthBuckets[mKey]) monthBuckets[mKey] = [];
        monthBuckets[mKey].push(Object.assign({}, rec, { rows: rowBuckets[mKey] }));
      });
    }
  });

  let totalDrillCount = 0;
  let totalTicketsCount = 0;
  let totalSummaryAgents = 0;
  let saveFailureCount = 0;
  const processedMonths = Object.keys(monthBuckets);

  // 3. معالجة كل شهر على حدة (عزل كامل - الشهر النشط فقط HOT، والأشهر السابقة COLD مغلقة تماماً)
  for (const monthKey of processedMonths) {
    const monthRecords = monthBuckets[monthKey];
    const monthFolder = getOrCreateMonthFolder(parentFolder, monthKey);
    const monthDrillsFolder = getOrCreateMonthDrillsFolder(monthFolder);

    // تجميع حسب (agent + metric) داخل هذا الشهر
    const incomingMap = new Map();
    for (const rec of monthRecords) {
      const key = `${rec.agent.toLowerCase()}::${rec.metric.toLowerCase()}`;
      if (!incomingMap.has(key)) incomingMap.set(key, []);
      incomingMap.get(key).push(rec);
    }

    const monthUpdatedRecords = [];

    for (const [key, recs] of incomingMap.entries()) {
      const [agentEmail, metric] = key.split('::');
      const fileName = getAgentMetricFileSlug(agentEmail, metric) + ".json";
      const cacheKey = monthKey + '_' + fileName;

      try {
        let targetFile = null;
        const existingFiles = monthDrillsFolder.getFilesByName(fileName);
        if (existingFiles.hasNext()) targetFile = existingFiles.next();

        let existingReadFailed = false;
        let existingRecord = getCachedMetricRecord(cacheKey);
        if (!existingRecord && targetFile) {
          try {
            const content = targetFile.getBlob().getDataAsString();
            if (content && content.trim()) {
              existingRecord = normalizeRecord(JSON.parse(content), 0, fileName);
              setCachedMetricRecord_(cacheKey, existingRecord);
            }
          } catch (e) {
            existingReadFailed = true;
            console.warn(`Failed reading existing metric file ${fileName} in ${monthKey}:`, e && e.message);
          }
        }

        // حماية من الكتابة الجزئية: لا نستبدل ملفًا صالحًا إذا فشلت قراءته (تجنّب Lost Data)
        if (existingReadFailed && targetFile) {
          saveFailureCount++;
          logEvent_('IMPORT_FAILURE', { reason: 'EXISTING_READ_FAILED', month: monthKey, metric: metric, agent: agentEmail });
          continue;
        }

        const merged = existingRecord ? mergeRecords([existingRecord], recs) : mergeRecords([], recs);
        const finalRecord = merged.records[0];

        if (finalRecord) {
          finalRecord.date = dateStr;
          finalRecord.savedAt = nowStr;
          finalRecord.month = monthKey;
          monthUpdatedRecords.push(finalRecord);
          totalDrillCount++;
          totalTicketsCount += finalRecord.rows.length;

          const fileJson = JSON.stringify(finalRecord);
          if (targetFile) {
            targetFile.setContent(fileJson);
          } else {
            monthDrillsFolder.createFile(fileName, fileJson, MimeType.PLAIN_TEXT);
          }
          setCachedMetricRecord_(cacheKey, finalRecord);
        }
      } catch (metricErr) {
        saveFailureCount++;
        console.warn(`Metric save failed for ${fileName} in ${monthKey}:`, metricErr && metricErr.message);
      }
    }

    // 4. قراءة بقية مقاييس هذا الشهر فقط (إن وجدت) لإكمال حساب إحصائيات الشهر بدقة
    // لاحظ: نقرأ حصرياً من monthDrillsFolder الصغير الخاص بهذا الشهر فقط!
    const existingMonthDrills = monthDrillsFolder.getFiles();
    while (existingMonthDrills.hasNext()) {
      const dFile = existingMonthDrills.next();
      const dName = dFile.getName();
      if (!dName.endsWith('.json')) continue;

      const isAlreadyProcessed = monthUpdatedRecords.some(r => getAgentMetricFileSlug(r.agent, r.metric) + '.json' === dName);
      if (!isAlreadyProcessed) {
        try {
          const cacheKey = monthKey + '_' + dName;
          let cached = getCachedMetricRecord(cacheKey);
          if (cached) {
            monthUpdatedRecords.push(cached);
            continue;
          }
          const content = dFile.getBlob().getDataAsString();
          if (content && content.trim()) {
            const parsed = normalizeRecord(JSON.parse(content), 0, dName);
            monthUpdatedRecords.push(parsed);
            setCachedMetricRecord_(cacheKey, parsed);
          }
        } catch (e) {}
      }
    }

    // 5. إذا كان المطلوب بناء الملخص (Serving Model) لهذا الشهر:
    if (rebuildSummary) {
      const monthAnalytics = calculateAnalytics(monthUpdatedRecords);

      // قراءة الملخص السابق لهذا الشهر للحفاظ على أسماء الوكلاء والبيانات الوصفية
      let existingOverview = null;
      const sFiles = monthFolder.getFilesByName(CONFIG.SUMMARY_FILE_NAME || "summary.json");
      let targetSummaryFile = sFiles.hasNext() ? sFiles.next() : null;
      if (targetSummaryFile) {
        try {
          const exContent = targetSummaryFile.getBlob().getDataAsString();
          if (exContent && exContent.trim()) existingOverview = JSON.parse(exContent);
        } catch (e) {}
      }

      const metaMap = {};
      if (existingOverview && Array.isArray(existingOverview.agents)) {
        existingOverview.agents.forEach(a => {
          const em = String(a.email || '').trim().toLowerCase();
          if (em) metaMap[em] = a;
        });
      }

      const incomingAgentsMeta = payload.agents || payload.summaryAgents || [];
      incomingAgentsMeta.forEach(a => {
        const em = String(a.email || '').trim().toLowerCase();
        if (em) metaMap[em] = Object.assign({}, metaMap[em] || {}, a);
      });

      const allAgentEmailsSet = new Set([
        ...monthAnalytics.uniqueAgents.map(e => e.toLowerCase()),
        ...Object.keys(metaMap)
      ]);

      const finalAgentsList = Array.from(allAgentEmailsSet).map(emLower => {
        const origEmail = monthAnalytics.uniqueAgents.find(e => e.toLowerCase() === emLower) || (metaMap[emLower] && metaMap[emLower].email) || emLower;
        const agStat = monthAnalytics.agentStats[origEmail] || monthAnalytics.agentStats[emLower] || {};
        const meta = metaMap[emLower] || {};

        let displayName = meta.name || '';
        if (!displayName) displayName = origEmail.split('@')[0].replace(/\./g, ' ');

        const metaHasNum = v => v !== undefined && v !== null && v !== '' && isFinite(Number(v));
        const metaHasVal = v => v !== undefined && v !== null && String(v).trim() !== '';

        // القاعدة: عند غياب بيانات المقياس بالكامل تُعاد null لعرض "—" في الواجهة بدل الصفر.
        // أما الصفر الحقيقي (مثل 0 تأخير أو 0 تجاوزات) فيبقى كما هو.

        // CSAT: drill > بطاقة الملخص > فارغ
        let csatVal = null;
        if (agStat.hasCsat && agStat.csatPct !== null) csatVal = agStat.csatPct;
        else if (metaHasNum(meta.csat)) csatVal = Number(meta.csat);

        // AGBT: drill > بطاقة الملخص > فارغ
        let agbtVal = null;
        if (agStat.hasAgbt && agStat.agbtDisplay) agbtVal = agStat.agbtDisplay;
        else if (metaHasVal(meta.agbt)) agbtVal = String(meta.agbt);

        // ABST: drill > بطاقة الملخص > فارغ
        let abstVal = null;
        if (agStat.hasAbst && agStat.abstAvg) abstVal = agStat.abstAvg;
        else if (metaHasVal(meta.abst)) abstVal = String(meta.abst);

        // Break Breach: drill > بطاقة الملخص > فارغ
        let breakVal = null;
        if (agStat.hasBreak && agStat.breakBreaches !== undefined) breakVal = String(agStat.breakBreaches);
        else if (metaHasVal(meta.breakBreach)) breakVal = String(meta.breakBreach);

        // Lateness (دقائق): drill > بطاقة الملخص > فارغ
        let latenessVal = null;
        if (agStat.hasLateness && agStat.latenessMins !== undefined) latenessVal = agStat.latenessMins;
        else if (metaHasNum(meta.lateness)) latenessVal = Number(meta.lateness);

        // Idle (ساعات): drill > بطاقة الملخص > فارغ
        let idleVal = null;
        if (agStat.hasIdle && agStat.idleHours !== null && agStat.idleHours !== undefined) idleVal = String(agStat.idleHours);
        else if (metaHasVal(meta.idle)) idleVal = String(meta.idle);

        // Productivity: بطاقة الملخص فقط. الصفر/الفارغ يُعتبر «لا بيانات» => null
        let prodVal = null;
        if (metaHasVal(meta.productivity)) {
          const prodNum = parseFloat(String(meta.productivity).replace('%', ''));
          if (!isNaN(prodNum) && prodNum !== 0) prodVal = String(meta.productivity);
        }

        return {
          date: dateStr,
          month: monthKey,
          name: displayName,
          email: origEmail,
          csat: csatVal,
          csatGood: agStat.csatGood !== undefined ? agStat.csatGood : (meta.csatGood || 0),
          csatBad: agStat.csatBad !== undefined ? agStat.csatBad : (meta.csatBad || 0),
          csatTotal: agStat.csatTotal !== undefined ? agStat.csatTotal : (meta.csatTotal || 0),
          agbt: agbtVal,
          abst: abstVal,
          breakBreach: breakVal,
          breakExceedMins: agStat.breakExceedMins !== undefined ? agStat.breakExceedMins : null,
          lateness: latenessVal,
          idle: idleVal,
          productivity: prodVal,
          recordsCount: agStat.recordsCount || 0,
          rowsCount: agStat.rowsCount || 0,
          sessions: (agStat.sessions !== undefined ? agStat.sessions : null),
          updatedAt: Utilities.formatDate(new Date(), 'Asia/Riyadh', 'HH:mm')
        };
      });

      // حساب ترتيب الأداء والمفاضلة بالسيسات وتغير الرتبة اليومي (Rank, Tie-break, Rank Change)
      const sortedForRank = [...finalAgentsList].sort((a, b) => {
        const cA = Number(a.csat) || 0;
        const cB = Number(b.csat) || 0;
        if (cB !== cA) return cB - cA;
        const tA = Number(a.csatTotal) || 0;
        const tB = Number(b.csatTotal) || 0;
        if (tB !== tA) return tB - tA;
        const sA = Number(a.sessions) || 0;
        const sB = Number(b.sessions) || 0;
        return sB - sA;
      });

      const prevRankMap = {};
      if (existingOverview && Array.isArray(existingOverview.agents)) {
        existingOverview.agents.forEach(a => {
          const em = String(a.email || '').trim().toLowerCase();
          if (em && a.rank) prevRankMap[em] = Number(a.rank);
        });
      }

      sortedForRank.forEach((a, idx) => {
        const currentRank = idx + 1;
        a.rank = currentRank;
        const em = String(a.email || '').trim().toLowerCase();
        const prev = prevRankMap[em] || (metaMap[em] && Number(metaMap[em].rank)) || null;
        a.prevRank = prev;
        a.rankChange = (prev !== null && !isNaN(prev)) ? (prev - currentRank) : null;
      });

      // إجماليات ومتوسطات الفريق للشهر
      let sumCsat = 0, countCsat = 0;
      let sumLateness = 0;
      let sumBreaches = 0;

      finalAgentsList.forEach(a => {
        if (a.csat > 0) {
          sumCsat += a.csat;
          countCsat++;
        }
        sumLateness += (parseFloat(a.lateness) || 0);
        sumBreaches += (parseInt(a.breakBreach, 10) || 0);
      });

      const teamAvgCsat = monthAnalytics.csat.pct !== null
        ? `${monthAnalytics.csat.pct}%`
        : (countCsat > 0 ? `${Math.round((sumCsat / countCsat) * 10) / 10}%` : "—");

      const teamTotalLateness = monthAnalytics.lateness.totalMins > 0
        ? `${monthAnalytics.lateness.totalMins}`
        : `${Math.round(sumLateness)}`;

      const teamTotalBreaches = monthAnalytics.breakBreach.breaches > 0
        ? `${monthAnalytics.breakBreach.breaches}`
        : `${sumBreaches}`;

      // بناء نموذج العرض الجاهز summary.json (Serving Model)
      totalSummaryAgents += finalAgentsList.length;
      const monthSummaryObj = {
        version: CONFIG.SCHEMA_VERSION || 1,
        month: monthKey,
        success: true,
        lastSync: nowStr,
        summary: {
          totalAgents: finalAgentsList.length,
          avgCsat: teamAvgCsat,
          totalLateness: teamTotalLateness,
          totalBreaches: teamTotalBreaches,
          totalSessions: monthAnalytics.totalSessions,
          totalLongSessions: monthAnalytics.totalLongSessions,
          avgDailySessions: monthAnalytics.avgDailySessions,
          activeDays: monthAnalytics.activeDays,
          totalDrillRows: monthAnalytics.totalRows,
          lastSync: Utilities.formatDate(new Date(), 'Asia/Riyadh', 'HH:mm'),
          totalMetrics: 7
        },
        overview: {
          csatPct: monthAnalytics.csat.pct,
          agbtAvg: monthAnalytics.agbt.avg,
          breakBreaches: monthAnalytics.breakBreach.breaches,
          latenessMins: monthAnalytics.lateness.totalMins,
          idleHours: monthAnalytics.idle.totalHours,
          totalSessions: monthAnalytics.totalSessions
        },
        agents: finalAgentsList,
        historicalDays: monthAnalytics.timeline || [],
        byDay: monthAnalytics.timeline || []
      };

      const summaryJsonStr = JSON.stringify(monthSummaryObj);
      if (targetSummaryFile) {
        targetSummaryFile.setContent(summaryJsonStr);
      } else {
        monthFolder.createFile(CONFIG.SUMMARY_FILE_NAME || "summary.json", summaryJsonStr, MimeType.PLAIN_TEXT);
      }

      // كتابة meta.json لتوثيق حالة المجلد ورقم الإصدار
      const metaObj = {
        month: monthKey,
        rowCount: monthAnalytics.totalRows,
        lastUpdated: nowStr,
        schemaVersion: CONFIG.SCHEMA_VERSION || 1,
        status: "ready"
      };
      const mFiles = monthFolder.getFilesByName(CONFIG.META_FILE_NAME || "meta.json");
      if (mFiles.hasNext()) mFiles.next().setContent(JSON.stringify(metaObj));
      else monthFolder.createFile(CONFIG.META_FILE_NAME || "meta.json", JSON.stringify(metaObj), MimeType.PLAIN_TEXT);

      // تحديث الفهرس والكاش
      updateMonthsIndex_(monthKey);
      setCachedOverview_(monthSummaryObj, monthKey);

      // إذا كان هذا الشهر هو الأحدث أو الحالي، نحدث أيضاً summary_overview.json للملاءمة العكسية
      const curIdx = getMonthsIndex();
      if (curIdx.currentMonth === monthKey) {
        setCachedOverview_(monthSummaryObj, 'DEFAULT');
        const legacyRootFiles = parentFolder.getFilesByName(CONFIG.LEGACY_SUMMARY_FILE_NAME || "summary_overview.json");
        if (legacyRootFiles.hasNext()) legacyRootFiles.next().setContent(summaryJsonStr);
        else parentFolder.createFile(CONFIG.LEGACY_SUMMARY_FILE_NAME || "summary_overview.json", summaryJsonStr, MimeType.PLAIN_TEXT);
      }

      // مسح كاش الخط الزمني للوكلاء المحدثين في هذا الشهر
      incomingMap.forEach((recs, k) => {
        const agEmail = k.split('::')[0];
        if (agEmail) clearCachedAgentTimeline_(agEmail, false, monthKey);
      });
    }
  }

  clearCachedPeriodTables_();
  clearCachedAgentsChart_();
  clearTicketSessionsIndex_();

  if (writeLockAcquired) { try { writeLock.releaseLock(); } catch (e) {} }

  return {
    success: true,
    partial: !rebuildSummary || saveFailureCount > 0,
    summaryCount: totalSummaryAgents,
    months: processedMonths,
    drillCount: totalDrillCount,
    ticketsCount: totalTicketsCount,
    failedCount: saveFailureCount,
    date: dateStr
  };
}

/**
 * ============================================================================
 * 5. قراءة بيانات النظرة العامة للوكلاء لشهر محدد — استجابة فورية من كائن العرض
 * ============================================================================
 */
function getOverviewData(targetMonth) {
  return withDashboardReadContext_(() => getOverviewDataImpl_(targetMonth));
}

function getOverviewDataImpl_(targetMonth) {
  try {
    if (!requireAllowed()) {
      return { success: false, isEmpty: true, agents: [], summary: { totalAgents: 0, avgCsat: "—", totalLateness: "—", lastSync: "—", totalDrillRows: 0 }, historicalDays: [], message: 'غير مصرح لك.' };
    }
    const monthsIndex = getMonthsIndex();

    let month = String(targetMonth || '').trim();
    if (month && month.toLowerCase() !== 'current' && !isValidMonthFormat(month)) {
      return { success: false, isEmpty: true, code: ERR.INVALID_MONTH, month: month, currentMonth: monthsIndex.currentMonth, availableMonths: monthsIndex.availableMonths, agents: [], summary: { totalAgents: 0, avgCsat: "—", totalLateness: "—", lastSync: "—", totalDrillRows: 0 }, historicalDays: [], message: 'صيغة الشهر غير صالحة (المطلوب YYYY-MM).' };
    }
    if (!month || month.toLowerCase() === 'current') {
      month = monthsIndex.currentMonth || Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM');
    }

    // 1. فحص الكاش السريع لهذا الشهر (< 5ms)
    const cached = getCachedOverview(month);
    if (cached && Array.isArray(cached.agents)) {
      if (!isSupportedSchema_(cached)) {
        return { success: false, isEmpty: true, code: ERR.CONSISTENCY_ERROR, month: month, currentMonth: monthsIndex.currentMonth, availableMonths: monthsIndex.availableMonths, agents: [], summary: { totalAgents: 0, avgCsat: "—", totalLateness: "—", lastSync: "—", totalDrillRows: 0 }, historicalDays: [], message: 'إصدار بيانات غير مدعوم.' };
      }
      return {
        success: true,
        isEmpty: cached.agents.length === 0,
        month: month,
        currentMonth: monthsIndex.currentMonth,
        availableMonths: monthsIndex.availableMonths,
        summary: cached.summary,
        overview: cached.overview || {},
        agents: cached.agents,
        historicalDays: cached.historicalDays || cached.byDay || []
      };
    }

    // 2. قراءة ملف summary.json من مجلد الشهر المخصص [month]/
    const parentFolder = getOrCreateDataFolder();
    let summaryContent = null;
    const mFolder = getMonthFolder(parentFolder, month, false);
    if (mFolder) {
      const sFiles = mFolder.getFilesByName(CONFIG.SUMMARY_FILE_NAME || "summary.json");
      if (sFiles.hasNext()) {
        summaryContent = sFiles.next().getBlob().getDataAsString();
      }
    }

    // 3. إذا لم يتم العثور على مجلد الشهر، الرجوع لملف summary_overview.json القديم (Fallback)
    if (!summaryContent && month === (monthsIndex.currentMonth || Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM'))) {
      const legacyFiles = parentFolder.getFilesByName(CONFIG.LEGACY_SUMMARY_FILE_NAME || "summary_overview.json");
      if (legacyFiles.hasNext()) {
        summaryContent = legacyFiles.next().getBlob().getDataAsString();
      }
    }

    if (!summaryContent || !summaryContent.trim()) {
      return {
        success: true,
        isEmpty: true,
        month: month,
        currentMonth: monthsIndex.currentMonth,
        availableMonths: monthsIndex.availableMonths,
        agents: [],
        summary: { totalAgents: 0, avgCsat: "—", totalLateness: "—", lastSync: "—", totalDrillRows: 0 },
        historicalDays: [],
        message: "لا توجد بيانات مسجلة لشهر (" + month + ") حتى الآن."
      };
    }

    let data;
    try {
      data = JSON.parse(summaryContent);
    } catch (e) {
      return { success: false, isEmpty: true, code: ERR.CONSISTENCY_ERROR, month: month, currentMonth: monthsIndex.currentMonth, availableMonths: monthsIndex.availableMonths, agents: [], summary: { totalAgents: 0, avgCsat: "—", totalLateness: "—", lastSync: "—", totalDrillRows: 0 }, historicalDays: [], message: "تعذر قراءة ملخص الشهر." };
    }
    if (!isSupportedSchema_(data)) {
      return { success: false, isEmpty: true, code: ERR.CONSISTENCY_ERROR, month: month, currentMonth: monthsIndex.currentMonth, availableMonths: monthsIndex.availableMonths, agents: [], summary: { totalAgents: 0, avgCsat: "—", totalLateness: "—", lastSync: "—", totalDrillRows: 0 }, historicalDays: [], message: "إصدار بيانات غير مدعوم." };
    }
    setCachedOverview_(data, month);

    return {
      success: true,
      isEmpty: !data.agents || data.agents.length === 0,
      month: month,
      currentMonth: monthsIndex.currentMonth,
      availableMonths: monthsIndex.availableMonths,
      summary: data.summary,
      overview: data.overview || {},
      agents: data.agents || [],
      historicalDays: data.historicalDays || data.byDay || []
    };

  } catch (err) {
    return {
      success: false,
      isEmpty: true,
      agents: [],
      summary: { totalAgents: 0, avgCsat: "—", totalLateness: "—", lastSync: "—", totalDrillRows: 0 },
      historicalDays: [],
      code: errorCode_(err),
      message: safeError_(err, "حدث خطأ أثناء قراءة البيانات.")
    };
  }
}

/**
 * ============================================================================
 * 6. قراءة البيانات التفصيلية لمقياس ووكيل وشهر محدد
 * ============================================================================
 */
function getAgentDetailData(email, metric, targetMonth) {
  return withDashboardReadContext_(() => getAgentDetailDataImpl_(email, metric, targetMonth));
}

function getAgentDetailDataImpl_(email, metric, targetMonth) {
  try {
    if (!requireAllowed()) {
      return { success: false, found: false, isAllAgents: false, email: email, metric: (metric || 'csat').trim().toLowerCase(), header: [], rows: [], count: 0, message: 'غير مصرح لك.' };
    }
    if (email && email !== 'all' && email !== '' && isAgentBanned(email)) {
      return {
        success: true,
        found: false,
        isAllAgents: false,
        email: email,
        metric: (metric || 'csat').trim().toLowerCase(),
        header: [],
        rows: [],
        count: 0,
        message: 'Agent is hidden (banned).'
      };
    }

    if (!email || email === 'all' || email === '') {
      const overview = getOverviewData(targetMonth);
      const banned = getBannedAgentsSet();
      const visibleAgents = (overview.agents || []).filter(a => !banned.has(String(a.email || '').toLowerCase().trim()));
      return getAllAgentsMetricSummary(visibleAgents, metric);
    }

    const parentFolder = getOrCreateDataFolder();
    const targetMetric = (metric || "csat").trim().toLowerCase();
    const fileName = getAgentMetricFileSlug(email, targetMetric) + ".json";

    let month = String(targetMonth || '').trim();
    if (month && month.toLowerCase() !== 'current' && !isValidMonthFormat(month)) {
      return { success: false, code: ERR.INVALID_MONTH, message: 'صيغة الشهر غير صالحة (المطلوب YYYY-MM).', found: false, header: [], rows: [] };
    }
    if (!month || month.toLowerCase() === 'current') {
      const idx = getMonthsIndex();
      month = idx.currentMonth || Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM');
    }

    let content = null;

    // أ. محاولة القراءة من مجلد الشهر المحدد [month]/drills/
    const mFolder = getMonthFolder(parentFolder, month, false);
    if (mFolder) {
      const dFolders = mFolder.getFoldersByName(CONFIG.DRILLS_FOLDER_NAME || "drills");
      if (dFolders.hasNext()) {
        const dFiles = dFolders.next().getFilesByName(fileName);
        if (dFiles.hasNext()) {
          content = dFiles.next().getBlob().getDataAsString();
        }
      }
    }

    // ب. إذا لم يوجد (fallback للملفات السابقة قبل الترحيل)، القراءة من مجلد drills/ القديم
    if (!content && month === (getMonthsIndex().currentMonth || Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM'))) {
      const legacyDrills = getOrCreateDrillsFolder();
      const legacyFiles = legacyDrills.getFilesByName(fileName);
      if (legacyFiles.hasNext()) {
        content = legacyFiles.next().getBlob().getDataAsString();
      }
    }

    if (!content || !content.trim()) {
      return {
        success: true,
        found: false,
        isAllAgents: false,
        email: email,
        metric: targetMetric,
        month: month,
        header: [],
        rows: [],
        count: 0,
        message: `لم يتم العثور على سجلات لمقياس (${targetMetric}) للوكيل (${email}) في شهر (${month}).`
      };
    }

    const storedDrill = JSON.parse(content);
    const drill = Object.assign({}, storedDrill, normalizeRecord(
      Object.assign({}, storedDrill, { agent: email, metric: targetMetric }), 0, fileName));

    return {
      success: true,
      found: true,
      isAllAgents: false,
      email: email,
      metric: targetMetric,
      month: month,
      title: drill.title || `${targetMetric.toUpperCase()} - ${email}`,
      header: drill.header || [],
      rows: drill.rows || [],
      count: (drill.rows || []).length,
      date: drill.date || "",
      savedAt: drill.savedAt || ""
    };

  } catch (err) {
    return {
      success: false,
      found: false,
      error: safeError_(err)
    };
  }
}

/**
 * ============================================================================
 * Chart Drill-down — تفاصيل النقطة/البار لوكيل واحد.
 * - قراءة ملف drills واحد فقط للوكيل/المقياس/الشهر (لا all-agent ولا full-history).
 * - Drill-down/Presentation فقط: لا يغيّر أي حساب أو تجميع قائم.
 * - يعيد حقولًا مختصرة فقط: Ticket / Date & Time / Duration / Channel / Score.
 * ============================================================================
 */
const CHART_DRILLDOWN_METRICS = ['csat', 'abst', 'agbt', 'sessions', 'long'];
const CHART_DRILLDOWN_ROW_CAP = 200;

// sessions/long مشتقّان من ملف ABST (لا ملف مستقل لهما)
function chartDrilldownSourceMetric_(metric) {
  const m = String(metric || '').trim().toLowerCase();
  if (m === 'sessions' || m === 'long') return 'abst';
  return m;
}

// نفس قاعدة الجلسة الطويلة المستخدمة في التحليل (parseFloat لعمود الدقائق أو عمود > 20)
function isLongSessionRow_(row, header) {
  const h = (header || []).map(c => String(c).toLowerCase().trim());
  const minsIdx = findSessionMinsCol(header);
  const over20Idx = h.findIndex(c => c === '> 20' || c.includes('> 20') || c.includes('over_20'));
  if (minsIdx !== -1) {
    const m = parseFloat(row[minsIdx]);
    if (!isNaN(m) && m >= 20) return true;
  }
  if (over20Idx !== -1) {
    const v = String(row[over20Idx] || '').toLowerCase().trim();
    if (v === 'high' || v === 'yes') return true;
  }
  return false;
}

function getAgentChartDrilldown(payload) {
  try {
    if (!requireAllowed()) {
      return { success: false, code: ERR.ADMIN_REQUIRED, message: 'غير مصرح لك.' };
    }
    const p = (typeof payload === 'string') ? JSON.parse(payload) : (payload || {});
    const month = String(p.month || '').trim();
    const agent = String(p.agent || '').trim();
    const metric = String(p.metric || '').trim().toLowerCase();
    const grouping = (String(p.grouping || 'day').trim().toLowerCase() === 'shift') ? 'shift' : 'day';
    const date = String(p.date || '').trim();

    if (!isValidMonthFormat(month)) {
      return { success: false, code: ERR.INVALID_MONTH, message: 'صيغة الشهر غير صالحة (المطلوب YYYY-MM).' };
    }
    if (!agent || agent.toLowerCase() === 'all') {
      return { success: false, code: ERR.INVALID_RANGE, message: 'يجب تحديد وكيل واحد.' };
    }
    if (CHART_DRILLDOWN_METRICS.indexOf(metric) === -1) {
      return { success: false, code: ERR.INVALID_RANGE, message: 'مقياس غير مدعوم.' };
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { success: false, code: ERR.INVALID_RANGE, message: 'تاريخ غير صالح.' };
    }

    const base = { success: true, month: month, agent: agent, metric: metric, grouping: grouping, date: date };

    if (isAgentBanned(agent)) {
      return Object.assign({}, base, { total: 0, rows: [], truncated: false, rowCap: CHART_DRILLDOWN_ROW_CAP });
    }

    let shiftWindow = null;
    if (grouping === 'shift') {
      const sh = parseInt(p.shiftStartHour, 10);
      const eh = parseInt(p.shiftEndHour, 10);
      if (isNaN(sh) || isNaN(eh)) {
        return { success: false, code: ERR.INVALID_RANGE, message: 'نافذة الشفت غير محددة.' };
      }
      shiftWindow = {
        startHour: Math.max(0, Math.min(23, sh)),
        endHour: Math.max(0, Math.min(23, eh)),
        inferred: false,
        explicit: true
      };
    }

    // قراءة ملف واحد فقط: [month]/drills/agent_<email>_<sourceMetric>.json
    const sourceMetric = chartDrilldownSourceMetric_(metric);
    const detail = getAgentDetailData(agent, sourceMetric, month);
    if (!detail || !detail.success || !detail.found || !Array.isArray(detail.rows) || !detail.rows.length) {
      return Object.assign({}, base, { total: 0, rows: [], truncated: false, rowCap: CHART_DRILLDOWN_ROW_CAP });
    }

    const header = detail.header || [];
    const ticketIdx = findTicketIdCol(header);
    const timeIdx = findSessionMinsCol(header);
    const chanIdx = findColIndex(header, 'ticket_channel', 'channel');
    const scoreIdx = findColIndex(header, 'csat_adjusted', 'csat', 'score');

    const out = [];
    let matched = 0;
    for (let i = 0; i < detail.rows.length; i++) {
      const row = detail.rows[i];
      const rowDay = shiftWindow
        ? shiftDateFromRiyadhTs(shiftTimestampForRow(row, header), shiftWindow)
        : extractRowDate(row, header);
      if (!rowDay || rowDay !== date) continue;
      if (metric === 'long' && !isLongSessionRow_(row, header)) continue;

      matched++;
      if (out.length >= CHART_DRILLDOWN_ROW_CAP) continue;

      let durationMins = null;
      if (timeIdx !== -1) {
        const raw = String(row[timeIdx] == null ? '' : row[timeIdx]).trim();
        if (raw.indexOf(':') !== -1) {
          const parts = raw.split(':');
          const hh = parseFloat(parts[0]);
          const mm = parseFloat(parts[1]);
          if (!isNaN(hh) || !isNaN(mm)) durationMins = (isNaN(hh) ? 0 : hh) * 60 + (isNaN(mm) ? 0 : mm);
        } else {
          const n = parseFloat(raw);
          if (!isNaN(n)) durationMins = n;
        }
      }

      out.push({
        ticket: ticketIdx !== -1 ? String(row[ticketIdx] == null ? '' : row[ticketIdx]) : '',
        datetime: extractRowTimestamp(row, header) || rowDay,
        durationMins: durationMins,
        channel: chanIdx !== -1 ? String(row[chanIdx] == null ? '' : row[chanIdx]) : '',
        score: scoreIdx !== -1 ? String(row[scoreIdx] == null ? '' : row[scoreIdx]) : ''
      });
    }

    return Object.assign({}, base, {
      total: matched,
      rows: out,
      truncated: matched > CHART_DRILLDOWN_ROW_CAP,
      rowCap: CHART_DRILLDOWN_ROW_CAP
    });
  } catch (err) {
    return { success: false, error: safeError_(err), message: 'تعذّر تحميل التفاصيل. حاول لاحقًا.' };
  }
}

/**
 * توليد جدول مقارنة جميع الوكلاء لمقياس معين
 */
function getAllAgentsMetricSummary(agentsList, metric) {
  if (!requireAllowed()) {
    return { success: false, found: false, isAllAgents: true, email: 'all', metric: metric, title: '', header: [], rows: [], count: 0, message: 'غير مصرح لك.' };
  }
  const m = (metric || "csat").toLowerCase();
  let header = ["الترتيب", "اسم الوكيل", "البريد الإلكتروني", "قيمة المقياس", "الحالة والتقييم"];
  let metricLabel = "CSAT %";

  if (m === "agbt") metricLabel = "AGBT (المناولة)";
  else if (m === "abst") metricLabel = "ABST (سرعة الرد)";
  else if (m === "breakbreach" || m === "break") metricLabel = "تجاوزات البريك";
  else if (m === "lateness") metricLabel = "دقائق التأخير";
  else if (m === "idle") metricLabel = "وقت الخمول";
  else if (m === "productivity") metricLabel = "الإنتاجية";

  header[3] = metricLabel;

  // ربط اسم المقياس المطبّع (lowercase) بمفتاح الوكيل الفعلي (camelCase) في بطاقات الملخص
  const metricKeyMap = {
    csat: 'csat',
    agbt: 'agbt',
    abst: 'abst',
    breakbreach: 'breakBreach',
    break: 'breakBreach',
    lateness: 'lateness',
    idle: 'idle',
    productivity: 'productivity'
  };
  const valueKey = metricKeyMap[m] || m;

  const rows = [];
  (agentsList || []).forEach((row, idx) => {
    const name = String(row.name || "").trim();
    const email = String(row.email || "").trim();
    if (!email) return;

    let val = row[valueKey] !== undefined ? row[valueKey] : (row[metric] !== undefined ? row[metric] : "—");
    const hasVal = val !== null && val !== undefined && String(val).trim() !== '' && String(val).trim() !== '—';
    let displayVal = hasVal ? String(val) : "—";
    let status = hasVal ? "طبيعي" : "—";

    if (!hasVal) {
      // لا بيانات => تبقى "—"
    } else if (m === "csat") {
      const num = parseFloat(val) || 0;
      displayVal = num + "%";
      status = num >= 90 ? "ممتاز 🟢" : (num >= 80 ? "جيد 🟡" : "يحتاج تحسين 🔴");
    } else if (m === "abst") {
      displayVal = String(val || "—");
      let secs = 0;
      if (displayVal.includes(":")) {
        const p = displayVal.split(":");
        secs = (parseInt(p[0]) || 0) * 60 + (parseInt(p[1]) || 0);
      } else {
        secs = (parseFloat(displayVal) || 0) * 60;
      }
      if (secs > 0 && secs <= 90) {
        status = "سريع وممتاز 🟢 (إيجابي)";
      } else if (secs > 0 && secs <= 150) {
        status = "معدل طبيعي 🟡 (مقبول)";
      } else if (secs > 150) {
        status = "استجابة بطيئة 🔴 (سلبي)";
      }
    } else if (m === "agbt") {
      displayVal = String(val || "—");
      status = "وقت المناولة";
    } else if (m === "lateness") {
      const num = parseFloat(val) || 0;
      displayVal = num + " د";
      status = num === 0 ? "ملتزم 🟢" : "متأخر 🔴";
    } else if (m === "breakbreach" || m === "break") {
      const num = parseInt(val) || 0;
      status = num === 0 ? "صفر تجاوزات 🟢" : "تجاوز مسجل 🔴";
    }

    rows.push([
      String(idx + 1),
      name,
      email,
      displayVal,
      status
    ]);
  });

  return {
    success: true,
    found: true,
    isAllAgents: true,
    email: "all",
    metric: metric,
    title: `مقارنة أداء جميع الوكلاء — مقياس ${metricLabel}`,
    header: header,
    rows: rows,
    count: rows.length
  };
}

/**
 * تحديث اختياري لـ Google Sheet (الملخص الإحصائي فقط بدون حشر أي JSON)
 */
function getTargetSpreadsheet() {
  try {
    if (CONFIG.SPREADSHEET_ID && CONFIG.SPREADSHEET_ID.trim() !== "" && !CONFIG.SPREADSHEET_ID.includes("YOUR_")) {
      return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    }
    return SpreadsheetApp.getActiveSpreadsheet();
  } catch (e) {
    return null;
  }
}

// دوال التوافق التي تستدعيها الواجهة الأمامية
function getDashboardDataFromSheet(targetMonth) {
  return withDashboardReadContext_(() => getDashboardDataFromSheetImpl_(targetMonth));
}

function getDashboardDataFromSheetImpl_(targetMonth) {
  const res = getOverviewData(targetMonth);
  if (res && res.success && Array.isArray(res.agents)) {
    const banned = getBannedAgentsSet();
    let agents = res.agents;
    if (banned.size > 0) {
      agents = agents.filter(a => !banned.has(String(a.email || '').toLowerCase().trim()));
    }
    // Data minimization: نُرسل فقط حقول العرض التي تستخدمها الواجهة فعليًا
    // (حذف csatGood/csatBad/csatTotal/recordsCount/rowsCount/updatedAt من الاستجابة فقط — تبقى في التخزين)
    res.agents = agents.map(a => ({
      date: a.date,
      month: a.month,
      name: a.name,
      email: a.email,
      csat: a.csat,
      agbt: a.agbt,
      abst: a.abst,
      breakBreach: a.breakBreach,
      breakExceedMins: a.breakExceedMins,
      sessions: a.sessions,
      lateness: a.lateness,
      idle: a.idle,
      productivity: a.productivity
    }));
    if (res.summary) {
      res.summary = { totalAgents: res.agents.length, totalDrillRows: res.summary.totalDrillRows || 0 };
    }
  }
  return res;
}

/**
 * قراءة الخط الزمني اليومي لوكيل واحد فقط (لا يتم دمج وكلاء آخرين).
 * يعتمد على ملفات drills الخاصة بهذا الوكيل حصرياً في مجلد الشهر المطلوب.
 */
function agentTimelineCacheKey(email, byShift, targetMonth) {
  const m = String(targetMonth || 'all').trim();
  return 'AGT_' + String(email || '').trim().toLowerCase() + (byShift ? '_shift' : '') + '_' + m;
}

function getCachedAgentTimeline(email, byShift, targetMonth) {
  if (!requireAllowed()) return null;
  try {
    const raw = CacheService.getScriptCache().get(agentTimelineCacheKey(email, byShift, targetMonth));
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.warn('Agent timeline cache read warning:', e);
  }
  return null;
}

function setCachedAgentTimeline_(email, obj, byShift, targetMonth) {
  try {
    const s = JSON.stringify(obj);
    if (s.length < 90000) {
      CacheService.getScriptCache().put(agentTimelineCacheKey(email, byShift, targetMonth), s, 21600); // 6 ساعات
    }
  } catch (e) {
    console.warn('Agent timeline cache write warning:', e);
  }
}

function clearCachedAgentTimeline_(email, byShift, targetMonth) {
  try {
    if (targetMonth) {
      CacheService.getScriptCache().remove(agentTimelineCacheKey(email, false, targetMonth));
      CacheService.getScriptCache().remove(agentTimelineCacheKey(email, true, targetMonth));
    } else {
      const idx = getMonthsIndex();
      (idx.availableMonths || []).forEach(m => {
        CacheService.getScriptCache().remove(agentTimelineCacheKey(email, false, m));
        CacheService.getScriptCache().remove(agentTimelineCacheKey(email, true, m));
      });
      CacheService.getScriptCache().remove(agentTimelineCacheKey(email, false, 'all'));
      CacheService.getScriptCache().remove(agentTimelineCacheKey(email, true, 'all'));
    }
  } catch (e) {}
}

/**
 * يقرأ سجلات المقاييس (drills) لوكيل محدد في شهر معين، مع الرجوع للمجلد القديم عند الحاجة.
 * دالة مشتركة بين الخط الزمني اليومي ومخطط المقارنة حسب الوكيل (لا تكرار للمنطق).
 */
function readAgentRecordsForMonth(email, month, prebuiltIndex, metricFilter) {
  const prefix = getAgentFileSlug(email) + '_';
  const records = [];
  const filterNeedle = metricFilter ? String(metricFilter).toLowerCase().trim() : null;

  // مسار مُحسّن: فهرس مُبنى بتعداد واحد لمجلد الشهر (يمنع Folder Scan لكل وكيل)
  if (prebuiltIndex && prebuiltIndex.filesBySlug) {
    const files = prebuiltIndex.filesBySlug.get(getAgentFileSlug(email)) || [];
    files.forEach(f => {
      const name = f.getName();
      if (name.indexOf(prefix) !== 0) return;
      if (filterNeedle && !name.toLowerCase().includes(filterNeedle)) return;
      try {
        const content = f.getBlob().getDataAsString();
        if (content && content.trim()) records.push(normalizeRecord(JSON.parse(content), 0, name));
      } catch (e) { throw e; }
    });
    // إن لم نجد سجلات في الفهرس (مثلاً بيانات الشهر الحالي في legacy) نكمل للمسار العادي مع fallback
    if (records.length > 0) return records;
  }

  const parentFolder = getOrCreateDataFolder();

  // 1. مجلد الشهر المخصص [month]/drills/
  const mFolder = getMonthFolder(parentFolder, month, false);
  if (mFolder) {
    const dFolders = mFolder.getFoldersByName(CONFIG.DRILLS_FOLDER_NAME || "drills");
    if (dFolders.hasNext()) {
      const files = dFolders.next().getFiles();
      while (files.hasNext()) {
        const f = files.next();
        const name = f.getName();
        if (!name.endsWith('.json') || name.indexOf(prefix) !== 0) continue;
        if (filterNeedle && !name.toLowerCase().includes(filterNeedle)) continue;
        try {
          const content = f.getBlob().getDataAsString();
          if (content && content.trim()) {
            records.push(normalizeRecord(JSON.parse(content), 0, name));
          }
        } catch (e) { throw e; }
      }
    }
  }

  // 2. الرجوع لمجلد drills/ القديم كـ Fallback — فقط للشهر الحالي،
  //    حتى لا يؤدي شهر تاريخي بلا مجلد إلى مسح كل التاريخ في Hot Path.
  if (records.length === 0) {
    let isCurrentMonth = false;
    try {
      const nowYm = Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM');
      if (!month || month === nowYm) {
        isCurrentMonth = true;
      } else {
        const idx = getMonthsIndex();
        if (idx && idx.currentMonth && month === idx.currentMonth) isCurrentMonth = true;
      }
    } catch (e) { isCurrentMonth = !month; }

    if (isCurrentMonth) {
      const drillsFolder = getOrCreateDrillsFolder();
      const files = drillsFolder.getFiles();
      while (files.hasNext()) {
        const f = files.next();
        const name = f.getName();
        if (!name.endsWith('.json') || name.indexOf(prefix) !== 0) continue;
        try {
          const content = f.getBlob().getDataAsString();
          if (content && content.trim()) {
            records.push(normalizeRecord(JSON.parse(content), 0, name));
          }
        } catch (e) { throw e; }
      }
    }
  }

  return records;
}

/**
 * تعداد واحد لمجلد drills للشهر وبناء فهرس {slug -> [files]}.
 * يُستخدم لتفادي Folder Scan لكل وكيل (N+1) في مخطط By Agent وجدول الفترات.
 * يعيد null إذا لم يكن هناك مجلد شهر/مجلد drills (ليُستخدم مسار الـFallback العادي).
 */
function enumerateMonthDrills_(month) {
  const m = String(month || '').trim();
  if (!isValidMonthFormat(m)) return null;
  const parentFolder = getOrCreateDataFolder();
  const mFolder = getMonthFolder(parentFolder, m, false);
  if (!mFolder) return null;
  const dFolders = mFolder.getFoldersByName(CONFIG.DRILLS_FOLDER_NAME || "drills");
  if (!dFolders.hasNext()) return null;
  const filesBySlug = new Map();
  const files = dFolders.next().getFiles();
  while (files.hasNext()) {
    const f = files.next();
    const name = f.getName();
    if (!name.endsWith('.json')) continue;
    const idx = name.lastIndexOf('_');
    if (idx === -1) continue;
    const slug = name.slice(0, idx);
    if (!filesBySlug.has(slug)) filesBySlug.set(slug, []);
    filesBySlug.get(slug).push(f);
  }
  return { filesBySlug: filesBySlug };
}

function getAgentDailyTimeline(email, byShift, shiftStartHour, shiftEndHour, targetMonth, prebuiltIndex, metricFilter) {
  return withDashboardReadContext_(() => getAgentDailyTimelineImpl_(email, byShift, shiftStartHour, shiftEndHour, targetMonth, prebuiltIndex, metricFilter));
}

function getAgentDailyTimelineImpl_(email, byShift, shiftStartHour, shiftEndHour, targetMonth, prebuiltIndex, metricFilter) {
  try {
    if (!requireAllowed()) {
      return { success: false, email: email, days: [], message: 'غير مصرح لك.' };
    }
    const tm = String(targetMonth || '').trim();
    if (tm && tm.toLowerCase() !== 'current' && !isValidMonthFormat(tm)) {
      return { success: false, email: email, days: [], code: ERR.INVALID_MONTH, message: 'صيغة الشهر غير صالحة (المطلوب YYYY-MM).' };
    }
    if (!email) {
      return { success: false, email: email, days: [] };
    }

    // منع ظهور الخط الزمني للوكيل المحظور
    if (isAgentBanned(email)) {
      return { success: true, email: email, days: [] };
    }

    let month = String(targetMonth || '').trim();
    if (!month || month.toLowerCase() === 'current') {
      const idx = getMonthsIndex();
      month = idx.currentMonth || Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM');
    }

    // كاش وضع "حسب اليوم" فقط (عند عدم وجود فلتر مقياس جزئي)
    if (!byShift && !metricFilter) {
      const cached = getCachedAgentTimeline(email, false, month);
      if (cached) {
        return { success: true, email: email, days: cached, month: month };
      }
    }

    const records = readAgentRecordsForMonth(email, month, prebuiltIndex, metricFilter);

    if (records.length === 0) {
      return { success: true, email: email, days: [], month: month };
    }

    // ===== وضع "حسب اليوم" =====
    if (!byShift) {
      const analytics = calculateAnalytics(records, null, 0, null);
      const days = Array.isArray(analytics.timeline) ? analytics.timeline : [];
      if (!metricFilter) setCachedAgentTimeline_(email, days, false, month);
      return { success: true, email: email, days: days, month: month };
    }

    // ===== وضع "حسب الشفت" (استنتاج ذكي من نشاط الوكيل نفسه) =====
    // نقرأ الشهر السابق/التالي (نفس الوكيل فقط) لمعالجة شفتات تعبر الحدود، ثم
    // نستنتج العناقيد/الحدود بياناتيًا. لا نغيّر أي معادلة — فقط تاريخ الـbucket.
    let neighborRecords = [];
    try {
      const prevRecs = readAgentRecordsForMonth(email, _shiftAddMonths_(month, -1), null) || [];
      const nextRecs = readAgentRecordsForMonth(email, _shiftAddMonths_(month, +1), null) || [];
      neighborRecords = prevRecs.concat(nextRecs);
    } catch (e) { neighborRecords = []; }

    const inference = _inferShiftBuckets_(records.concat(neighborRecords));
    const bucketDateResolver = function (rec, row, ri) {
      const mapped = inference.rowShiftDate.get(_shiftRowKey_(rec, ri));
      if (mapped) return mapped;
      // fallback آمن: التاريخ التقويمي (نفس سلوك By Day) عند عدم تأكد الحدودة.
      const ts = extractRowTimestamp(row, rec.header);
      return ts ? ts.slice(0, 10) : null;
    };

    const analytics = calculateAnalytics(records, null, 0, null, bucketDateResolver);
    const days = Array.isArray(analytics.timeline) ? analytics.timeline : [];

    // Temporary diagnostics (aggregate only — no PII/filenames/tickets).
    try {
      console.log(JSON.stringify({ title: 'SHIFT_INFERENCE_DIAG', month: month, uncertain: inference.uncertain, confidence: inference.confidence, method: inference.method, shifts: inference.diagnostics }));
    } catch (e) {}

    return {
      success: true,
      email: email,
      month: month,
      days: days,
      shift: {
        inferred: true,
        uncertain: inference.uncertain,
        confidence: inference.confidence,
        method: inference.method
      },
      shiftDiagnostics: inference.diagnostics
    };
  } catch (err) {
    return {
      success: false,
      email: email,
      days: [],
      error: safeError_(err)
    };
  }
}

/**
 * ============================================================================
 * مخطط المقارنة حسب الوكيل (By Agent) — نفس محرك الحساب، تجميع مختلف فقط.
 * يعيد لكل وكيل قيمة المقياس المطلوب خلال نطاق التاريخ/الشهر المحدد.
 * ============================================================================
 */
const CHART_METRIC_KEYS = ['csat', 'agbt', 'abst', 'idle', 'lateness', 'breakBreach'];

function getAgentsChartCacheVersion() {
  try { return CacheService.getScriptCache().get('CHART_AGENTS_VER') || '0'; } catch (e) { return '0'; }
}

function bumpAgentsChartCacheVersion_() {
  try { CacheService.getScriptCache().put('CHART_AGENTS_VER', String(Date.now()), 21600); } catch (e) {}
}

function clearCachedAgentsChart_() {
  try { bumpAgentsChartCacheVersion_(); } catch (e) {}
}

function getAgentsChartData(metric, startDay, endDay, targetMonth) {
  return withDashboardReadContext_(() => getAgentsChartDataImpl_(metric, startDay, endDay, targetMonth));
}

function getAgentsChartDataImpl_(metric, startDay, endDay, targetMonth) {
  try {
    if (!isCurrentUserAllowed()) {
      return { success: false, agents: [], metric: metric, message: 'غير مصرح لك.' };
    }

    let m = String(metric || 'abst').trim();
    if (CHART_METRIC_KEYS.indexOf(m) === -1) m = 'abst';
    const start = startDay ? String(startDay).slice(0, 10) : '';
    const end = endDay ? String(endDay).slice(0, 10) : '';
    const isoDay = /^\d{4}-\d{2}-\d{2}$/;
    if ((start && !isoDay.test(start)) || (end && !isoDay.test(end)) || (start && end && start > end)) {
      return { success: false, agents: [], metric: m, code: ERR.INVALID_RANGE, message: 'نطاق التاريخ غير صالح.' };
    }

    let month = String(targetMonth || '').trim();
    if (month && month.toLowerCase() !== 'current' && !isValidMonthFormat(month)) {
      return { success: false, agents: [], metric: m, code: ERR.INVALID_MONTH, message: 'صيغة الشهر غير صالحة (المطلوب YYYY-MM).' };
    }
    if (!month || month.toLowerCase() === 'current') {
      const idx = getMonthsIndex();
      month = idx.currentMonth || Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM');
    }

    const cacheVersion = getAgentsChartCacheVersion();
    const chartCacheKey = key => 'CHART_AGENTS_' + cacheVersion + '_' + key + '_' + month + '_' + (start || 'all') + '_' + (end || 'all');
    const cacheKey = chartCacheKey(m);
    try {
      const cachedRaw = CacheService.getScriptCache().get(cacheKey);
      if (cachedRaw) {
        const parsed = JSON.parse(cachedRaw);
        if (parsed && parsed.success) return parsed;
      }
    } catch (e) {}

    const overview = getOverviewData(month);
    if (!overview || overview.success === false) {
      return { success: false, agents: [], metric: m, code: overview && overview.code,
        message: (overview && overview.message) || 'تعذر تحميل ملخص الشهر.' };
    }
    const banned = getBannedAgentsSet();
    const agents = (overview && Array.isArray(overview.agents) ? overview.agents : [])
      .filter(a => !banned.has(String(a.email || '').toLowerCase().trim()));

    // تعداد واحد لمجلد drills للشهر ثم معالجة الوكلاء من الفهرس (يمنع N+1 Folder Scans)
    const drillsIndex = enumerateMonthDrills_(month);

    // calculateAnalytics already computes every metric: reuse this one Drive pass
    // for all metric tabs instead of reopening the same files for each tab.
    const resultsByMetric = {};
    CHART_METRIC_KEYS.forEach(key => { resultsByMetric[key] = []; });
    for (const a of agents) {
      const email = String(a.email || '').trim();
      if (!email) continue;
      let records = [];
      records = readAgentRecordsForMonth(email, month, drillsIndex);
      if (start || end) records = filterRecordsToDateRange(records, start, end);
      const analytics = calculateAnalytics(records);
      let stat = analytics.agentStats[email];
      if (!stat) {
        const k = Object.keys(analytics.agentStats).find(k => k.toLowerCase() === email.toLowerCase());
        if (k) stat = analytics.agentStats[k];
      }
      CHART_METRIC_KEYS.forEach(key => {
        const entry = { email: email, name: a.name || email, value: getAgentMetricValue(stat, key) };
        if (key === 'breakBreach') entry.breaches = (stat && stat.breakBreaches) || 0;
        resultsByMetric[key].push(entry);
      });
    }

    // ترتيب تنازلي حسب القيمة (القيم الفارغة في النهاية)
    CHART_METRIC_KEYS.forEach(key => resultsByMetric[key].sort((x, y) => {
      const vx = (x.value === null || x.value === undefined) ? -Infinity : Number(x.value);
      const vy = (y.value === null || y.value === undefined) ? -Infinity : Number(y.value);
      return vy - vx;
    }));
    const result = resultsByMetric[m];

    const data = {
      success: true,
      metric: m,
      month: month,
      start: start,
      end: end,
      count: result.length,
      agents: result
    };
    try {
      const cache = CacheService.getScriptCache();
      CHART_METRIC_KEYS.forEach(key => {
        const json = JSON.stringify(Object.assign({}, data, { metric: key, agents: resultsByMetric[key] }));
        if (json.length < 90000) cache.put(chartCacheKey(key), json, 600);
      });
    } catch (e) {}
    return data;
  } catch (err) {
    return { success: false, agents: [], metric: metric, message: safeError_(err) };
  }
}

/**
 * ============================================================================
 * 7. بنية القراءة/العرض المقيّدة (Server-Side Pagination Architecture)
 *    لا نرسل أبداً كل الصفوف إلى المتصفح، بل نرسل صفحة صغيرة فقط بعد
 *    الفلترة والترتيب على الخادم. هذا هو الحل لأحجام البيانات الضخمة
 *    (1000+ صف لكل مقياس/موظف أسبوعياً).
 * ============================================================================
 */

function parseTimeValueToSeconds(v) {
  const s = String(v || '').trim();
  if (!s) return 0;
  if (s.indexOf(':') !== -1) {
    const p = s.split(':');
    return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
  }
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n * 60;
}

function getAgentDrillPageFromSheet(email, metric, opts) {
  return withDashboardReadContext_(() => getAgentDrillPageFromSheetImpl_(email, metric, opts));
}

function getAgentDrillPageFromSheetImpl_(email, metric, opts) {
  if (!requireAllowed()) {
    return { success: false, found: false, email: email, metric: (metric || 'csat').toLowerCase(), header: [], rows: [], total: 0, page: 0, pageSize: 50, totalPages: 1, count: 0, message: 'غير مصرح لك.' };
  }
  opts = opts || {};
  const page = Math.max(0, parseInt(opts.page, 10) || 0);
  const pageSize = Math.min(500, Math.max(10, parseInt(opts.pageSize, 10) || 50));
  const search = String(opts.search || '').toLowerCase().trim();
  const datePreset = opts.datePreset || 'all';
  const csatScore = opts.csatScore || 'all';
  const channel = opts.channel || 'all';
  const topSessions = opts.topSessions || 'all';
  const targetMetric = (metric || 'csat').toLowerCase();
  const targetMonth = opts.month || opts.targetMonth;

  const detail = getAgentDetailData(email, targetMetric, targetMonth);
  if (!detail || detail.success === false) {
    return { success: false, found: false, header: [], rows: [], code: detail && detail.code,
      message: (detail && detail.message) || 'تعذر تحميل التفاصيل.' };
  }
  if (!detail || !detail.found || !detail.rows || !detail.rows.length) {
    return {
      success: true,
      found: false,
      email: email,
      metric: targetMetric,
      header: detail && detail.header || [],
      rows: [],
      total: 0,
      page: 0,
      pageSize: pageSize,
      totalPages: 1,
      count: 0
    };
  }

  const header = detail.header || [];
  const rows = detail.rows || [];

  const csatIdx = findColIndex(header, 'csat_adjusted', 'csat', 'score');
  const chanIdx = findColIndex(header, 'ticket_channel', 'channel');
  let timeIdx = -1;
  if (targetMetric === 'agbt') {
    timeIdx = findColIndex(header, 'sum_basket_time_for_ticket_per_hour_min_ONLINE_WOMT', 'sum_basket_time_for_ticket_per_hour_min', 'basket_time', 'agbt', 'time');
  } else if (targetMetric === 'abst') {
    timeIdx = findColIndex(header, 'basket_session_time_min', 'session_time', 'basket_session_time', 'abst', 'time');
  }

  const today = Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM-dd');
  const yDate = new Date(); yDate.setDate(yDate.getDate() - 1);
  const yesterday = Utilities.formatDate(yDate, 'Asia/Riyadh', 'yyyy-MM-dd');
  const weekDate = new Date(); weekDate.setDate(weekDate.getDate() - 7);
  const weekStart = Utilities.formatDate(weekDate, 'Asia/Riyadh', 'yyyy-MM-dd');

  let filtered = rows.filter(function (row) {
    // بحث حر عبر أي خلية
    if (search) {
      let hit = false;
      for (let i = 0; i < row.length; i++) {
        if (String(row[i] || '').toLowerCase().indexOf(search) !== -1) { hit = true; break; }
      }
      if (!hit) return false;
    }

    // فلتر CSAT
    if (csatScore !== 'all') {
      const val = csatIdx !== -1 ? String(row[csatIdx] || '').toLowerCase().trim() : '';
      const isGood = (val === 'good' || val === '5' || val === '4' || val === 'positive' || val.indexOf('ممتاز') !== -1 || val.indexOf('جيد') !== -1);
      const isBad = (val === 'bad' || val === '1' || val === '2' || val === 'negative' || val.indexOf('سيء') !== -1);
      if (csatScore === 'good' && !isGood) return false;
      if (csatScore === 'bad' && !isBad) return false;
    }

    // فلتر القناة
    if (channel !== 'all' && chanIdx !== -1) {
      const cellChan = String(row[chanIdx] || '').toLowerCase().trim();
      const filterChan = channel.toLowerCase();
      if (filterChan === 'phone') {
        if (cellChan !== 'phone' && cellChan !== 'voice' && cellChan.indexOf('phone') === -1 && cellChan.indexOf('voice') === -1) return false;
      } else if (cellChan !== filterChan) {
        return false;
      }
    }

    // فلتر التاريخ
    if (datePreset !== 'all') {
      const d = extractRowDate(row, header);
      if (!d) return false;
      if (datePreset === 'today' && d !== today) return false;
      if (datePreset === 'yesterday' && d !== yesterday) return false;
      if (datePreset === 'week' && (d < weekStart || d > today)) return false;
    }

    return true;
  });

  // فلتر أعلى الجلسات (Top N) بعد الفرز التنازلي زمنياً أو الجلسات الطويلة (20m+)
  if (topSessions !== 'all' && timeIdx !== -1) {
    if (topSessions === 'above20' || topSessions === '20m') {
      filtered = filtered.filter(function (row) {
        const secs = parseTimeValueToSeconds(row[timeIdx]);
        if (secs >= 20 * 60) return true;
        if (typeof isLongSessionRow_ === 'function' && isLongSessionRow_(row, header)) return true;
        return false;
      });
    } else {
      filtered.sort(function (a, b) {
        return parseTimeValueToSeconds(b[timeIdx]) - parseTimeValueToSeconds(a[timeIdx]);
      });
      const n = topSessions === 'top5' ? 5 : 10;
      filtered = filtered.slice(0, n);
    }
  }

  // الترتيب العام على عمود محدد (يعمل فوق كل النتائج المفلترة)
  const sortColIdx = (opts.sortColIdx !== undefined && opts.sortColIdx !== null && opts.sortColIdx !== '')
    ? parseInt(opts.sortColIdx, 10)
    : -1;
  const sortAsc = opts.sortAsc !== false;
  if (sortColIdx >= 0) {
    filtered.sort(function (a, b) {
      let va = a[sortColIdx];
      let vb = b[sortColIdx];
      if (typeof va === 'string' && va.indexOf(':') !== -1) {
        va = parseTimeValueToSeconds(va);
        vb = parseTimeValueToSeconds(vb);
      } else if (!isNaN(parseFloat(va)) && String(va).indexOf('#') === -1 && String(va).indexOf('-') === -1 && String(va).indexOf('@') === -1) {
        va = parseFloat(va);
        vb = parseFloat(vb);
      } else {
        va = String(va || '').toLowerCase();
        vb = String(vb || '').toLowerCase();
      }
      if (va < vb) return sortAsc ? -1 : 1;
      if (va > vb) return sortAsc ? 1 : -1;
      return 0;
    });
  }

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const start = safePage * pageSize;
  const pageRows = filtered.slice(start, start + pageSize);

  return {
    success: true,
    found: true,
    email: email,
    metric: targetMetric,
    header: header,
    rows: pageRows,
    total: total,
    page: safePage,
    pageSize: pageSize,
    totalPages: totalPages,
    count: pageRows.length
  };
}

function importDataFromAdminPortal(rawJson, options) {
  try {
    if (!isCurrentUserAdmin()) {
      return { success: false, code: ERR.ADMIN_REQUIRED, message: "غير مصرح لك باستيراد البيانات." };
    }
    options = options || { smartDates: true, updateSummary: true, updateArchive: true };
    if (!rawJson || typeof rawJson !== 'string' || !rawJson.trim()) {
      return { success: false, code: ERR.IMPORT_VALIDATION_FAILED, message: "لم يتم استلام أي نص JSON." };
    }
    if (rawJson.length > IMPORT_MAX_BYTES) {
      logEvent_('IMPORT_FAILURE', { reason: 'PAYLOAD_TOO_LARGE', bytes: rawJson.length, actor: getCurrentUserEmail() });
      return { success: false, code: ERR.IMPORT_VALIDATION_FAILED, message: "حجم الحمولة يتجاوز الحد المسموح." };
    }

    let payload;
    try {
      payload = JSON.parse(rawJson.replace(/^\uFEFF/, ''));
    } catch (e) {
      logEvent_('IMPORT_FAILURE', { reason: ERR.INVALID_JSON, actor: getCurrentUserEmail() });
      return { success: false, code: ERR.INVALID_JSON, message: "تعذر تحليل JSON." };
    }

    const validation = validateImportPayload_(payload);
    if (!validation.ok) {
      logEvent_('IMPORT_FAILURE', { reason: validation.code, detail: validation.error, actor: getCurrentUserEmail() });
      return { success: false, code: validation.code, message: 'حمولة غير صالحة: ' + validation.error };
    }

    const startedAt = new Date().getTime();
    const saveResult = savePayloadToMicroPartitionedDrive_(payload);
    const durationMs = new Date().getTime() - startedAt;

    logEvent_('ADMIN_IMPORT', {
      status: 'SUCCESS',
      month: saveResult.date ? String(saveResult.date).slice(0, 7) : '',
      agents: saveResult.summaryCount || 0,
      drills: saveResult.drillCount,
      tickets: saveResult.ticketsCount,
      failed: saveResult.failedCount || 0,
      durationMs: durationMs,
      actor: getCurrentUserEmail()
    });
    logSystemEvent_("SUCCESS", "Admin Import to Granular Drive",
      `استيراد: (${saveResult.summaryCount || 0}) وكيل، (${saveResult.drillCount}) مقياس، (${saveResult.ticketsCount}) تذكرة.`);

    return {
      success: true,
      agentsCount: saveResult.summaryCount || 0,
      drillCount: saveResult.drillCount,
      ticketsCount: saveResult.ticketsCount,
      failedCount: saveResult.failedCount || 0,
      partial: !!saveResult.partial,
      date: saveResult.date,
      folderUrl: getDriveFolderUrl(),
      message: `تم بنجاح حفظ وتجزئة كل مقياس لكل موظف في ملف مستقل في Google Drive (${saveResult.summaryCount || 0} وكيل، ${saveResult.drillCount} مقياس)!` + ((saveResult.failedCount || 0) > 0 ? ` تنبيه: تعذّر حفظ ${saveResult.failedCount} مقياس.` : '')
    };

  } catch (err) {
    logEvent_('IMPORT_FAILURE', { reason: errorCode_(err), actor: getCurrentUserEmail() });
    logSystemEvent_("ERROR", "Admin Import Failed", String(err && err.message ? err.message : err));
    return {
      success: false,
      code: errorCode_(err),
      message: safeError_(err)
    };
  }
}

function getDriveFolderUrl() {
  if (!requireAdmin()) return "";
  try {
    const folder = getOrCreateDataFolder();
    return folder.getUrl();
  } catch (e) {
    return "";
  }
}

function getSpreadsheetUrl() {
  if (!requireAdmin()) return "";
  try {
    const ss = getTargetSpreadsheet();
    return ss ? ss.getUrl() : "";
  } catch (e) {
    return "";
  }
}

/**
 * ============================================================================
 * إدارة المستخدمين (حظر / إلغاء حظر / حذف) — صلاحيات المدير
 * - الحظر: إخفاء الوكيل من الظهور في الموقع فقط، دون أي تأثير على بياناته
 *          (تستمر عملية الحفظ والتسجيل له بشكل طبيعي).
 * - إلغاء الحظر: إعادة ظهوره فوراً بكامل بياناته.
 * - الحذف: إزالة بيانات الوكيل نهائياً من Drive (يتطلب تأكيداً كتابياً في الواجهة).
 * ============================================================================
 */

const BANNED_FILE_NAME = "banned_agents.json";

function getBannedAgentsSet() {
  return memoDashboardRead_('banned', () => getBannedAgentsSetImpl_());
}

function getBannedAgentsSetImpl_() {
  try {
    const folder = getOrCreateDataFolder();
    const files = folder.getFilesByName(BANNED_FILE_NAME);
    if (files.hasNext()) {
      const content = files.next().getBlob().getDataAsString();
      const arr = JSON.parse(content || '[]');
      return new Set(Array.isArray(arr) ? arr.map(x => String(x).toLowerCase().trim()).filter(Boolean) : []);
    }
  } catch (e) {
    console.warn('getBannedAgentsSet warning:', e.message);
  }
  return new Set();
}

function saveBannedAgentsSet(set) {
  enforceAdmin();
  const folder = getOrCreateDataFolder();
  const content = JSON.stringify(Array.from(set));
  const files = folder.getFilesByName(BANNED_FILE_NAME);
  if (files.hasNext()) {
    files.next().setContent(content);
  } else {
    folder.createFile(BANNED_FILE_NAME, content, MimeType.PLAIN_TEXT);
  }
}

function isAgentBanned(email) {
  return getBannedAgentsSet().has(String(email || '').toLowerCase().trim());
}

function setAgentBanned(email, banned) {
  try {
    if (!isCurrentUserAdmin()) return { success: false, message: 'غير مصرح لك.' };
    const key = String(email || '').toLowerCase().trim();
    if (!key) return { success: false, message: 'Invalid email address.' };
    return withScriptLock_(function () {
    const set = getBannedAgentsSet();
    if (banned) set.add(key); else set.delete(key);
    saveBannedAgentsSet(set);
    clearCachedOverview_();
    clearCachedPeriodTables_();
    clearCachedAgentsChart_();
    logSystemEvent_(banned ? 'WARN' : 'INFO', banned ? 'Ban Agent' : 'Unban Agent',
      `تم ${banned ? 'حظر' : 'إلغاء حظر'} الوكيل (${key})`);
    return { success: true, email: key, banned: !!banned, bannedAgents: Array.from(set) };
    });
  } catch (e) {
    return { success: false, code: errorCode_(e), message: safeError_(e) };
  }
}

function getAllAgentsForAdmin() {
  try {
    if (!isCurrentUserAdmin()) return { success: false, agents: [], bannedAgents: [], message: 'غير مصرح لك.' };
    const overview = getOverviewData();
    const agents = (overview && Array.isArray(overview.agents)) ? overview.agents : [];
    const bannedSet = getBannedAgentsSet();

    // عدّ ملفات المقاييس لكل وكيل من مجلد drills بمطابقة بادئة الـ slug كاملة
    // (أكثر موثوقية من قصّ ما بعد آخر '_' لأنه لا يفترض خلو اسم المقياس من '_')
    const agentsBySlug = new Map();
    agents.forEach(a => {
      const email = String(a.email || '').toLowerCase().trim();
      if (!email) return;
      agentsBySlug.set(getAgentFileSlug(email), email);
    });
    const filesCountBySlug = new Map();
    const drillsFolder = getOrCreateDrillsFolder();
    const files = drillsFolder.getFiles();
    while (files.hasNext()) {
      const name = files.next().getName();
      if (!name.endsWith('.json')) continue;
      let matchedSlug = null;
      for (const slug of agentsBySlug.keys()) {
        if (name.indexOf(slug + '_') === 0 && (!matchedSlug || slug.length > matchedSlug.length)) {
          matchedSlug = slug;
        }
      }
      if (matchedSlug) {
        filesCountBySlug.set(matchedSlug, (filesCountBySlug.get(matchedSlug) || 0) + 1);
      }
    }

    const list = agents.map(a => {
      const email = String(a.email || '').toLowerCase().trim();
      const slug = getAgentFileSlug(email);
      return {
        email: email,
        name: a.name || email,
        banned: bannedSet.has(email),
        metricFiles: filesCountBySlug.get(slug) || 0,
        csat: a.csat,
        rowsCount: a.rowsCount || 0
      };
    });

    return { success: true, agents: list, bannedAgents: Array.from(bannedSet), isCurrentUserPrimaryAdmin: isCurrentUserPrimaryAdmin() };
  } catch (e) {
    return { success: false, code: errorCode_(e), message: safeError_(e), agents: [], bannedAgents: [], isCurrentUserPrimaryAdmin: false };
  }
}

/**
 * ============================================================================
 * إدارة المدراء (Admin Users) — صلاحيات الوصول لصفحة الإدارة
 * ============================================================================
 */
const ADMINS_FILE_NAME = "admin_emails.json";
const PRIMARY_ADMIN_EMAIL = "sultan.alkharmani@tabby.sa";

function getAdminEmailsSet() {
  return memoDashboardRead_('admins', () => getAdminEmailsSetImpl_());
}

function getAdminEmailsSetImpl_() {
  const set = new Set();
  try {
    const folder = getOrCreateDataFolder();
    const files = folder.getFilesByName(ADMINS_FILE_NAME);
    if (files.hasNext()) {
      const content = files.next().getBlob().getDataAsString();
      const arr = JSON.parse(content || '[]');
      if (Array.isArray(arr)) arr.forEach(e => { const k = String(e || '').toLowerCase().trim(); if (k) set.add(k); });
    }
  } catch (e) { console.warn('getAdminEmailsSet warning:', e.message); }
  // ضمان وجود الأدمن الأساسي دائماً
  if (!set.has(PRIMARY_ADMIN_EMAIL)) set.add(PRIMARY_ADMIN_EMAIL);
  // ضمان عدم قفل المشروع على مالك النشر (حساب تنفيذ السكربت)
  try {
    const owner = String(Session.getEffectiveUser().getEmail() || '').toLowerCase().trim();
    if (owner) set.add(owner);
  } catch (e) { /* تجاهل */ }
  return set;
}

function saveAdminEmailsSet(set) {
  enforceAdmin();
  const folder = getOrCreateDataFolder();
  const content = JSON.stringify(Array.from(set));
  const files = folder.getFilesByName(ADMINS_FILE_NAME);
  if (files.hasNext()) files.next().setContent(content);
  else folder.createFile(ADMINS_FILE_NAME, content, MimeType.PLAIN_TEXT);
}

function getCurrentUserEmail() {
  try {
    const email = Session.getActiveUser().getEmail();
    return email || '';
  } catch (e) { return ''; }
}

function isCurrentUserAdmin() {
  const email = getCurrentUserEmail().toLowerCase().trim();
  if (!email) return false;
  return getAdminEmailsSet().has(email);
}

function isCurrentUserPrimaryAdmin() {
  const email = getCurrentUserEmail().toLowerCase().trim();
  if (!email) return false;
  if (email === PRIMARY_ADMIN_EMAIL.toLowerCase().trim()) return true;
  try {
    const owner = String(Session.getEffectiveUser().getEmail() || '').toLowerCase().trim();
    if (owner && email === owner) return true;
  } catch (e) {}
  return false;
}

/**
 * ============================================================================
 * طبقة التصريح المركزية (Centralized Authorization Layer)
 * القرار النهائي دائمًا في السيرفر بناءً على هوية المستخدم الموثوقة من Session.
 * ============================================================================
 */
function requireAdmin() {
  return isCurrentUserAdmin();
}
// تصريح مركزي للقراءات الحسّاسة: admin أو مستخدم ضمن allowed_emails
function requireAllowed() {
  return isCurrentUserAllowed();
}
// رسالة خطأ آمنة للعميل + تسجيل التفاصيل داخليًا فقط (لا نكشف IDs/أسماء ملفات/stack للمتصفح)
function safeError_(err, fallback) {
  const detail = String((err && err.message) ? err.message : (err || ''));
  try { console.warn('ServerError:', detail); } catch (e) {}
  return fallback || 'حدث خطأ غير متوقع. حاول لاحقًا.';
}
// تفرض صلاحية الأدمن أو ترمي خطأ (تُستخدم داخل الدوال الحسّاسة لمنع الاستدعاء المباشر)
function enforceAdmin() {
  if (!requireAdmin()) {
    const err = new Error('UNAUTHORIZED_ADMIN');
    err.unauthorized = true;
    throw err;
  }
  return true;
}

function getAdminsList() {
  try {
    if (!isCurrentUserAdmin()) return { success: false, admins: [], currentUser: getCurrentUserEmail(), isCurrentUserAdmin: false, isCurrentUserPrimaryAdmin: false, message: 'غير مصرح لك.' };
    const set = getAdminEmailsSet();
    return {
      success: true,
      admins: Array.from(set),
      currentUser: getCurrentUserEmail(),
      isCurrentUserAdmin: isCurrentUserAdmin(),
      isCurrentUserPrimaryAdmin: isCurrentUserPrimaryAdmin(),
      primaryAdminEmail: PRIMARY_ADMIN_EMAIL
    };
  } catch (e) {
    return { success: false, code: errorCode_(e), admins: [], currentUser: '', isCurrentUserAdmin: false, isCurrentUserPrimaryAdmin: false, message: safeError_(e) };
  }
}

function addAdminEmail(email) {
  try {
    if (!isCurrentUserAdmin()) return { success: false, message: 'غير مصرح لك.' };
    const key = String(email || '').toLowerCase().trim();
    if (!key || key.indexOf('@') === -1) return { success: false, message: 'إيميل غير صالح.' };
    return withScriptLock_(function () {
      const set = getAdminEmailsSet();
      set.add(key);
      saveAdminEmailsSet(set);
      return { success: true, admins: Array.from(set) };
    });
  } catch (e) { return { success: false, code: errorCode_(e), message: safeError_(e) }; }
}

function removeAdminEmail(email) {
  try {
    if (!isCurrentUserAdmin()) return { success: false, message: 'غير مصرح لك.' };
    const key = String(email || '').toLowerCase().trim();
    if (key === PRIMARY_ADMIN_EMAIL) return { success: false, message: 'لا يمكن حذف الأدمن الأساسي.' };
    return withScriptLock_(function () {
      const set = getAdminEmailsSet();
      set.delete(key);
      saveAdminEmailsSet(set);
      return { success: true, admins: Array.from(set) };
    });
  } catch (e) { return { success: false, code: errorCode_(e), message: safeError_(e) }; }
}

/**
 * ============================================================================
 * إدارة المستخدمين المصرح لهم (Allowed Users) — صلاحية عرض الموقع كاملاً
 * ============================================================================
 */
const ALLOWED_FILE_NAME = "allowed_emails.json";

function getAllowedEmailsSet() {
  return memoDashboardRead_('allowed', () => getAllowedEmailsSetImpl_());
}

function getAllowedEmailsSetImpl_() {
  const set = new Set();
  try {
    const folder = getOrCreateDataFolder();
    const files = folder.getFilesByName(ALLOWED_FILE_NAME);
    if (files.hasNext()) {
      const content = files.next().getBlob().getDataAsString();
      const arr = JSON.parse(content || '[]');
      if (Array.isArray(arr)) arr.forEach(e => { const k = String(e || '').toLowerCase().trim(); if (k) set.add(k); });
    }
  } catch (e) { console.warn('getAllowedEmailsSet warning:', e.message); }
  return set;
}

function saveAllowedEmailsSet(set) {
  enforceAdmin();
  const folder = getOrCreateDataFolder();
  const content = JSON.stringify(Array.from(set));
  const files = folder.getFilesByName(ALLOWED_FILE_NAME);
  if (files.hasNext()) files.next().setContent(content);
  else folder.createFile(ALLOWED_FILE_NAME, content, MimeType.PLAIN_TEXT);
}

function isCurrentUserAllowed() {
  const email = getCurrentUserEmail().toLowerCase().trim();
  if (!email) return false;
  if (isCurrentUserAdmin()) return true; // المدراء مسموح لهم تلقائياً
  return getAllowedEmailsSet().has(email);
}

function getAllowedList() {
  try {
    if (!isCurrentUserAdmin()) return { success: false, allowed: [], currentUser: getCurrentUserEmail(), isCurrentUserAdmin: false, message: 'غير مصرح لك.' };
    const set = getAllowedEmailsSet();
    return {
      success: true,
      allowed: Array.from(set),
      currentUser: getCurrentUserEmail(),
      isCurrentUserAdmin: isCurrentUserAdmin()
    };
  } catch (e) {
    return { success: false, code: errorCode_(e), allowed: [], currentUser: '', isCurrentUserAdmin: false, message: safeError_(e) };
  }
}

function addAllowedEmail(email) {
  try {
    if (!isCurrentUserAdmin()) return { success: false, message: 'غير مصرح لك.' };
    const key = String(email || '').toLowerCase().trim();
    if (!key || key.indexOf('@') === -1) return { success: false, message: 'إيميل غير صالح.' };
    if (getAdminEmailsSet().has(key)) return { success: false, message: 'هذا الإيميل مدير بالفعل (مسموح له تلقائياً).' };
    return withScriptLock_(function () {
      const set = getAllowedEmailsSet();
      set.add(key);
      saveAllowedEmailsSet(set);
      return { success: true, allowed: Array.from(set) };
    });
  } catch (e) { return { success: false, code: errorCode_(e), message: safeError_(e) }; }
}

function removeAllowedEmail(email) {
  try {
    if (!isCurrentUserAdmin()) return { success: false, message: 'غير مصرح لك.' };
    const key = String(email || '').toLowerCase().trim();
    return withScriptLock_(function () {
      const set = getAllowedEmailsSet();
      set.delete(key);
      saveAllowedEmailsSet(set);
      return { success: true, allowed: Array.from(set) };
    });
  } catch (e) { return { success: false, code: errorCode_(e), message: safeError_(e) }; }
}

function getAdminStats() {
  try {
    if (!isCurrentUserAdmin()) return { success: false, totalAgents: 0, totalRows: 0, totalMetrics: 7, worksheet: 'Daily_Summary', message: 'غير مصرح لك.' };
    const overview = getOverviewData();
    const agents = (overview && Array.isArray(overview.agents)) ? overview.agents : [];
    const summary = (overview && overview.summary) ? overview.summary : {};
    return {
      success: true,
      totalAgents: agents.length,
      totalRows: summary.totalDrillRows || 0,
      totalMetrics: 7,
      worksheet: 'Daily_Summary'
    };
  } catch (e) {
    return { success: false, totalAgents: 0, totalRows: 0, totalMetrics: 7, worksheet: 'Daily_Summary' };
  }
}

function deleteAgentData(email) {
  try {
    if (!isCurrentUserPrimaryAdmin()) return { success: false, message: 'عذراً، حذف الوكيل نهائياً متاح فقط للأدمن الأساسي.' };
    const key = String(email || '').toLowerCase().trim();
    if (!key) return { success: false, message: 'Invalid email address.' };

    return withScriptLock_(function () {
    const metricKeys = Object.keys(METRICS_NAMES);
    // أسماء ملفات دقيقة (agent_<slug>_<metric>.json) بدل مطابقة البادئة، لتفادي حذف وكلاء تتشابه أسماؤهم بعد الـslug
    const exactNames = new Set(metricKeys.map(m => getAgentMetricFileSlug(email, m) + '.json'));
    let deletedFiles = 0;

    const purgeDrillsFolder = (drillsFolder) => {
      if (!drillsFolder) return;
      const names = [];
      const it = drillsFolder.getFiles();
      while (it.hasNext()) {
        const f = it.next();
        if (exactNames.has(f.getName())) names.push(f);
      }
      names.forEach(f => {
        try { drillsFolder.removeFile(f); deletedFiles++; } catch (e) { console.warn('removeFile warning:', e.message); }
      });
    };

    // إزالة الوكيل (بمطابقة الإيميل الدقيقة) من ملف ملخص داخل مجلد معيّن
    const purgeSummaryFile = (folder, fileName) => {
      if (!folder || !fileName) return;
      try {
        const files = folder.getFilesByName(fileName);
        if (!files.hasNext()) return;
        const sf = files.next();
        const data = JSON.parse(sf.getBlob().getDataAsString());
        if (data && Array.isArray(data.agents)) {
          const before = data.agents.length;
          data.agents = data.agents.filter(a => String(a.email || '').toLowerCase().trim() !== key);
          if (data.agents.length !== before) {
            if (data.summary) data.summary.totalAgents = data.agents.length;
            sf.setContent(JSON.stringify(data));
          }
        }
      } catch (e) { console.warn('deleteAgentData summary update warning:', e.message); }
    };

    // 1) legacy storage: drills/ + summary.json + summary_overview.json + فهرس التذاكر
    const root = getOrCreateDataFolder();
    purgeDrillsFolder(getOrCreateDrillsFolder());
    purgeSummaryFile(root, CONFIG.SUMMARY_FILE_NAME);
    if (CONFIG.LEGACY_SUMMARY_FILE_NAME && CONFIG.LEGACY_SUMMARY_FILE_NAME !== CONFIG.SUMMARY_FILE_NAME) {
      purgeSummaryFile(root, CONFIG.LEGACY_SUMMARY_FILE_NAME);
    }
    clearTicketSessionsIndex_();

    // 2) جميع الأقسام الشهرية: <month>/drills + <month>/summary.json + مؤشر تذاكر الشهر + كاش الشهر
    const monthKeySet = new Set();
    try {
      const idx = getMonthsIndex();
      (idx.availableMonths || []).forEach(m => monthKeySet.add(m));
      if (idx.currentMonth) monthKeySet.add(idx.currentMonth);
    } catch (e) { /* تجاهل */ }
    // أيضاً أي مجلد شهر موجود على Drive حتى لو لم يكن في الفهرس (اتساق)
    try {
      const diskFolders = root.getFolders();
      while (diskFolders.hasNext()) {
        const nm = diskFolders.next().getName();
        if (isValidMonthFormat(nm)) monthKeySet.add(nm);
      }
    } catch (e) { /* تجاهل */ }
    const monthKeys = Array.from(monthKeySet);

    monthKeys.forEach(monthKey => {
      if (!isValidMonthFormat(monthKey)) return;
      const mFolder = getMonthFolder(root, monthKey, false);
      if (mFolder) {
        const dFolders = mFolder.getFoldersByName(CONFIG.DRILLS_FOLDER_NAME || "drills");
        if (dFolders.hasNext()) purgeDrillsFolder(dFolders.next());
        purgeSummaryFile(mFolder, CONFIG.SUMMARY_FILE_NAME);
        clearTicketSessionsIndex_(monthKey);
        clearCachedOverview_(monthKey);
      }
      // إبطال كاش السجلات (MRC) حتى لا يُعيد الاستيراد التالي صفوف الوكيل المحذوف
      try {
        const cache = CacheService.getScriptCache();
        metricKeys.forEach(m => cache.remove('MRC_' + monthKey + '_' + getAgentMetricFileSlug(email, m) + '.json'));
      } catch (e) { /* تجاهل */ }
    });

    // 3) إزالة من قائمة الحظر + إبطال الكاش (شامل مفاتيح أشهر الملخص)
    const set = getBannedAgentsSet();
    set.delete(key);
    saveBannedAgentsSet(set);
    clearCachedOverview_();
    clearCachedPeriodTables_();
    clearCachedAgentsChart_();
    clearCachedAgentTimeline_(email);

    logSystemEvent_('WARN', 'Delete Agent Data',
      `تم حذف بيانات الوكيل (${email}) نهائياً — عدد الملفات المحذوفة: ${deletedFiles}`);

    return { success: true, email: key, deletedFiles: deletedFiles };
    });
  } catch (e) {
    return { success: false, code: errorCode_(e), message: safeError_(e) };
  }
}

/**
 * ============================================================================
 * جداول الأسبوعي والشهري (Weekly / Monthly Pivot) — جدول تقاطعي:
 * الصفوف = الوكلاء، الأعمدة = الفترات (أسابيع أو شهور)، الخلية = قيمة المقياس.
 * ============================================================================
 */

function buildWeeklyPeriods(lang, targetMonth) {
  const isAr = (lang === 'ar');
  let year, month; // month 0-based
  const m = String(targetMonth || '').trim();
  if (/^\d{4}-\d{2}$/.test(m)) {
    year = parseInt(m.slice(0, 4), 10);
    month = parseInt(m.slice(5, 7), 10) - 1;
  } else {
    const now = new Date();
    year = now.getFullYear();
    month = now.getMonth();
  }
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const periods = [];
  let w = 1;
  for (let start = 1; start <= daysInMonth; start += 7) {
    const end = Math.min(start + 6, daysInMonth);
    periods.push({ key: 'W' + w, label: isAr ? ('أسبوع ' + w) : ('Week ' + w), range: start + '-' + end, year: year, month: month + 1, startDay: start, endDay: end });
    w++;
  }
  return periods;
}

function buildMonthlyPeriods(count) {
  const periods = [];
  const now = new Date();
  const n = (count || 6);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const mo = d.getMonth() + 1;
    periods.push({ key: y + '-' + String(mo).padStart(2, '0'), label: y + '-' + String(mo).padStart(2, '0'), range: '', year: y, month: mo });
  }
  return periods;
}

function periodKeyForDay(dayStr, type, periods) {
  if (!dayStr) return null;
  const parts = String(dayStr).split('-');
  if (parts.length < 3) return null;
  const y = parseInt(parts[0], 10);
  const mo = parseInt(parts[1], 10);
  const dd = parseInt(parts[2], 10);
  if (isNaN(y) || isNaN(mo) || isNaN(dd)) return null;
  if (type === 'monthly') {
    return periods.some(p => p.year === y && p.month === mo) ? (y + '-' + String(mo).padStart(2, '0')) : null;
  }
  const p = periods.find(pp => pp.year === y && pp.month === mo && dd >= pp.startDay && dd <= pp.endDay);
  return p ? p.key : null;
}

function computePeriodValue(agg, m) {
  if (!agg) return null;
  if (m === 'csat') {
    const total = agg.csatGood + agg.csatBad;
    if (total <= 0) return null;
    return Math.round((agg.csatGood / total) * 1000) / 10;
  }
  if (m === 'abst') {
    return agg.abstCount > 0 ? Math.round((agg.abstSum / agg.abstCount) * 10) / 10 : null;
  }
  if (m === 'sessions') {
    return agg.sessions;
  }
  return null;
}

function metricLabelForPeriod(m, lang) {
  const isAr = (lang === 'ar');
  if (m === 'abst') return isAr ? 'ABST (دقيقة)' : 'ABST (min)';
  if (m === 'sessions') return 'Sessions';
  return 'CSAT %';
}

function getAgentsPeriodTable(metric, periodType, lang, targetMonth) {
  return withDashboardReadContext_(() => getAgentsPeriodTableImpl_(metric, periodType, lang, targetMonth));
}

function getAgentsPeriodTableImpl_(metric, periodType, lang, targetMonth) {
  try {
    if (!requireAllowed()) {
      return { success: false, message: 'غير مصرح لك.', agents: [], periods: [] };
    }
    const m = (metric || 'csat').toLowerCase();
    const type = (periodType || 'weekly').toLowerCase();
    const langKey = (lang === 'ar') ? 'ar' : 'en';
    const monthKey = String(targetMonth || '').trim();
    if (monthKey && monthKey.toLowerCase() !== 'current' && !isValidMonthFormat(monthKey)) {
      return { success: false, code: ERR.INVALID_MONTH, message: 'صيغة الشهر غير صالحة (المطلوب YYYY-MM).', agents: [], periods: [] };
    }

    // استرداد سريع من الكاش (يمنع إعادة قراءة كل ملفات Drive في كل مرة)
    const cacheKey = 'PERIOD_TABLE_' + m + '_' + type + '_' + langKey + (monthKey ? '_' + monthKey : '');
    try {
      const cachedRaw = CacheService.getScriptCache().get(cacheKey);
      if (cachedRaw) {
        const parsed = JSON.parse(cachedRaw);
        if (parsed && parsed.success) return parsed;
      }
    } catch (e) { /* تجاهل أخطاء الكاش */ }

    const overview = getDashboardDataFromSheet(targetMonth);
    if (!overview || overview.success === false) {
      return { success: false, agents: [], periods: [], code: overview && overview.code,
        message: (overview && overview.message) || 'تعذر تحميل ملخص الشهر.' };
    }
    const agents = (overview && Array.isArray(overview.agents)) ? overview.agents : [];
    const periods = (type === 'monthly') ? buildMonthlyPeriods(6) : buildWeeklyPeriods(lang, targetMonth);

    // تعداد واحد لمجلد drills للشهر المحدد ثم استخدامه لكل الوكلاء (يمنع N+1 Folder Scans)
    let indexMonth = monthKey;
    if (!isValidMonthFormat(indexMonth)) {
      try { const idx = getMonthsIndex(); indexMonth = idx.currentMonth || Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM'); }
      catch (e) { indexMonth = Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM'); }
    }
    const drillsIndex = enumerateMonthDrills_(indexMonth);

    const metricFilter = (m === 'csat') ? 'csat' : ((m === 'abst' || m === 'sessions') ? 'abst' : null);
    const rows = [];
    for (const a of agents) {
      const tl = getAgentDailyTimeline(a.email, false, null, null, targetMonth, drillsIndex, metricFilter);
      if (!tl || tl.success === false) {
        return { success: false, agents: [], periods: [], code: tl && tl.code,
          message: (tl && (tl.message || tl.error)) || 'تعذر تحميل بيانات الوكيل.' };
      }
      const days = (tl && Array.isArray(tl.days)) ? tl.days : [];
      const agg = {};
      for (const d of days) {
        const key = periodKeyForDay(d.day, type, periods);
        if (!key) continue;
        if (!agg[key]) agg[key] = { csatGood: 0, csatBad: 0, abstSum: 0, abstCount: 0, sessions: 0 };
        agg[key].csatGood += Number(d.csatGood) || 0;
        agg[key].csatBad += Number(d.csatBad) || 0;
        agg[key].sessions += Number(d.sessions) || 0;
        const abst = Number(d.abstMins) || 0;
        if (abst > 0) { agg[key].abstSum += abst; agg[key].abstCount++; }
      }
      const values = {};
      for (const p of periods) {
        values[p.key] = computePeriodValue(agg[p.key], m);
      }
      rows.push({ email: a.email, name: a.name || a.email, values: values });
    }

    const result = {
      success: true,
      metric: m,
      periodType: type,
      month: targetMonth || '',
      metricLabel: metricLabelForPeriod(m, lang),
      periods: periods.map(p => ({ key: p.key, label: p.label, range: p.range || '' })),
      agents: rows
    };

    // حفظ النتيجة في الكاش لمدة 30 دقيقة للاسترداد السريع
    try {
      const json = JSON.stringify(result);
      if (json.length < 100000) CacheService.getScriptCache().put(cacheKey, json, 1800);
    } catch (e) { /* تجاهل */ }

    return result;
  } catch (e) {
    return { success: false, code: errorCode_(e), message: safeError_(e), agents: [], periods: [] };
  }
}

function clearCachedPeriodTables_() {
  try {
    const cache = CacheService.getScriptCache();
    // المفاتيح تحتوي لاحقة الشهر (targetMonth) — نمسح جميع الأشهر المتاحة + المفتاح بدون لاحقة
    let monthKeys = [''];
    try {
      const idx = getMonthsIndex();
      monthKeys = monthKeys.concat((idx && idx.availableMonths) || []);
      if (idx && idx.currentMonth && monthKeys.indexOf(idx.currentMonth) === -1) monthKeys.push(idx.currentMonth);
    } catch (e) { /* تجاهل */ }
    ['csat', 'abst', 'sessions'].forEach(function (m) {
      ['weekly', 'monthly'].forEach(function (t) {
        ['en', 'ar'].forEach(function (lang) {
          monthKeys.forEach(function (mk) {
            cache.remove('PERIOD_TABLE_' + m + '_' + t + '_' + lang + (mk ? '_' + mk : ''));
          });
        });
      });
    });
  } catch (e) { /* تجاهل */ }
}

// ============================================================================
// AGBT Contribution Attribution (تحليل مساهمة الوكيل في وقت التكت)
// ============================================================================

const TICKET_SESSIONS_INDEX_FILE = "ticket_sessions_index.json";
const AGBT_MATCH_TOLERANCE_MIN = 2; // الفرق المسموح (بالدقائق) بين مجموع الجلسات وقيمة sum_basket قبل اعتبار البيانات ناقصة

function findTicketIdCol(header) {
  return findColIndex(header, 'ticket_id', 'ticket id', 'session_id', 'session id', 'ticket_number', 'ticket number', 'ticket');
}

function findSessionMinsCol(header) {
  return findColIndex(header, 'basket_session_time_min', 'basket_session_time', 'session_time_min', 'session_time', 'abst', 'time');
}

function buildTicketSessionsIndex_(targetMonth) {
  let drillsFolder = null;
  if (targetMonth && isValidMonthFormat(targetMonth)) {
    const mf = getMonthFolder(null, targetMonth, false);
    if (mf) {
      const sub = mf.getFoldersByName(CONFIG.DRILLS_FOLDER_NAME);
      if (sub.hasNext()) drillsFolder = sub.next();
    }
  }
  if (!drillsFolder) {
    drillsFolder = getOrCreateDrillsFolder();
  }

  const files = drillsFolder.getFiles();
  const index = {};

  while (files.hasNext()) {
    const f = files.next();
    const name = f.getName();
    if (!name || name.indexOf('.json') === -1 || name.indexOf('_abst') === -1) continue;
    try {
      const content = f.getBlob().getDataAsString();
      if (!content || !content.trim()) continue;
      const rec = JSON.parse(content);
      if (!rec || !Array.isArray(rec.rows)) continue;
      const email = String(rec.agent || '').trim();
      if (!email) continue;
      const header = Array.isArray(rec.header) ? rec.header : [];
      const ticketCol = findTicketIdCol(header);
      const minsCol = findSessionMinsCol(header);
      if (ticketCol === -1 || minsCol === -1) continue;

      for (const row of rec.rows) {
        if (!Array.isArray(row)) continue;
        const ticketId = String(row[ticketCol] || '').trim();
        const mins = parseFloat(row[minsCol]);
        if (!ticketId || isNaN(mins)) continue;
        const eKey = email.toLowerCase();
        if (!index[ticketId]) index[ticketId] = {};
        if (!index[ticketId][eKey]) index[ticketId][eKey] = { email: email, mins: 0 };
        index[ticketId][eKey].mins += mins;
      }
    } catch (e) { /* تجاهل الملفات التالفة */ }
  }
  return index;
}

function getTicketSessionsIndex_(forceRebuild, targetMonth) {
  let folder = getOrCreateDataFolder();
  let fileName = TICKET_SESSIONS_INDEX_FILE;
  if (targetMonth && isValidMonthFormat(targetMonth)) {
    const mf = getMonthFolder(folder, targetMonth, false);
    if (mf) {
      folder = mf;
      fileName = 'ticket_sessions_' + targetMonth + '.json';
    }
  }

  const existing = folder.getFilesByName(fileName);
  let targetFile = existing.hasNext() ? existing.next() : null;

  if (!forceRebuild && targetFile) {
    const ageMs = new Date().getTime() - targetFile.getLastUpdated().getTime();
    if (ageMs < 30 * 60 * 1000) {
      try {
        const content = targetFile.getBlob().getDataAsString();
        if (content && content.trim()) return JSON.parse(content);
      } catch (e) { /* إعادة البناء */ }
    }
  }

  const index = buildTicketSessionsIndex_(targetMonth);
  try {
    const json = JSON.stringify(index);
    if (json.length < 5 * 1024 * 1024) {
      if (targetFile) targetFile.setContent(json);
      else folder.createFile(fileName, json, MimeType.PLAIN_TEXT);
    }
  } catch (e) { /* تجاهل أخطاء الكاش */ }

  return index;
}

function clearTicketSessionsIndex_(targetMonth) {
  try {
    let folder = getOrCreateDataFolder();
    let fileName = TICKET_SESSIONS_INDEX_FILE;
    if (targetMonth && isValidMonthFormat(targetMonth)) {
      const mf = getMonthFolder(folder, targetMonth, false);
      if (mf) {
        folder = mf;
        fileName = 'ticket_sessions_' + targetMonth + '.json';
      }
    }
    const files = folder.getFilesByName(fileName);
    while (files.hasNext()) files.next().setTrashed(true);
  } catch (e) { /* تجاهل */ }
}

function getAgentsNameMap(targetMonth) {
  if (!requireAllowed()) return {};
  const map = {};
  try {
    const overview = getOverviewData(targetMonth);
    const agents = (overview && Array.isArray(overview.agents)) ? overview.agents : [];
    for (const a of agents) {
      const email = String(a.email || a.agent || '').trim();
      if (email) map[email.toLowerCase()] = String(a.name || '').trim() || email.split('@')[0];
    }
  } catch (e) { /* تجاهل */ }
  return map;
}

function getAgbtTicketAttribution(email, ticketIds, baseMins, targetMonth) {
  try {
    if (!requireAllowed()) {
      return { success: false, email: String(email || ''), items: [], message: 'غير مصرح لك.' };
    }
    const agentEmail = String(email || '').trim();
    const ids = Array.isArray(ticketIds) ? ticketIds.map(String) : [];
    const baseArr = Array.isArray(baseMins) ? baseMins.map(function (v) {
      const n = parseFloat(v);
      return isNaN(n) ? null : Math.round(n * 100) / 100;
    }) : [];
    if (!agentEmail || ids.length === 0) {
      return { success: true, email: agentEmail, items: [] };
    }

    const index = getTicketSessionsIndex_(false, targetMonth);
    const aKey = agentEmail.toLowerCase();
    const items = [];

    for (let i = 0; i < ids.length; i++) {
      const tid = ids[i].trim();
      const baseNum = (i < baseArr.length) ? baseArr[i] : null;
      const entry = index[tid];
      if (!entry) {
        items.push({ ticketId: tid, baseMins: baseNum, totalMins: 0, agentMins: 0, agentPct: null, isMainCause: false, contributorCount: 0, dataIncomplete: true });
        continue;
      }

      let totalMins = 0, topMins = 0, topEmail = '', agentMins = 0, contributors = 0;
      for (const eKey in entry) {
        const m = entry[eKey].mins;
        if (!(m > 0)) continue;
        totalMins += m;
        contributors++;
        if (m > topMins) { topMins = m; topEmail = entry[eKey].email; }
        if (eKey === aKey) agentMins = m;
      }

      totalMins = Math.round(totalMins * 100) / 100;
      agentMins = Math.round(agentMins * 100) / 100;

      // النسبة تُحسب مقابل الرقم الأساسي (sum_basket) وليس مقابل مجموع الجلسات
      const agentPct = (baseNum !== null && baseNum !== undefined && baseNum > 0)
        ? Math.round((agentMins / baseNum) * 1000) / 10
        : null;

      // تُعتبر البيانات ناقصة إذا اختلف مجموع الجلسات عن الرقم الأساسي بأكثر من دقيقتين
      const dataIncomplete = (baseNum === null || baseNum === undefined || Math.abs(totalMins - baseNum) > AGBT_MATCH_TOLERANCE_MIN);

      items.push({
        ticketId: tid,
        baseMins: baseNum,
        totalMins: totalMins,
        agentMins: agentMins,
        agentPct: agentPct,
        isMainCause: agentMins > 0 && topEmail.toLowerCase() === aKey,
        contributorCount: contributors,
        dataIncomplete: dataIncomplete
      });
    }

    return { success: true, email: agentEmail, items: items };
  } catch (e) {
    return { success: false, code: errorCode_(e), email: String(email || ''), items: [], message: safeError_(e) };
  }
}

function getAgbtTicketDetails(ticketId, baseMins, targetMonth) {
  try {
    if (!requireAllowed()) {
      return { success: false, ticketId: String(ticketId || ''), agents: [], message: 'غير مصرح لك.' };
    }
    const tid = String(ticketId || '').trim();
    if (!tid) return { success: false, ticketId: tid, agents: [], message: 'No ticket id' };

    const parsedBase = parseFloat(baseMins);
    const baseNum = isNaN(parsedBase) ? null : Math.round(parsedBase * 100) / 100;

    const index = getTicketSessionsIndex_(false, targetMonth);
    const entry = index[tid];
    const nameMap = getAgentsNameMap(targetMonth);
    const agents = [];
    let summedTotal = 0;

    if (entry) {
      let topMins = 0;
      for (const eKey in entry) {
        const m = entry[eKey].mins;
        if (!(m > 0)) continue;
        summedTotal += m;
        if (m > topMins) topMins = m;
      }
      summedTotal = Math.round(summedTotal * 100) / 100;

      for (const eKey in entry) {
        const m = entry[eKey].mins;
        if (!(m > 0)) continue;
        const aEmail = entry[eKey].email;
        agents.push({
          email: aEmail,
          name: nameMap[aEmail.toLowerCase()] || aEmail.split('@')[0],
          mins: Math.round(m * 100) / 100,
          pct: (baseNum !== null && baseNum > 0) ? Math.round((m / baseNum) * 1000) / 10 : null,
          isMainCause: m === topMins
        });
      }
      agents.sort(function (a, b) { return b.mins - a.mins; });
    }

    const dataIncomplete = (baseNum === null || baseNum === undefined || Math.abs(summedTotal - baseNum) > AGBT_MATCH_TOLERANCE_MIN);

    return {
      success: true,
      ticketId: tid,
      baseMins: baseNum,
      totalMins: summedTotal,
      contributorCount: agents.length,
      dataIncomplete: dataIncomplete,
      agents: agents
    };
  } catch (e) {
    return { success: false, code: errorCode_(e), ticketId: String(ticketId || ''), agents: [], message: safeError_(e) };
  }
}

/**
 * ============================================================================
 * 8. أداة الترحيل الآمن إلى المعمارية الشهرية المستقلة (Zero-Loss Migration)
 *    تقرأ الملفات الحالية في drills/ القديم وتوزع السجلات بحسب YYYY-MM في مجلدات
 *    الشهور المستقلة وتولد summary.json و meta.json وفهرس الشهور meta/months.json
 * ============================================================================
 */
function migrateExistingDataToMonthlyPartitions() {
  if (!isCurrentUserPrimaryAdmin()) {
    return { success: false, message: "عذراً، تشغيل ترحيل المعمارية محصور بالأدمن الأساسي فقط." };
  }

  const parentFolder = getOrCreateDataFolder();
  const legacyDrills = getOrCreateDrillsFolder();
  const files = legacyDrills.getFiles();

  const recordsByMonth = {};
  let totalFilesScanned = 0;
  let totalRowsScanned = 0;
  const fallbackMonth = Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM');

  while (files.hasNext()) {
    const file = files.next();
    const name = file.getName();
    if (!name.endsWith('.json')) continue;
    totalFilesScanned++;

    try {
      const content = file.getBlob().getDataAsString();
      if (!content || !content.trim()) continue;
      const rec = JSON.parse(content);
      const normalized = normalizeRecord(rec, 0, name);
      totalRowsScanned += (normalized.rows || []).length;

      const header = normalized.header || [];
      const rowBuckets = {};

      (normalized.rows || []).forEach(row => {
        const d = extractRowDate(row, header);
        const mKey = (d && /^\d{4}-\d{2}/.test(d)) ? d.substring(0, 7) : fallbackMonth;
        if (!rowBuckets[mKey]) rowBuckets[mKey] = [];
        rowBuckets[mKey].push(row);
      });

      const mKeys = Object.keys(rowBuckets);
      if (mKeys.length === 0) {
        if (!recordsByMonth[fallbackMonth]) recordsByMonth[fallbackMonth] = [];
        recordsByMonth[fallbackMonth].push(normalized);
      } else {
        mKeys.forEach(mKey => {
          if (!recordsByMonth[mKey]) recordsByMonth[mKey] = [];
          recordsByMonth[mKey].push(Object.assign({}, normalized, { rows: rowBuckets[mKey] }));
        });
      }
    } catch (e) {
      console.warn("Migration record error for " + name + ":", e.message);
    }
  }

  const createdMonths = Object.keys(recordsByMonth).sort();
  const nowStr = Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM-dd HH:mm:ss');

  for (const monthKey of createdMonths) {
    const monthFolder = getOrCreateMonthFolder(parentFolder, monthKey);
    const monthDrillsFolder = getOrCreateMonthDrillsFolder(monthFolder);
    const monthRecs = recordsByMonth[monthKey];

    const agentMetricMap = new Map();
    for (const rec of monthRecs) {
      const key = `${rec.agent.toLowerCase()}::${rec.metric.toLowerCase()}`;
      if (!agentMetricMap.has(key)) agentMetricMap.set(key, []);
      agentMetricMap.get(key).push(rec);
    }

    const allMonthRecords = [];
    let monthRowCount = 0;

    for (const [key, recs] of agentMetricMap.entries()) {
      const [agentEmail, metric] = key.split('::');
      const fileName = getAgentMetricFileSlug(agentEmail, metric) + ".json";
      const merged = mergeRecords([], recs);
      const finalRec = merged.records[0];

      if (finalRec) {
        finalRec.month = monthKey;
        finalRec.savedAt = nowStr;
        allMonthRecords.push(finalRec);
        monthRowCount += finalRec.rows.length;

        const fileJson = JSON.stringify(finalRec);
        const existingF = monthDrillsFolder.getFilesByName(fileName);
        if (existingF.hasNext()) {
          existingF.next().setContent(fileJson);
        } else {
          monthDrillsFolder.createFile(fileName, fileJson, MimeType.PLAIN_TEXT);
        }
      }
    }

    // حساب إحصائيات الشهر وبناء summary.json
    const monthAnalytics = calculateAnalytics(allMonthRecords);
    const finalAgentsList = monthAnalytics.uniqueAgents.map(em => {
      const st = monthAnalytics.agentStats[em] || {};
      // نستخدم نفس حقول agentStats الفعلية (agbtDisplay/abstAvg/idleHours) ونفس دلالات الملخص العادي
      return {
        email: em,
        name: em.split('@')[0].replace(/\./g, ' '),
        csat: (st.hasCsat && st.csatPct !== null && st.csatPct !== undefined) ? st.csatPct : null,
        csatGood: st.csatGood || 0,
        csatBad: st.csatBad || 0,
        csatTotal: st.csatTotal || 0,
        agbt: (st.hasAgbt && st.agbtDisplay) ? st.agbtDisplay : null,
        abst: (st.hasAbst && st.abstAvg) ? st.abstAvg : null,
        breakBreach: st.hasBreak ? String(st.breakBreaches) : null,
        lateness: st.hasLateness ? st.latenessMins : null,
        idle: (st.hasIdle && st.idleHours !== null && st.idleHours !== undefined) ? String(st.idleHours) : null,
        productivity: null,
        recordsCount: st.recordsCount || 0,
        rowsCount: st.rowsCount || 0,
        updatedAt: Utilities.formatDate(new Date(), 'Asia/Riyadh', 'HH:mm')
      };
    });

    const monthSummaryObj = {
      version: CONFIG.SCHEMA_VERSION || 1,
      month: monthKey,
      success: true,
      lastSync: nowStr,
      summary: {
        totalAgents: finalAgentsList.length,
        avgCsat: monthAnalytics.csat.pct !== null ? monthAnalytics.csat.pct + '%' : '—',
        totalLateness: (monthAnalytics.lateness.totalMins || 0) + 'm',
        totalBreaches: String(monthAnalytics.breakBreach.breaches || 0),
        totalSessions: monthAnalytics.totalSessions,
        totalLongSessions: monthAnalytics.totalLongSessions,
        avgDailySessions: monthAnalytics.avgDailySessions,
        activeDays: monthAnalytics.activeDays,
        totalDrillRows: monthRowCount,
        lastSync: Utilities.formatDate(new Date(), 'Asia/Riyadh', 'HH:mm'),
        totalMetrics: 7
      },
      overview: {
        csatPct: monthAnalytics.csat.pct,
        agbtAvg: monthAnalytics.agbt.avg,
        breakBreaches: monthAnalytics.breakBreach.breaches,
        latenessMins: monthAnalytics.lateness.totalMins,
        idleHours: monthAnalytics.idle.totalHours,
        totalSessions: monthAnalytics.totalSessions
      },
      agents: finalAgentsList,
      historicalDays: monthAnalytics.timeline || [],
      byDay: monthAnalytics.timeline || []
    };

    const sJson = JSON.stringify(monthSummaryObj);
    const sFiles = monthFolder.getFilesByName(CONFIG.SUMMARY_FILE_NAME || "summary.json");
    if (sFiles.hasNext()) sFiles.next().setContent(sJson);
    else monthFolder.createFile(CONFIG.SUMMARY_FILE_NAME || "summary.json", sJson, MimeType.PLAIN_TEXT);

    // كتابة meta.json
    const metaObj = {
      month: monthKey,
      rowCount: monthRowCount,
      lastUpdated: nowStr,
      schemaVersion: CONFIG.SCHEMA_VERSION || 1,
      status: "ready"
    };
    const mFiles = monthFolder.getFilesByName(CONFIG.META_FILE_NAME || "meta.json");
    if (mFiles.hasNext()) mFiles.next().setContent(JSON.stringify(metaObj));
    else monthFolder.createFile(CONFIG.META_FILE_NAME || "meta.json", JSON.stringify(metaObj), MimeType.PLAIN_TEXT);

    updateMonthsIndex_(monthKey);
    setCachedOverview_(monthSummaryObj, monthKey);
  }

  // عمل نسخة احتياطية آمنة لمجلد drills السابق دون حذفه
  try {
    const backupName = "_backup_legacy_drills_" + Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyyMMdd_HHmmss');
    legacyDrills.setName(backupName);
  } catch (e) {
    console.warn("Could not rename legacy drills folder:", e.message);
  }

  clearCachedOverview_();

  return {
    success: true,
    filesScanned: totalFilesScanned,
    rowsScanned: totalRowsScanned,
    createdMonths: createdMonths
  };
}

/**
 * ============================================================================
 * Phase 3 — Admin-only recovery: إعادة بناء summary.json + meta.json لشهر محدد
 * من ملفات drills/ الفعلية. لا تمس الأشهر الأخرى. للأدمن الأساسي فقط.
 * ============================================================================
 */
// ============================================================================
// REBUILD TIMEOUT GUARD  (NOT a cursor / checkpoint / resumable mechanism)
// ----------------------------------------------------------------------------
// Protection against Apps Script execution timeout for month-wide rebuilds.
// - Baseline measured by the real GAS stress benchmark (160 files):
//     average Drive read ≈ 428.9 ms/file ; slowest observed ≈ 973 ms/file.
// - These numbers are NOT guarantees; a conservative safety factor is applied
//   (REBUILD_EST_READ_MS_PER_FILE = 650 ms ≈ 1.5x the average, still below the
//   slowest observed) and live elapsed time + EWMA are used as the primary guard.
// - REBUILD_TIME_BUDGET_MS is kept conservative so it fits under the shortest
//   documented Apps Script runtime limit (~6 min) with margin for overruns,
//   WITHOUT assuming any longer (Workspace) runtime. Raise it manually only if
//   the executing account is known to have a longer limit.
// - If preflight estimates the month is too large → return REBUILD_TOO_LARGE
//   before reading any drill content and before any write.
// - If the safety budget is reached mid-run → abort cleanly with no writes
//   (no summary.json / meta.json / cache changes); the existing summary stands.
// - A run that aborts must be re-executed after reducing the workload or raising
//   the budget; it does NOT resume from where it stopped.
// - TIMEOUT protection only.
//   Large-month memory pressure remains a known limitation (MEMORY RISK open).
// ============================================================================
// REBUILD KNOWN LIMITATIONS  (documentation only — do not "fix" silently)
// 1. Rebuild is single-execution and non-resumable.
// 2. Timeout Guard protects execution time only.
// 3. Preflight is intentionally conservative.
// 4. Large-month memory pressure remains unresolved.
// 5. getAgentsChartData and getAgentsPeriodTable remain WATCH.
// 6. Do not change calculateAnalytics for rebuild optimization without an
//    explicit parity-tested design.
// ============================================================================
const REBUILD_TIME_BUDGET_MS = 220 * 1000;      // conservative wall-clock budget (see note above)
const REBUILD_EST_READ_MS_PER_FILE = 650;       // ≈1.5x measured avg, below slowest
const REBUILD_EST_ENUM_MS_PER_FILE = 10;        // measured ≈7.05, rounded up
const REBUILD_EST_PARSE_MS_PER_FILE = 1;        // measured ≈0.64, rounded up
const REBUILD_EST_COMPUTE_MS_PER_FILE = 5;      // measured ≈3.64, rounded up
const REBUILD_FIXED_OVERHEAD_MS = 5000;         // folder lookup + summary/meta write + slack
const REBUILD_EWMA_ALPHA = 0.3;                 // live read-time EWMA weight

function _rebuildEstimateMs_(fileCount) {
  const perFile = REBUILD_EST_READ_MS_PER_FILE + REBUILD_EST_ENUM_MS_PER_FILE +
    REBUILD_EST_PARSE_MS_PER_FILE + REBUILD_EST_COMPUTE_MS_PER_FILE;
  return REBUILD_FIXED_OVERHEAD_MS + (Math.max(0, fileCount) * perFile);
}

function rebuildMonthSummaryFromDrills(targetMonth) {
  try {
    if (!isCurrentUserPrimaryAdmin()) {
      return { success: false, code: ERR.PRIMARY_ADMIN_REQUIRED, message: 'متاح للأدمن الأساسي فقط.' };
    }
    const month = String(targetMonth || '').trim();
    if (!isValidMonthFormat(month)) {
      return { success: false, code: ERR.INVALID_MONTH, message: 'صيغة الشهر غير صالحة (المطلوب YYYY-MM).' };
    }
    const parentFolder = getOrCreateDataFolder();
    const mFolder = getMonthFolder(parentFolder, month, false);
    if (!mFolder) return { success: false, code: ERR.FILE_NOT_FOUND, message: 'لا يوجد مجلد لهذا الشهر.' };
    const dFolders = mFolder.getFoldersByName(CONFIG.DRILLS_FOLDER_NAME || 'drills');
    if (!dFolders.hasNext()) return { success: false, code: ERR.FILE_NOT_FOUND, message: 'لا توجد ملفات drills لهذا الشهر.' };

    const drillsFolder = dFolders.next();

    // ===== REBUILD TIMEOUT GUARD =====
    // تعداد مقابض الملفات فقط (بدون قراءة محتوى وبدون أي كتابة بعد).
    const drillFiles = [];
    const files = drillsFolder.getFiles();
    while (files.hasNext()) {
      const f = files.next();
      if (f.getName().endsWith('.json')) drillFiles.push(f);
    }

    // Preflight: نرفض الشهر الكبير قبل قراءة أي drill وقبل أي write.
    const fileCount = drillFiles.length;
    const estimatedMs = _rebuildEstimateMs_(fileCount);
    if (estimatedMs > REBUILD_TIME_BUDGET_MS) {
      logEvent_('REBUILD', {
        status: 'REJECTED', code: 'REBUILD_TOO_LARGE', month: month,
        fileCount: fileCount, filesProcessed: 0, elapsedMs: 0,
        estimatedMs: estimatedMs, budgetMs: REBUILD_TIME_BUDGET_MS
      });
      return {
        success: false, code: 'REBUILD_TOO_LARGE', month: month,
        fileCount: fileCount, estimatedMs: estimatedMs, budgetMs: REBUILD_TIME_BUDGET_MS
      };
    }

    // Mid-run guard: زمن منقضٍ فعلي + EWMA لزمن القراءة.
    const guardStart = Date.now();
    let ewmaReadMs = null;
    let filesProcessed = 0;

    const records = [];
    let rowCount = 0;
    for (let i = 0; i < drillFiles.length; i++) {
      const f = drillFiles[i];
      const elapsed = Date.now() - guardStart;
      const perFileRead = (ewmaReadMs === null) ? REBUILD_EST_READ_MS_PER_FILE : ewmaReadMs;
      const projected = elapsed + perFileRead + REBUILD_EST_PARSE_MS_PER_FILE + REBUILD_EST_COMPUTE_MS_PER_FILE;
      if (elapsed >= REBUILD_TIME_BUDGET_MS || projected > REBUILD_TIME_BUDGET_MS) {
        logEvent_('REBUILD', {
          status: 'ABORTED', code: 'REBUILD_TIMEOUT_GUARD', month: month,
          fileCount: fileCount, filesProcessed: filesProcessed, elapsedMs: elapsed,
          estimatedMs: estimatedMs, budgetMs: REBUILD_TIME_BUDGET_MS
        });
        // لا كتابة إطلاقًا: summary.json / meta.json / cache تبقى كما هي.
        return {
          success: false, code: 'REBUILD_TIMEOUT_GUARD', month: month,
          fileCount: fileCount, filesProcessed: filesProcessed,
          elapsedMs: elapsed, estimatedMs: estimatedMs, budgetMs: REBUILD_TIME_BUDGET_MS
        };
      }

      const readStart = Date.now();
      try {
        const content = f.getBlob().getDataAsString();
        const readMs = Date.now() - readStart;
        ewmaReadMs = (ewmaReadMs === null) ? readMs : (REBUILD_EWMA_ALPHA * readMs + (1 - REBUILD_EWMA_ALPHA) * ewmaReadMs);
        if (content && content.trim()) {
          const rec = normalizeRecord(JSON.parse(content), 0, f.getName());
          records.push(rec);
          rowCount += (rec.rows || []).length;
        }
      } catch (e) { /* تجاهل ملف تالف */ }
      filesProcessed++;
    }

    if (records.length === 0) return { success: false, code: ERR.CONSISTENCY_ERROR, message: 'تعذر قراءة ملفات drills.' };

    const monthAnalytics = calculateAnalytics(records);
    const nowStr = Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM-dd HH:mm:ss');
    const finalAgentsList = monthAnalytics.uniqueAgents.map(em => {
      const st = monthAnalytics.agentStats[em] || {};
      return {
        email: em,
        name: em.split('@')[0].replace(/\./g, ' '),
        csat: (st.hasCsat && st.csatPct !== null && st.csatPct !== undefined) ? st.csatPct : null,
        csatGood: st.csatGood || 0,
        csatBad: st.csatBad || 0,
        csatTotal: st.csatTotal || 0,
        agbt: (st.hasAgbt && st.agbtDisplay) ? st.agbtDisplay : null,
        abst: (st.hasAbst && st.abstAvg) ? st.abstAvg : null,
        breakBreach: st.hasBreak ? String(st.breakBreaches) : null,
        lateness: st.hasLateness ? st.latenessMins : null,
        idle: (st.hasIdle && st.idleHours !== null && st.idleHours !== undefined) ? String(st.idleHours) : null,
        productivity: null,
        recordsCount: st.recordsCount || 0,
        rowsCount: st.rowsCount || 0,
        updatedAt: Utilities.formatDate(new Date(), 'Asia/Riyadh', 'HH:mm')
      };
    });

    let sumCsat = 0, countCsat = 0, sumLateness = 0, sumBreaches = 0;
    finalAgentsList.forEach(a => {
      if (a.csat > 0) { sumCsat += a.csat; countCsat++; }
      sumLateness += (parseFloat(a.lateness) || 0);
      sumBreaches += (parseInt(a.breakBreach, 10) || 0);
    });
    const teamAvgCsat = monthAnalytics.csat.pct !== null ? `${monthAnalytics.csat.pct}%` : (countCsat > 0 ? `${Math.round((sumCsat / countCsat) * 10) / 10}%` : "—");
    const teamTotalLateness = monthAnalytics.lateness.totalMins > 0 ? `${monthAnalytics.lateness.totalMins}` : `${Math.round(sumLateness)}`;
    const teamTotalBreaches = monthAnalytics.breakBreach.breaches > 0 ? `${monthAnalytics.breakBreach.breaches}` : `${sumBreaches}`;

    const monthSummaryObj = {
      version: CURRENT_SCHEMA_VERSION,
      month: month,
      success: true,
      lastSync: nowStr,
      summary: {
        totalAgents: finalAgentsList.length,
        avgCsat: teamAvgCsat,
        totalLateness: teamTotalLateness,
        totalBreaches: teamTotalBreaches,
        totalSessions: monthAnalytics.totalSessions,
        totalLongSessions: monthAnalytics.totalLongSessions,
        avgDailySessions: monthAnalytics.avgDailySessions,
        activeDays: monthAnalytics.activeDays,
        totalDrillRows: rowCount,
        lastSync: Utilities.formatDate(new Date(), 'Asia/Riyadh', 'HH:mm'),
        totalMetrics: 7
      },
      overview: {
        csatPct: monthAnalytics.csat.pct,
        agbtAvg: monthAnalytics.agbt.avg,
        breakBreaches: monthAnalytics.breakBreach.breaches,
        latenessMins: monthAnalytics.lateness.totalMins,
        idleHours: monthAnalytics.idle.totalHours,
        totalSessions: monthAnalytics.totalSessions
      },
      agents: finalAgentsList,
      historicalDays: monthAnalytics.timeline || [],
      byDay: monthAnalytics.timeline || []
    };

    const summaryJsonStr = JSON.stringify(monthSummaryObj);
    const sFiles = mFolder.getFilesByName(CONFIG.SUMMARY_FILE_NAME || 'summary.json');
    if (sFiles.hasNext()) sFiles.next().setContent(summaryJsonStr);
    else mFolder.createFile(CONFIG.SUMMARY_FILE_NAME || 'summary.json', summaryJsonStr, MimeType.PLAIN_TEXT);

    const metaObj = { month: month, rowCount: rowCount, lastUpdated: nowStr, schemaVersion: CURRENT_SCHEMA_VERSION, status: 'rebuilt' };
    const metaJson = JSON.stringify(metaObj);
    const mFiles = mFolder.getFilesByName(CONFIG.META_FILE_NAME || 'meta.json');
    if (mFiles.hasNext()) mFiles.next().setContent(metaJson);
    else mFolder.createFile(CONFIG.META_FILE_NAME || 'meta.json', metaJson, MimeType.PLAIN_TEXT);

    clearCachedOverview_(month);
    logEvent_('REBUILD', { status: 'SUCCESS', month: month, drills: records.length, rows: rowCount, actor: getCurrentUserEmail() });
    return { success: true, month: month, drills: records.length, rows: rowCount };
  } catch (err) {
    logEvent_('REBUILD', { status: 'FAILURE', reason: errorCode_(err), actor: getCurrentUserEmail() });
    return { success: false, code: errorCode_(err), message: safeError_(err) };
  }
}

function logSystemEvent_(type, action, details) {
  // Structured observability event (بدون تفاصيل/PII) — يعمل حتى بدون Google Sheet
  logEvent_('SYSTEM_LOG', { level: type, action: action });
  try {
    const ss = getTargetSpreadsheet();
    if (!ss) return;
    let logSheet = ss.getSheetByName(CONFIG.SHEET_LOGS);
    if (!logSheet) {
      logSheet = ss.insertSheet(CONFIG.SHEET_LOGS);
      logSheet.setRightToLeft(true);
      logSheet.appendRow(["الوقت والتاريخ", "النوع", "الحدث", "التفاصيل"]);
      logSheet.getRange("A1:D1").setFontWeight("bold").setBackground("#334155").setFontColor("#fff");
      logSheet.setFrozenRows(1);
    }
    const now = Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM-dd HH:mm:ss');
    const safeDetails = String(details || "").substring(0, 2000);
    logSheet.appendRow([now, type, action, safeDetails]);
  } catch (e) {
    console.warn("Log writing failed:", e);
  }
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
