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

const CONFIG = {
  // اسم المجلد الرئيسي في Google Drive
  DRIVE_FOLDER_NAME: "Agent_Performance_Hub_Data",

  // ملف الملخص الإحصائي السريع والمخصص للشاشة الرئيسية
  SUMMARY_FILE_NAME: "summary_overview.json",

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

function extractRowDate(row, header) {
  if (!row || !header) return null;
  const h = header.map(c => String(c).toLowerCase().trim());
  const priorityNames = [
    'day',
    'report_dt',
    'ticket_creation_date',
    'date_resolved_dubai',
    'created_at_dubai',
    'csat_submitted_at_dubai',
    'shift_date',
    'plan_shift_start',
    'fact_shift_start',
    'call_start_date',
    'date'
  ];
  for (const name of priorityNames) {
    const idx = h.findIndex(c => c === name || c.includes(name));
    if (idx !== -1 && row[idx]) {
      const str = String(row[idx]).trim();
      const m = str.match(/\b\d{4}-\d{2}-\d{2}\b/);
      if (m) return m[0];
      const dmy = str.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/);
      if (dmy) {
        return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
      }
      const dt = new Date(str);
      if (!isNaN(dt.getTime()) && dt.getFullYear() > 2000) {
        return dt.toISOString().slice(0, 10);
      }
    }
  }
  for (let idx = 0; idx < h.length; idx++) {
    const col = h[idx];
    if (col.includes('date') || col.includes('day') || col.includes('dt') || col.includes('time') || col.includes('start')) {
      const str = String(row[idx] || '').trim();
      const m = str.match(/\b\d{4}-\d{2}-\d{2}\b/);
      if (m) return m[0];
    }
  }
  return null;
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
      const existingKeys = new Set(target.rows.map(r => rowKey(r, target.header)));
      let addedCount = 0;
      let skippedCount = 0;

      for (const row of incoming.rows) {
        const alignedRow = alignRowColumns(row, incoming.header, target.header);
        const key = rowKey(alignedRow, target.header);
        if (existingKeys.has(key)) {
          skippedCount++;
        } else {
          existingKeys.add(key);
          target.rows.push(alignedRow);
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
      let isBreakBreached = false;
      let rowBreakExceed = 0;
      for (const bIdx of breakCols) {
        const val = String(row[bIdx] ?? '').trim();
        const lower = val.toLowerCase();
        if (lower === 'not met' || lower === 'breached' || lower.includes('breach')) {
          isBreakBreached = true;
        }
        const parsed = parseFloat(val);
        if (!isNaN(parsed) && parsed > 0) {
          rowBreakExceed = Math.max(rowBreakExceed, parsed);
          isBreakBreached = true;
        }
      }
      if (isBreakBreached) {
        breakBreachCount++;
        breakExceedMinsSum += rowBreakExceed;
      }
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
 * تصفية السجلات لإبقاء صفوف الشهر الحالي فقط (للعرض الحالي، دون المساس بالبيانات الأصلية).
 * تُستخدم في بناء الملخص بحيث تتصفّر الأرقام عند دخول شهر جديد بينما تبقى الداتا بيز كاملة.
 */
function filterRecordsToCurrentMonth(records) {
  const now = new Date();
  const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  return records.map(rec => {
    const header = rec.header || [];
    const rows = (rec.rows || []).filter(row => {
      const d = extractRowDate(row, header);
      return d && String(d).slice(0, 7) === ym;
    });
    return Object.assign({}, rec, { rows: rows });
  }).filter(rec => (rec.rows || []).length > 0);
}

function calculateAnalytics(records, agentFilter = null) {
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
    const idleColIdx = findColIndex(h, 'time_not_working_h_shift_adjusted', 'time_not_working_h', 'idle_time', 'idle', 'not_working');

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
    let agAgbtSum = 0, agAgbtCount = 0;
    for (const r of agRecs.filter(r => r.metric === 'agbt')) {
      const h = (r.header || []).map(c => String(c).toLowerCase().trim());
      const aIdx = findColIndex(h, 'sum_basket_time_for_ticket_per_hour_min_ONLINE_WOMT', 'sum_basket_time_for_ticket_per_hour_min', 'basket_time', 'agbt', 'time');
      for (const row of r.rows || []) {
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
    let agAbstSum = 0, agAbstCount = 0;
    for (const r of agRecs.filter(r => r.metric === 'abst')) {
      const h = (r.header || []).map(c => String(c).toLowerCase().trim());
      const sIdx = findColIndex(h, 'basket_session_time_min', 'session_time', 'basket_session_time', 'abst', 'time');
      for (const row of r.rows || []) {
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
      const iIdx = findColIndex(h, 'time_not_working_h_shift_adjusted', 'time_not_working_h', 'idle_time', 'idle', 'not_working');
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

    agentStats[ag] = {
      agent: ag,
      recordsCount: agRecs.length,
      rowsCount: agRows,
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
      breakBreaches: agBreak.breaches,
      breakExceedMins: agBreak.exceedMins,
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

    for (const row of r.rows || []) {
      const day = extractRowDate(row, r.header);
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
      agbtSecs: entry.agbtCount > 0 ? Math.round((entry.agbtTotalMins / entry.agbtCount) * 60) : 0,
      longSessions: entry.longSessions,
      long: entry.longSessions,
      csatPct: csatPctDaily,
      csat: csatPctDaily !== null ? Math.round(csatPctDaily) : 0,
      csatGood: entry.csatGood,
      csatBad: entry.csatBad,
      csatTotal: entry.csatTotal,
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

  if (openAdmin) {
    try {
      return HtmlService.createHtmlOutputFromFile('Admin')
        .setTitle('Admin Portal — استيراد وحفظ البيانات | Google Drive DB')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
        .addMetaTag('viewport', 'width=device-width, initial-scale=1');
    } catch (errAdmin) {
      // احتياطي
    }
  }

  const template = HtmlService.createTemplateFromFile('Index');
  template.initialData = JSON.stringify({
    title: "Agent Dashboard | لوحة أداء الوكلاء",
    timestamp: new Date().toISOString(),
    openAdmin: openAdmin
  });

  return template.evaluate()
    .setTitle(openAdmin ? 'Admin Portal — استيراد وحفظ البيانات' : 'Agent Dashboard — لوحة أداء الوكلاء')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return ContentService.createTextOutput(JSON.stringify({ 
        success: false, 
        message: "لا توجد بيانات مستلمة في الطلب." 
      })).setMimeType(ContentService.MimeType.JSON);
    }

    const payload = JSON.parse(e.postData.contents.replace(/^\uFEFF/, ''));
    const saveResult = savePayloadToMicroPartitionedDrive(payload);

    const logMsg = `مزامنة تجزئة دقيقة لـ Drive: (${saveResult.summaryCount}) وكيل ملخص، و (${saveResult.drillCount}) مقياس، و (${saveResult.ticketsCount}) تذكرة لتاريخ ${saveResult.date}.`;
    logSystemEvent("SUCCESS", "Extension Sync to Granular Drive", logMsg);

    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      summaryCount: saveResult.summaryCount,
      drillCount: saveResult.drillCount,
      ticketsCount: saveResult.ticketsCount,
      date: saveResult.date,
      message: `تم حفظ وتجزئة كل مقياس لكل موظف بنجاح في Google Drive! (${saveResult.summaryCount} وكيل، ${saveResult.drillCount} مقياس)`
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    logSystemEvent("ERROR", "doPost Failed", err.message);
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: err.message
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * ============================================================================
 * 3. إدارة المجلدات والتخزين بالتجزئة الدقيقة في Google Drive
 * ============================================================================
 */

function getOrCreateDataFolder() {
  const folderName = CONFIG.DRIVE_FOLDER_NAME || "Agent_Performance_Hub_Data";
  const folders = DriveApp.getFoldersByName(folderName);
  if (folders.hasNext()) {
    return folders.next();
  }
  return DriveApp.createFolder(folderName);
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

// الذاكرة المؤقتة السريعة (CacheService)
function getCachedOverview() {
  try {
    const cache = CacheService.getScriptCache();
    const cached = cache.get("SUMMARY_OVERVIEW_DATA");
    if (cached) return JSON.parse(cached);
  } catch (e) {
    console.warn("Cache read warning:", e);
  }
  return null;
}

function setCachedOverview(overviewObj) {
  try {
    const cache = CacheService.getScriptCache();
    const jsonStr = JSON.stringify(overviewObj);
    if (jsonStr.length < 95000) {
      cache.put("SUMMARY_OVERVIEW_DATA", jsonStr, 21600); // 6 ساعات
    }
  } catch (e) {
    console.warn("Cache write warning:", e);
  }
}

function clearCachedOverview() {
  try {
    CacheService.getScriptCache().remove("SUMMARY_OVERVIEW_DATA");
  } catch (e) {}
}

/**
 * كاش سريع للسجلات المطبّعة لكل ملف مقياس (agent_metric.json).
 * يمنع إعادة قراءة وتطبيع ملف Drive الضخم في كل مزامنة (توفير كبير في مسار الكتابة).
 */
function getCachedMetricRecord(fileName) {
  try {
    const raw = CacheService.getScriptCache().get('MRC_' + fileName);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.warn('Metric record cache read warning:', e);
  }
  return null;
}

function setCachedMetricRecord(fileName, record) {
  try {
    const s = JSON.stringify(record);
    if (s.length < 90000) {
      CacheService.getScriptCache().put('MRC_' + fileName, s, 21600); // 6 ساعات
    }
  } catch (e) {
    console.warn('Metric record cache write warning:', e);
  }
}

function clearCachedMetricRecord(fileName) {
  try {
    CacheService.getScriptCache().remove('MRC_' + fileName);
  } catch (e) {}
}

/**
 * ============================================================================
 * 4. حفظ وتجزئة كل مقياس لكل موظف في ملف مستقل مع التحليل الرياضي الشامل
 * ============================================================================
 */
function savePayloadToMicroPartitionedDrive(payload, rebuildSummary) {
  // rebuildSummary: عند false نكتب ملفات المقاييس فقط بدون إعادة بناء الملخص
  // (يُستخدم في الاستيراد المجزأ للأجزاء غير النهائية لتسريع الكتابة الهائلة)
  rebuildSummary = rebuildSummary !== false;

  const dateStr = payload.date || Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM-dd');
  const nowStr = Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM-dd HH:mm:ss');
  const parentFolder = getOrCreateDataFolder();
  const drillsFolder = getOrCreateDrillsFolder();

  // قفل شامل لعملية الكتابة: يمنع تزامن مزامنتين على ملف المقياس وعلى ملف الملخص معاً
  const writeLock = LockService.getScriptLock();
  try {
    writeLock.waitLock(40000);
  } catch (lockErr) {
    // إذا تعذر الحصول على القفل نستمر بشكل غير مثالي لكن لا نجهض الاستيراد
    console.warn("Write lock acquire warning:", lockErr && lockErr.message);
  }

  // استخراج وتطبيع السجلات الواردة بدقة
  const rawResults = payload.results || (Array.isArray(payload) && payload[0]?.metric ? payload : (payload.header ? [payload] : []));
  const incomingNormalized = [];

  rawResults.forEach((res, idx) => {
    try {
      incomingNormalized.push(normalizeRecord(res, idx, payload.fileName || 'PAYLOAD'));
    } catch (e) {
      console.warn(`Record normalization warning at index ${idx}:`, e.message);
    }
  });

  // جمع كافة السجلات الحالية من ملفات المقاييس المحدثة لحساب الإحصائيات التراكمية
  const allUpdatedRecords = [];
  let drillCount = 0;
  let ticketsCount = 0;

  // خريطة لتجميع السجلات حسب (agent + metric)
  const incomingMap = new Map();
  for (const rec of incomingNormalized) {
    const key = `${rec.agent.toLowerCase()}::${rec.metric.toLowerCase()}`;
    if (!incomingMap.has(key)) incomingMap.set(key, []);
    incomingMap.get(key).push(rec);
  }

  // معالجة وحفظ كل مقياس في ملف مستقل: drills/agent_{slug}_{metric}.json
  for (const [key, recs] of incomingMap.entries()) {
    const [agentEmail, metric] = key.split('::');
    const fileName = getAgentMetricFileSlug(agentEmail, metric) + ".json";

    try {
      let targetFile = null;
      const existingFiles = drillsFolder.getFilesByName(fileName);
      if (existingFiles.hasNext()) targetFile = existingFiles.next();

      // قراءة من كاش سريع أولاً لتجنب إعادة فتح/قراءة ملف Drive الضخم
      let existingRecord = getCachedMetricRecord(fileName);
      if (!existingRecord && targetFile) {
        try {
          const content = targetFile.getBlob().getDataAsString();
          if (content && content.trim()) {
            existingRecord = normalizeRecord(JSON.parse(content), 0, fileName);
            setCachedMetricRecord(fileName, existingRecord);
          }
        } catch (e) {
          console.warn(`Failed reading existing metric file ${fileName}:`, e);
        }
      }

      // دمج السجلات مع منع التكرار (Deduplication)
      const merged = existingRecord ? mergeRecords([existingRecord], recs) : mergeRecords([], recs);
      const finalRecord = merged.records[0];

      if (finalRecord) {
        finalRecord.date = dateStr;
        finalRecord.savedAt = nowStr;
        allUpdatedRecords.push(finalRecord);
        drillCount++;
        ticketsCount += finalRecord.rows.length;

        const fileJson = JSON.stringify(finalRecord);
        if (targetFile) {
          targetFile.setContent(fileJson);
        } else {
          drillsFolder.createFile(fileName, fileJson, MimeType.PLAIN_TEXT);
        }
        // تحديث الكاش بعد الكتابة حتى يكون متسقاً مع الملف
        setCachedMetricRecord(fileName, finalRecord);
      }
    } catch (metricErr) {
      // عزل الخطأ: لا نسمح بفشل مقياس واحد بإجهاض عملية الاستيراد بالكامل
      console.warn(`Metric save failed for ${fileName}:`, metricErr && metricErr.message);
    }
  }

  // إذا كانت هناك ملفات مقاييس أخرى مخزنة سابقاً في مجلد drills لم يتم إرسالها في هذا الطلب،
  // نقرأها لتضمينها في الإحصائيات التراكمية العامة
  const existingDrillFiles = drillsFolder.getFiles();
  const processedKeys = new Set(incomingMap.keys());

  while (existingDrillFiles.hasNext()) {
    const dFile = existingDrillFiles.next();
    const dName = dFile.getName();
    if (!dName.endsWith('.json')) continue;

    const isAlreadyProcessed = allUpdatedRecords.some(r => getAgentMetricFileSlug(r.agent, r.metric) + '.json' === dName);
    if (!isAlreadyProcessed) {
      try {
        // استخدام كاش السجل لتجنب إعادة تطبيع ملفات Drive المُخزَّنة سابقاً
        let cached = getCachedMetricRecord(dName);
        if (cached) {
          allUpdatedRecords.push(cached);
          continue;
        }
        const content = dFile.getBlob().getDataAsString();
        if (content && content.trim()) {
          const parsed = normalizeRecord(JSON.parse(content), 0, dName);
          allUpdatedRecords.push(parsed);
          setCachedMetricRecord(dName, parsed);
        }
      } catch (e) {}
    }
  }

  // وضع التجزئة غير النهائي: نكتب الملفات فقط ونعود فوراً دون إعادة بناء الملخص الثقيل
  if (!rebuildSummary) {
    try { writeLock.releaseLock(); } catch (e) {}
    return {
      success: true,
      partial: true,
      drillCount: drillCount,
      ticketsCount: ticketsCount,
      date: dateStr
    };
  }

  // 5. تشغيل المحرك الرياضي الشامل المعتمد لحساب كافة مؤشرات الفريق والوكلاء
  const analytics = calculateAnalytics(allUpdatedRecords);
  // ملخص الشهر الحالي فقط للعرض (الأرقام تتصفّر بدخول شهر جديد دون حذف أي بيانات)
  const monthAnalytics = calculateAnalytics(filterRecordsToCurrentMonth(allUpdatedRecords));

  // قراءة الملخص السابق إن وجد للاحتفاظ ببيانات الوكلاء والمقاييس السابقة وعدم تصفيرها
  let existingOverview = null;
  const summaryFiles = parentFolder.getFilesByName(CONFIG.SUMMARY_FILE_NAME);
  let targetSummaryFile = null;
  if (summaryFiles.hasNext()) {
    targetSummaryFile = summaryFiles.next();
    try {
      const exContent = targetSummaryFile.getBlob().getDataAsString();
      if (exContent && exContent.trim()) {
        existingOverview = JSON.parse(exContent);
      }
    } catch (e) {
      console.warn("Failed reading existing summary_overview.json:", e);
    }
  }

  // دمج الأسماء الصريحة والمقاييس الأساسية الواردة في payload.agents مع الملخص السابق
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

  // جمع كافة إيميلات الوكلاء (سواء لديهم ملفات تفصيلية أو مسجلين في بطاقات الملخص)
  const allAgentEmailsSet = new Set([
    ...analytics.uniqueAgents.map(e => e.toLowerCase()),
    ...Object.keys(metaMap)
  ]);

  // بناء مصفوفة الوكلاء النهائية للشاشة الرئيسية مع الحفاظ التام على المقاييس
  const finalAgentsList = Array.from(allAgentEmailsSet).map(emLower => {
    const origEmail = analytics.uniqueAgents.find(e => e.toLowerCase() === emLower) || (metaMap[emLower] && metaMap[emLower].email) || emLower;
    const agStat = monthAnalytics.agentStats[origEmail] || monthAnalytics.agentStats[emLower] || {};
    const meta = metaMap[emLower] || {};

    let displayName = meta.name || '';
    if (!displayName) {
      displayName = origEmail.split('@')[0].replace(/\./g, ' ');
    }

    // CSAT: الأولوية لملف التفصيل إذا وُجد، وإلا استخدام قيمة الملخص
    let csatVal = 0;
    if (agStat.hasCsat && agStat.csatPct !== null) {
      csatVal = agStat.csatPct;
    }

    // AGBT: الأولوية للملف التفصيلي الفعلي، وإلا الحفاظ التام على بطاقة الملخص
    let agbtVal = "00:00";
    if (agStat.hasAgbt && agStat.agbtDisplay) {
      agbtVal = agStat.agbtDisplay;
    }

    // ABST: الأولوية للملف التفصيلي الفعلي، وإلا الحفاظ التام على بطاقة الملخص
    let abstVal = "00:00";
    if (agStat.hasAbst && agStat.abstAvg) {
      abstVal = agStat.abstAvg;
    }

    // Break Breach: الأولوية لتفاصيل البريك، وإلا استخدام قيمة الملخص
    let breakVal = "0";
    if (agStat.hasBreak && agStat.breakBreaches !== undefined) {
      breakVal = String(agStat.breakBreaches);
    }

    // Lateness: الأولوية لتفاصيل التأخير، وإلا استخدام قيمة الملخص
    let latenessVal = 0;
    if (agStat.hasLateness && agStat.latenessMins !== undefined) {
      latenessVal = agStat.latenessMins;
    }

    // Idle: الأولوية للملف التفصيلي، وإلا استخدام قيمة الملخص
    let idleVal = "0";
    if (agStat.hasIdle && agStat.idleHours !== null && agStat.idleHours !== undefined) {
      idleVal = String(agStat.idleHours);
    }

    // الإنتاجية Productivity
    const prodVal = String(meta.productivity || "0%");

    return {
      date: dateStr,
      name: displayName,
      email: origEmail,
      csat: csatVal,
      agbt: agbtVal,
      abst: abstVal,
      breakBreach: breakVal,
      lateness: latenessVal,
      idle: idleVal,
      productivity: prodVal,
      recordsCount: agStat.recordsCount || 0,
      rowsCount: agStat.rowsCount || 0,
      updatedAt: Utilities.formatDate(new Date(), 'Asia/Riyadh', 'HH:mm')
    };
  });

  // حساب إجماليات ومتوسطات الفريق الفعلية عبر كافة الوكلاء
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

  // دمج الأيام التاريخية مع الحفاظ على الأيام السابقة
  const timelineMap = new Map();
  if (existingOverview && Array.isArray(existingOverview.historicalDays)) {
    existingOverview.historicalDays.forEach(d => {
      if (d && d.day) timelineMap.set(d.day, d);
    });
  }
  analytics.timeline.forEach(t => {
    timelineMap.set(t.day, {
      day: t.day,
      displayDay: t.displayDay,
      sessions: t.sessions,
      abstMins: t.abstMins || (t.abstSecs ? Math.round(t.abstSecs / 60 * 10) / 10 : 0),
      abstSecs: t.abstSecs || 0,
      agbtMins: t.agbtSecs ? Math.round(t.agbtSecs / 60 * 10) / 10 : 0,
      agbtSecs: t.agbtSecs || 0,
      csat: t.csat || 0,
      csatGood: t.csatGood || 0,
      csatBad: t.csatBad || 0,
      csatTotal: t.csatTotal || 0,
      long: t.long || 0
    });
  });
  const mergedHistoricalDays = Array.from(timelineMap.values()).sort((a, b) => a.day.localeCompare(b.day));

  // بناء ملف الملخص العام summary_overview.json
  const overviewData = {
    version: 4,
    lastUpdated: nowStr,
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
    agents: finalAgentsList,
    historicalDays: mergedHistoricalDays
  };

  // حفظ ملف summary_overview.json الصغير وتحديث كاش الذاكرة
  const summaryJsonStr = JSON.stringify(overviewData);
  if (targetSummaryFile) {
    targetSummaryFile.setContent(summaryJsonStr);
  } else {
    parentFolder.createFile(CONFIG.SUMMARY_FILE_NAME, summaryJsonStr, MimeType.PLAIN_TEXT);
  }

  clearCachedOverview();
  setCachedOverview(overviewData);

  // إبطال كاش الخط الزمني لكل وكيل حتى لا تبقى أرقام قديمة بعد حفظ بيانات جديدة
  try {
    incomingMap.forEach((recs, key) => {
      const agentEmail = key.split('::')[0];
      if (agentEmail) clearCachedAgentTimeline(agentEmail);
    });
  } catch (cacheErr) {
    console.warn("Agent timeline cache invalidation warning:", cacheErr.message);
  }

  // مزامنة اختيارية لـ Google Sheet (الملخص فقط بدون تذاكر)
  try {
    syncSummaryToGoogleSheetIfConfigured(overviewData.agents, dateStr);
  } catch (sheetErr) {
    console.warn("Sheet summary sync skipped or failed:", sheetErr.message);
  }

  try { writeLock.releaseLock(); } catch (e) {}

  return {
    success: true,
    partial: false,
    summaryCount: finalAgentsList.length,
    drillCount: drillCount,
    ticketsCount: ticketsCount,
    date: dateStr
  };
}

/**
 * استيراد مجزأ (Chunked Import) للبيانات الضخمة:
 * يستقبل جزءاً من النتائج ورقم الجزء، ويكتب المقاييس فقط في الأجزاء
 * غير النهائية، ويعيد بناء الملخص مرة واحدة في الجزء الأخير.
 * يمنع تجاوز حدود حجم الطلب الواحد ويسرّع إضافة آلاف الصفوف.
 */
function importDataChunkFromAdminPortal(rawJsonOrResults, chunkIndex, totalChunks) {
  let results = rawJsonOrResults;
  try {
    if (typeof rawJsonOrResults === 'string') {
      const obj = JSON.parse(rawJsonOrResults.replace(/^\uFEFF/, ''));
      results = obj.results || obj;
    }
  } catch (e) {
    return { success: false, message: "تعذر تحليل جزء البيانات." };
  }

  const idx = parseInt(chunkIndex, 10);
  const total = parseInt(totalChunks, 10);
  const isFinal = Number.isNaN(idx) || Number.isNaN(total) || (idx + 1) >= total;

  const payload = Array.isArray(results) && (results[0] && results[0].metric)
    ? { results: results }
    : { results: [results] };

  const saveResult = savePayloadToMicroPartitionedDrive(payload, isFinal);

  return {
    success: true,
    final: isFinal,
    chunkIndex: isNaN(idx) ? 0 : idx,
    totalChunks: isNaN(total) ? 1 : total,
    drillCount: saveResult.drillCount,
    ticketsCount: saveResult.ticketsCount,
    summaryCount: saveResult.summaryCount || 0
  };
}

/**
 * ============================================================================
 * 5. قراءة بيانات النظرة العامة للوكلاء — استجابة فورية من الذاكرة أو الملف الخفيف
 * ============================================================================
 */
function getOverviewData() {
  try {
    // 1. فحص كاش الذاكرة المؤقتة السريعة أولاً (< 5 مللي ثانية!)
    const cached = getCachedOverview();
    if (cached && cached.agents && cached.agents.length > 0) {
      return {
        success: true,
        isEmpty: false,
        summary: cached.summary,
        agents: cached.agents,
        historicalDays: cached.historicalDays || []
      };
    }

    // 2. قراءة ملف summary_overview.json الخفيف جداً من Google Drive (< 100ms)
    const parentFolder = getOrCreateDataFolder();
    const files = parentFolder.getFilesByName(CONFIG.SUMMARY_FILE_NAME);

    if (!files.hasNext()) {
      return {
        success: true,
        isEmpty: true,
        agents: [],
        summary: { totalAgents: 0, avgCsat: "—", totalLateness: "—", lastSync: "—", totalDrillRows: 0 },
        historicalDays: [],
        message: "لا توجد بيانات مسجلة في Google Drive حتى الآن. استخدم صفحة الإدارة (Admin) للصق النتائج."
      };
    }

    const content = files.next().getBlob().getDataAsString();
    if (!content || !content.trim()) {
      return {
        success: true,
        isEmpty: true,
        agents: [],
        summary: { totalAgents: 0, avgCsat: "—", totalLateness: "—", lastSync: "—", totalDrillRows: 0 },
        historicalDays: []
      };
    }

    const data = JSON.parse(content);
    setCachedOverview(data);

    return {
      success: true,
      isEmpty: !data.agents || data.agents.length === 0,
      summary: data.summary,
      agents: data.agents || [],
      historicalDays: data.historicalDays || []
    };

  } catch (err) {
    return {
      success: false,
      isEmpty: true,
      agents: [],
      summary: { totalAgents: 0, avgCsat: "—", totalLateness: "—", lastSync: "—", totalDrillRows: 0 },
      historicalDays: [],
      message: "حدث خطأ أثناء قراءة البيانات: " + err.message
    };
  }
}

/**
 * ============================================================================
 * 6. قراءة البيانات التفصيلية — قراءة الملف المخصص حصرياً لهذا المقياس ولهذا الوكيل
 * ============================================================================
 */
function getAgentDetailData(email, metric) {
  try {
    // 1. إذا كان المطلوب "كل الوكلاء" (مقارنة من جدول الملخص الخفيف)
    // منع ظهور الوكيل المحظور نهائياً (الحظر = إخفاء فقط، بياناته تبقى محفوظة)
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
      const overview = getOverviewData();
      const banned = getBannedAgentsSet();
      const visibleAgents = (overview.agents || []).filter(a => !banned.has(String(a.email || '').toLowerCase().trim()));
      return getAllAgentsMetricSummary(visibleAgents, metric);
    }

    // 2. قراءة ملف المقياس المعزول حصرياً للوكيل والمقياس المطلوب فقط
    const drillsFolder = getOrCreateDrillsFolder();
    const targetMetric = (metric || "csat").trim().toLowerCase();
    const fileName = getAgentMetricFileSlug(email, targetMetric) + ".json";
    const files = drillsFolder.getFilesByName(fileName);

    if (!files.hasNext()) {
      return {
        success: true,
        found: false,
        isAllAgents: false,
        email: email,
        metric: targetMetric,
        header: [],
        rows: [],
        count: 0,
        message: `لم يتم العثور على سجلات لمقياس (${targetMetric}) للوكيل (${email}).`
      };
    }

    const content = files.next().getBlob().getDataAsString();
    const drill = JSON.parse(content);

    return {
      success: true,
      found: true,
      isAllAgents: false,
      email: email,
      metric: targetMetric,
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
      error: err.message
    };
  }
}

/**
 * توليد جدول مقارنة جميع الوكلاء لمقياس معين
 */
function getAllAgentsMetricSummary(agentsList, metric) {
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

  const rows = [];
  (agentsList || []).forEach((row, idx) => {
    const name = String(row.name || "").trim();
    const email = String(row.email || "").trim();
    if (!email) return;

    let val = row[m] !== undefined ? row[m] : (row[metric] !== undefined ? row[metric] : "—");
    let displayVal = String(val ?? "—");
    let status = "طبيعي";

    if (m === "csat") {
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
function syncSummaryToGoogleSheetIfConfigured(summaryAgents, dateStr) {
  const ss = getTargetSpreadsheet();
  if (!ss) return;

  let summarySheet = ss.getSheetByName(CONFIG.SHEET_SUMMARY);
  if (!summarySheet) {
    summarySheet = ss.insertSheet(CONFIG.SHEET_SUMMARY);
    summarySheet.setRightToLeft(true);
    summarySheet.appendRow([
      "التاريخ", "اسم الوكيل", "البريد الإلكتروني", "CSAT %", "AGBT", "ABST", 
      "تأخيرات البريك (Break Breach)", "دقائق التأخير (Lateness Mins)", "وقت الخمول (Idle)", "الإنتاجية (Productivity)", "وقت التحديث"
    ]);
    summarySheet.getRange("A1:K1").setFontWeight("bold").setBackground("#1e293b").setFontColor("#ffffff");
    summarySheet.setFrozenRows(1);
  }

  const nowStr = Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM-dd HH:mm:ss');
  const lastRow = summarySheet.getLastRow();
  const summaryEmailMap = {};

  if (lastRow > 1) {
    const emailsData = summarySheet.getRange(2, 3, lastRow - 1, 1).getValues();
    for (let i = 0; i < emailsData.length; i++) {
      const em = String(emailsData[i][0] || "").trim().toLowerCase();
      if (em) summaryEmailMap[em] = i + 2;
    }
  }

  const newSummaryRows = [];

  summaryAgents.forEach(a => {
    const email = String(a.email || "").trim();
    if (!email) return;
    const emLower = email.toLowerCase();
    const rowValues = [
      dateStr,
      a.name || email.split("@")[0],
      email,
      parseFloat(a.csat) || 0,
      String(a.agbt || "00:00"),
      String(a.abst || "00:00"),
      String(a.breakBreach || "0"),
      parseFloat(a.lateness) || 0,
      String(a.idle || "0"),
      String(a.productivity || "0%"),
      nowStr
    ];

    if (summaryEmailMap[emLower]) {
      summarySheet.getRange(summaryEmailMap[emLower], 1, 1, rowValues.length).setValues([rowValues]);
    } else {
      newSummaryRows.push(rowValues);
      summaryEmailMap[emLower] = summarySheet.getLastRow() + newSummaryRows.length;
    }
  });

  if (newSummaryRows.length > 0) {
    summarySheet.getRange(summarySheet.getLastRow() + 1, 1, newSummaryRows.length, newSummaryRows[0].length).setValues(newSummaryRows);
  }
}

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
function getDashboardDataFromSheet() {
  const res = getOverviewData();
  if (res && res.success && Array.isArray(res.agents)) {
    const banned = getBannedAgentsSet();
    if (banned.size > 0) {
      res.agents = res.agents.filter(a => !banned.has(String(a.email || '').toLowerCase().trim()));
      if (res.summary) res.summary.totalAgents = res.agents.length;
    }
  }
  return res;
}

function getAgentDrillRowsFromSheet(email, metric) {
  return getAgentDetailData(email, metric);
}

/**
 * قراءة الخط الزمني اليومي لوكيل واحد فقط (لا يتم دمج وكلاء آخرين).
 * يعتمد على ملفات drills الخاصة بهذا الوكيل حصرياً.
 * يتم تخزين النتيجة في كاش سريع لأن الحساب يقرأ كل صفوف الوكيل (قد تكون آلافاً).
 */
function getCachedAgentTimeline(email) {
  try {
    const raw = CacheService.getScriptCache().get('AGT_' + email);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.warn('Agent timeline cache read warning:', e);
  }
  return null;
}

function setCachedAgentTimeline(email, obj) {
  try {
    const s = JSON.stringify(obj);
    if (s.length < 90000) {
      CacheService.getScriptCache().put('AGT_' + email, s, 21600); // 6 ساعات
    }
  } catch (e) {
    console.warn('Agent timeline cache write warning:', e);
  }
}

function clearCachedAgentTimeline(email) {
  try {
    CacheService.getScriptCache().remove('AGT_' + email);
  } catch (e) {}
}

function getAgentDailyTimeline(email) {
  try {
    if (!email) {
      return { success: false, email: email, days: [] };
    }

    // منع ظهور الخط الزمني للوكيل المحظور
    if (isAgentBanned(email)) {
      return { success: true, email: email, days: [] };
    }

    // 1. كاش سريع أولاً
    const cached = getCachedAgentTimeline(email);
    if (cached) {
      return { success: true, email: email, days: cached };
    }

    const drillsFolder = getOrCreateDrillsFolder();
    const prefix = getAgentFileSlug(email) + '_';
    const files = drillsFolder.getFiles();
    const records = [];

    while (files.hasNext()) {
      const f = files.next();
      const name = f.getName();
      if (!name.endsWith('.json') || name.indexOf(prefix) !== 0) continue;
      try {
        const content = f.getBlob().getDataAsString();
        if (content && content.trim()) {
          records.push(normalizeRecord(JSON.parse(content), 0, name));
        }
      } catch (e) {
        // تجاهل أي ملف تالف لهذا الوكيل
      }
    }

    if (records.length === 0) {
      return { success: true, email: email, days: [] };
    }

    // بما أن الملفات مفصولة لكل وكيل، فلا حاجة لفلترة إضافية تعتمد على تطابق حالة الأحرف
    const analytics = calculateAnalytics(records);
    const days = Array.isArray(analytics.timeline) ? analytics.timeline : [];
    setCachedAgentTimeline(email, days);

    return {
      success: true,
      email: email,
      days: days
    };
  } catch (err) {
    return {
      success: false,
      email: email,
      days: [],
      error: String(err && err.message ? err.message : err)
    };
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
  opts = opts || {};
  const page = Math.max(0, parseInt(opts.page, 10) || 0);
  const pageSize = Math.min(500, Math.max(10, parseInt(opts.pageSize, 10) || 50));
  const search = String(opts.search || '').toLowerCase().trim();
  const datePreset = opts.datePreset || 'all';
  const csatScore = opts.csatScore || 'all';
  const channel = opts.channel || 'all';
  const topSessions = opts.topSessions || 'all';
  const targetMetric = (metric || 'csat').toLowerCase();

  const detail = getAgentDetailData(email, targetMetric);
  if (!detail || !detail.found || !detail.rows || !detail.rows.length) {
    return {
      success: true,
      found: false,
      email: email,
      metric: targetMetric,
      header: [],
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
      if (String(row[chanIdx] || '').toLowerCase().trim() !== channel.toLowerCase()) return false;
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

  // فلتر أعلى الجلسات (Top N) بعد الفرز التنازلي زمنياً
  if (topSessions !== 'all' && timeIdx !== -1) {
    filtered.sort(function (a, b) {
      return parseTimeValueToSeconds(b[timeIdx]) - parseTimeValueToSeconds(a[timeIdx]);
    });
    const n = topSessions === 'top5' ? 5 : 10;
    filtered = filtered.slice(0, n);
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
    options = options || { smartDates: true, updateSummary: true, updateArchive: true };
    if (!rawJson || typeof rawJson !== 'string' || !rawJson.trim()) {
      return { success: false, message: "لم يتم استلام أي نص JSON." };
    }

    const payload = JSON.parse(rawJson.replace(/^\uFEFF/, ''));
    const saveResult = savePayloadToMicroPartitionedDrive(payload);

    const logMsg = `استيراد إلى Google Drive (تجزئة دقيقة): (${saveResult.summaryCount}) وكيل، و (${saveResult.drillCount}) مقياس، و (${saveResult.ticketsCount}) تذكرة لتاريخ ${saveResult.date}.`;
    logSystemEvent("SUCCESS", "Admin Import to Granular Drive", logMsg);

    return {
      success: true,
      agentsCount: saveResult.summaryCount,
      drillCount: saveResult.drillCount,
      ticketsCount: saveResult.ticketsCount,
      date: saveResult.date,
      folderUrl: getDriveFolderUrl(),
      message: `تم بنجاح حفظ وتجزئة كل مقياس لكل موظف في ملف مستقل في Google Drive (${saveResult.summaryCount} وكيل، ${saveResult.drillCount} مقياس)!`
    };

  } catch (err) {
    logSystemEvent("ERROR", "Admin Import Failed", err.message);
    return {
      success: false,
      message: err.message
    };
  }
}

function getDriveFolderUrl() {
  try {
    const folder = getOrCreateDataFolder();
    return folder.getUrl();
  } catch (e) {
    return "";
  }
}

function getSpreadsheetUrl() {
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
    const key = String(email || '').toLowerCase().trim();
    if (!key) return { success: false, message: 'Invalid email address.' };
    const set = getBannedAgentsSet();
    if (banned) set.add(key); else set.delete(key);
    saveBannedAgentsSet(set);
    clearCachedOverview();
    logSystemEvent(banned ? 'WARN' : 'INFO', banned ? 'Ban Agent' : 'Unban Agent',
      `تم ${banned ? 'حظر' : 'إلغاء حظر'} الوكيل (${key})`);
    return { success: true, email: key, banned: !!banned, bannedAgents: Array.from(set) };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

function getBannedAgentsList() {
  try {
    return { success: true, bannedAgents: Array.from(getBannedAgentsSet()) };
  } catch (e) {
    return { success: false, message: e.message, bannedAgents: [] };
  }
}

function getAllAgentsForAdmin() {
  try {
    const overview = getOverviewData();
    const agents = (overview && Array.isArray(overview.agents)) ? overview.agents : [];
    const bannedSet = getBannedAgentsSet();

    // عدّ ملفات المقاييس لكل وكيل من مجلد drills (استناداً إلى بادئة slug)
    const filesCountByPrefix = new Map();
    const drillsFolder = getOrCreateDrillsFolder();
    const files = drillsFolder.getFiles();
    while (files.hasNext()) {
      const name = files.next().getName();
      if (!name.endsWith('.json')) continue;
      const idx = name.lastIndexOf('_');
      if (idx === -1) continue;
      const prefix = name.slice(0, idx);
      filesCountByPrefix.set(prefix, (filesCountByPrefix.get(prefix) || 0) + 1);
    }

    const list = agents.map(a => {
      const email = String(a.email || '').toLowerCase().trim();
      const slug = getAgentFileSlug(email);
      return {
        email: email,
        name: a.name || email,
        banned: bannedSet.has(email),
        metricFiles: filesCountByPrefix.get(slug) || 0,
        csat: a.csat,
        rowsCount: a.rowsCount || 0
      };
    });

    return { success: true, agents: list, bannedAgents: Array.from(bannedSet) };
  } catch (e) {
    return { success: false, message: e.message, agents: [], bannedAgents: [] };
  }
}

function getAdminStats() {
  try {
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
    const key = String(email || '').toLowerCase().trim();
    if (!key) return { success: false, message: 'Invalid email address.' };

    // 1. حذف جميع ملفات المقاييس الخاصة بالوكيل من مجلد drills
    const drillsFolder = getOrCreateDrillsFolder();
    const prefix = getAgentFileSlug(email) + '_';
    let deletedFiles = 0;
    const toDelete = [];
    const files = drillsFolder.getFiles();
    while (files.hasNext()) {
      const f = files.next();
      const name = f.getName();
      if (name.endsWith('.json') && name.indexOf(prefix) === 0) toDelete.push(f);
    }
    toDelete.forEach(f => {
      try { drillsFolder.removeFile(f); deletedFiles++; } catch (e) { console.warn('removeFile warning:', e.message); }
    });

    // 2. إزالة الوكيل من ملف summary_overview.json
    const folder = getOrCreateDataFolder();
    const sumFiles = folder.getFilesByName(CONFIG.SUMMARY_FILE_NAME);
    if (sumFiles.hasNext()) {
      const sf = sumFiles.next();
      try {
        const data = JSON.parse(sf.getBlob().getDataAsString());
        if (data && Array.isArray(data.agents)) {
          data.agents = data.agents.filter(a => String(a.email || '').toLowerCase().trim() !== key);
          if (data.summary) data.summary.totalAgents = data.agents.length;
          sf.setContent(JSON.stringify(data));
        }
      } catch (e) { console.warn('deleteAgentData summary update warning:', e.message); }
    }

    // 3. إزالة من قائمة الحظر + إبطال الكاش
    const set = getBannedAgentsSet();
    set.delete(key);
    saveBannedAgentsSet(set);
    clearCachedOverview();
    clearCachedAgentTimeline(email);

    logSystemEvent('WARN', 'Delete Agent Data',
      `تم حذف بيانات الوكيل (${email}) نهائياً — عدد الملفات المحذوفة: ${deletedFiles}`);

    return { success: true, email: key, deletedFiles: deletedFiles };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

/**
 * ============================================================================
 * جداول الأسبوعي والشهري (Weekly / Monthly Pivot) — جدول تقاطعي:
 * الصفوف = الوكلاء، الأعمدة = الفترات (أسابيع أو شهور)، الخلية = قيمة المقياس.
 * ============================================================================
 */

function buildWeeklyPeriods() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-based
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const periods = [];
  let w = 1;
  for (let start = 1; start <= daysInMonth; start += 7) {
    const end = Math.min(start + 6, daysInMonth);
    periods.push({ key: 'W' + w, label: 'أسبوع ' + w, range: start + '-' + end, year: year, month: month + 1, startDay: start, endDay: end });
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

function metricLabelForPeriod(m) {
  if (m === 'abst') return 'ABST (دقيقة)';
  if (m === 'sessions') return 'Sessions';
  return 'CSAT %';
}

function getAgentsPeriodTable(metric, periodType) {
  try {
    const m = (metric || 'csat').toLowerCase();
    const type = (periodType || 'weekly').toLowerCase();

    const overview = getDashboardDataFromSheet();
    const agents = (overview && Array.isArray(overview.agents)) ? overview.agents : [];
    const periods = (type === 'monthly') ? buildMonthlyPeriods(6) : buildWeeklyPeriods();

    const rows = [];
    for (const a of agents) {
      const tl = getAgentDailyTimeline(a.email);
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

    return {
      success: true,
      metric: m,
      periodType: type,
      metricLabel: metricLabelForPeriod(m),
      periods: periods.map(p => ({ key: p.key, label: p.label, range: p.range || '' })),
      agents: rows
    };
  } catch (e) {
    return { success: false, message: e.message, agents: [], periods: [] };
  }
}

function logSystemEvent(type, action, details) {
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
