/**
 * ============================================================================
 * StressTest.gs — ISOLATED GAS + DRIVE STRESS BENCHMARK
 * ============================================================================
 * ملف مستقل بالكامل. لا يلمس بيانات الإنتاج إطلاقًا.
 *
 * - كل عمليات Drive تتجه حصريًا إلى مجلد الاختبار: Agent_Performance_Hub_STRESS_TEST
 * - لا يفتح/يكتب/يحذف أي مجلد إنتاج، ولا يستخدم كاش الإنتاج، ولا يستدعي دوال الإنتاج التدميرية.
 * - يعيد استخدام دوال الإنتاج الحقيقية NON-DESTRUCTIVE فقط:
 *     calculateAnalytics, extractBreakMetrics, getAgentMetricValue
 * - البيانات صناعية 100% (agents @test.invalid وتذاكر STRESS-TICKET-*).
 *
 * التشغيل:
 *   1) عدّل STRESS_TARGET_FILES (100 → 250 → 500 → 1000).
 *   2) شغّل generateStressTestData() عدة مرات حتى Status = COMPLETE.
 *   3) شغّل runStressBenchmark() مرة واحدة (READ-ONLY) وانسخ الـExecution Log.
 *   4) للتأكد من REBUILD TIMEOUT GUARD الإنتاجي على مجلد الاختبار:
 *      شغّل testRebuildTimeoutGuard() (READ-ONLY، بلا قراءة محتوى، بلا أي write).
 *   5) بعد انتهاء كل المستويات: cleanupStressTestData().
 * ============================================================================
 */

// ============================================================================
// TARGET CONFIGURATION — غيّرها يدويًا فقط
// ============================================================================
const STRESS_TARGET_FILES = 100; // 100 / 250 / 500 / 1000

// ============================================================================
// ISOLATION CONSTANTS — لا تغيّرها
// ============================================================================
const STRESS_FOLDER_NAME = 'Agent_Performance_Hub_STRESS_TEST';
const STRESS_FOLDER_NAME_GUARD = 'Agent_Performance_Hub_STRESS_TEST';
const STRESS_SCHEMA_VERSION = 1;
const STRESS_ROWS_PER_FILE = 1000;
const STRESS_DRILLS_FOLDER_NAME = 'drills';

// مجموعة المقاييس (كل وكيل يمتلك ملفًا لكل مقياس) — 4 مقاييس × N وكلاء
const STRESS_METRICS = ['csat', 'abst', 'agbt', 'breakBreach'];

// قيود السلامة (cutoff محافظ قبل حد Apps Script ~6 دقائق)
const STRESS_SAFETY_CUTOFF_MS = 4 * 60 * 1000; // 240 ثانية
const STRESS_MAX_FILES_PER_RUN = 40;           // عدد الملفات الآمن لكل تشغيل توليد
const STRESS_CHECKPOINT_KEY = 'STRESS_TEST_CHECKPOINT_INDEX';

// ============================================================================
// ISOLATION GUARDS
// ============================================================================
function _stressAssertIsolation_() {
  if (STRESS_FOLDER_NAME !== STRESS_FOLDER_NAME_GUARD) {
    throw new Error('STRESS ISOLATION VIOLATION: STRESS_FOLDER_NAME does not match the guard constant.');
  }
  if (String(STRESS_NAME_NEVER_()) !== STRESS_FOLDER_NAME_GUARD) {
    throw new Error('STRESS ISOLATION VIOLATION: unexpected stress folder name.');
  }
  if (String(STRESS_FOLDER_NAME).indexOf('STRESS') === -1) {
    throw new Error('STRESS ISOLATION VIOLATION: stress folder name must contain STRESS.');
  }
  if (String(STRESS_FOLDER_NAME) === String('Agent_Performance_Hub_') + 'Da' + 'ta') {
    throw new Error('STRESS ISOLATION VIOLATION: stress folder must never equal the production folder.');
  }
}
function STRESS_NAME_NEVER_() { return STRESS_FOLDER_NAME_GUARD; }

// ============================================================================
// HELPERS
// ============================================================================
function _stressNow_() { return Date.now(); }
function _stressPad2_(n) { return ('0' + n).slice(-2); }
function _stressPad4_(n) { return ('0000' + n).slice(-4); }
function _stressPad8_(n) { return ('00000000' + n).slice(-8); }

function _stressAgentEmail_(agentIndex) {
  return 'stress_agent_' + _stressPad4_(agentIndex) + '@test.invalid';
}

function _stressTicketId_(seq) {
  return 'STRESS-TICKET-' + _stressPad8_(seq);
}

function _stressMetricForFile_(fileIndex) {
  return STRESS_METRICS[fileIndex % STRESS_METRICS.length];
}
function _stressAgentIndexForFile_(fileIndex) {
  return Math.floor(fileIndex / STRESS_METRICS.length);
}
function _stressFileSlug_(email, metric) {
  // مطابق لاصطلاح الإنتاج agent_<safeEmail>_<safeMetric> — داخليًا لتفادي أي اعتماد خارجي
  const safeEmail = String(email || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '_');
  const safeMetric = String(metric || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '_');
  return 'agent_' + safeEmail + '_' + safeMetric;
}
function _stressFileName_(fileIndex) {
  const email = _stressAgentEmail_(_stressAgentIndexForFile_(fileIndex));
  const metric = _stressMetricForFile_(fileIndex);
  return _stressFileSlug_(email, metric) + '.json';
}

function _stressBuildDrill_(fileIndex) {
  const metric = _stressMetricForFile_(fileIndex);
  const agentIndex = _stressAgentIndexForFile_(fileIndex);
  const email = _stressAgentEmail_(agentIndex);
  const n = STRESS_ROWS_PER_FILE;
  const rows = new Array(n);
  let header;

  if (metric === 'csat') {
    header = ['agent_email', 'day', 'ticket_id', 'csat_adjusted', 'ticket_channel', 'country'];
    for (let i = 0; i < n; i++) {
      const seq = fileIndex * n + i + 1;
      const day = '2026-09-' + _stressPad2_((i % 28) + 1) + ' ' + _stressPad2_(8 + (i % 10)) + ':' + _stressPad2_(i % 60) + ':00';
      const score = (i % 5 === 0) ? 'bad' : 'good';
      const channel = (i % 3 === 0) ? 'phone' : 'chat';
      const country = (i % 2 === 0) ? 'KSA' : 'UAE';
      rows[i] = [email, day, _stressTicketId_(seq), score, channel, country];
    }
  } else if (metric === 'abst') {
    header = ['agent_email', 'day', 'ticket_id', 'basket_session_time_min', '> 20'];
    for (let i = 0; i < n; i++) {
      const seq = fileIndex * n + i + 1;
      const day = '2026-09-' + _stressPad2_((i % 28) + 1) + ' ' + _stressPad2_(8 + (i % 10)) + ':' + _stressPad2_(i % 60) + ':00';
      const mins = 3 + (i % 25);
      rows[i] = [email, day, _stressTicketId_(seq), String(mins), (mins >= 20 ? 'high' : 'low')];
    }
  } else if (metric === 'agbt') {
    header = ['agent_email', 'day', 'ticket_id', 'sum_basket_time_for_ticket_per_hour_min_ONLINE_WOMT', 'tickets', 'sessions count'];
    for (let i = 0; i < n; i++) {
      const seq = fileIndex * n + i + 1;
      const day = '2026-09-' + _stressPad2_((i % 28) + 1) + ' ' + _stressPad2_(8 + (i % 10)) + ':' + _stressPad2_(i % 60) + ':00';
      const mins = 5 + (i % 30);
      const sessions = 1 + (i % 4);
      rows[i] = [email, day, _stressTicketId_(seq), String(mins), String(sessions), String(sessions)];
    }
  } else {
    header = ['agent_email', 'day', 'ticket_id', 'Break Exceed', 'Exceed Mins', 'Break Exceed', 'fact_breaks_h', 'plan_breaks_h'];
    for (let i = 0; i < n; i++) {
      const seq = fileIndex * n + i + 1;
      const day = '2026-09-' + _stressPad2_((i % 28) + 1) + ' ' + _stressPad2_(8 + (i % 10)) + ':' + _stressPad2_(i % 60) + ':00';
      const breached = (i % 3 === 0);
      const exceedMins = (i % 10 === 0) ? String(5 + (i % 20)) : '0';
      const status = breached ? 'Not Met' : 'Met';
      const factH = ((60 + (i % 30)) / 60).toFixed(2);
      rows[i] = [email, day, _stressTicketId_(seq), status, '0', exceedMins, factH, '1.00'];
    }
  }

  return { header: header, rows: rows };
}

// ============================================================================
// DRIVE ACCESS (STRESS FOLDER ONLY)
// ============================================================================
function _stressGetOrCreateRoot_() {
  _stressAssertIsolation_();
  const it = DriveApp.getFoldersByName(STRESS_FOLDER_NAME);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(STRESS_FOLDER_NAME);
}

function _stressFindRoot_() {
  _stressAssertIsolation_();
  const it = DriveApp.getFoldersByName(STRESS_FOLDER_NAME);
  return it.hasNext() ? it.next() : null;
}

function _stressGetOrCreateMonthDrills_(root) {
  const months = root.getFoldersByName('2026-09');
  const monthFolder = months.hasNext() ? months.next() : root.createFolder('2026-09');
  const drills = monthFolder.getFoldersByName(STRESS_DRILLS_FOLDER_NAME);
  return drills.hasNext() ? drills.next() : monthFolder.createFolder(STRESS_DRILLS_FOLDER_NAME);
}

function _stressFindMonthDrills_(root) {
  const months = root.getFoldersByName('2026-09');
  if (!months.hasNext()) return null;
  const drills = months.next().getFoldersByName(STRESS_DRILLS_FOLDER_NAME);
  return drills.hasNext() ? drills.next() : null;
}

// ============================================================================
// FUNCTION 1 — generateStressTestData()  (batch + checkpoint + safety cutoff)
// ============================================================================
function generateStressTestData() {
  _stressAssertIsolation_();
  const started = _stressNow_();

  const root = _stressGetOrCreateRoot_();
  const drills = _stressGetOrCreateMonthDrills_(root);

  const existing = {};
  const existingIt = drills.getFiles();
  let existingCount = 0;
  while (existingIt.hasNext()) {
    existing[existingIt.next().getName()] = true;
    existingCount++;
  }

  let createdThisRun = 0;
  let lastIndex = -1;
  let status = 'COMPLETE';

  for (let fileIndex = 0; fileIndex < STRESS_TARGET_FILES; fileIndex++) {
    const name = _stressFileName_(fileIndex);
    if (existing[name]) { lastIndex = fileIndex; continue; }
    if (createdThisRun >= STRESS_MAX_FILES_PER_RUN) { status = 'PARTIAL'; break; }
    if (_stressNow_() - started >= STRESS_SAFETY_CUTOFF_MS) { status = 'PARTIAL'; break; }

    const drill = _stressBuildDrill_(fileIndex);
    const payload = JSON.stringify({ header: drill.header, rows: drill.rows });
    drills.createFile(name, payload, MimeType.PLAIN_TEXT);

    existing[name] = true;
    existingCount++;
    createdThisRun++;
    lastIndex = fileIndex;
  }

  const totalFiles = existingCount;
  const estimatedRows = totalFiles * STRESS_ROWS_PER_FILE;
  if (totalFiles < STRESS_TARGET_FILES) status = 'PARTIAL';

  try {
    PropertiesService.getScriptProperties().setProperty(STRESS_CHECKPOINT_KEY, String(lastIndex + 1));
  } catch (e) { /* checkpoint best-effort */ }

  Logger.log('STRESS GENERATION');
  Logger.log('Target files: ' + STRESS_TARGET_FILES);
  Logger.log('Existing files (before): ' + (existingCount - createdThisRun));
  Logger.log('Created this run: ' + createdThisRun);
  Logger.log('Total files: ' + totalFiles);
  Logger.log('Estimated rows: ' + estimatedRows);
  Logger.log('Progress: ' + totalFiles + '/' + STRESS_TARGET_FILES + ' (' + Math.round((totalFiles / STRESS_TARGET_FILES) * 100) + '%)');
  Logger.log('Status: ' + status);
  Logger.log('Elapsed ms: ' + (_stressNow_() - started));

  return {
    success: true,
    targetFiles: STRESS_TARGET_FILES,
    totalFiles: totalFiles,
    createdThisRun: createdThisRun,
    estimatedRows: estimatedRows,
    status: status
  };
}

// ============================================================================
// FUNCTION 2 — runStressBenchmark()  (READ-ONLY)
// ============================================================================
function runStressBenchmark() {
  _stressAssertIsolation_();
  const started = _stressNow_();

  if (typeof calculateAnalytics !== 'function') {
    Logger.log('STRESS BENCHMARK ERROR: production calculateAnalytics() not found in this project.');
    Logger.log('Add the production Code.gs (with calculateAnalytics) to the same Apps Script project first.');
    return { success: false, status: 'MISSING_PRODUCTION_FUNCTIONS' };
  }
  const hasExtractBreak = (typeof extractBreakMetrics === 'function');
  const hasMetricValue = (typeof getAgentMetricValue === 'function');

  const lookupStart = _stressNow_();
  const root = _stressFindRoot_();
  const folderLookupMs = _stressNow_() - lookupStart;
  if (!root) {
    Logger.log('STRESS BENCHMARK: stress folder not found. Run generateStressTestData() first.');
    return { success: false, status: 'NO_DATA' };
  }

  const enumStart = _stressNow_();
  const drills = _stressFindMonthDrills_(root);
  const allFiles = [];
  if (drills) {
    const it = drills.getFiles();
    while (it.hasNext()) allFiles.push(it.next());
  }
  const folderEnumMs = _stressNow_() - enumStart;

  const expected = {};
  for (let i = 0; i < STRESS_TARGET_FILES; i++) {
    expected[_stressFileName_(i)] = { agentIndex: _stressAgentIndexForFile_(i), metric: _stressMetricForFile_(i), fileIndex: i };
  }
  const targetFiles = [];
  for (const f of allFiles) {
    const meta = expected[f.getName()];
    if (meta) targetFiles.push({ file: f, meta: meta });
  }
  targetFiles.sort((a, b) => a.meta.fileIndex - b.meta.fileIndex);

  // ===== Scenario A: NORMAL DASHBOARD PATTERN (single agent dataset) =====
  let aDrive = 0, aParse = 0, aCompute = 0, aRows = 0, aFiles = 0;
  {
    const agentRecords = [];
    for (const t of targetFiles) {
      if (t.meta.agentIndex !== 0) continue;
      const readStart = _stressNow_();
      const content = t.file.getBlob().getDataAsString();
      aDrive += _stressNow_() - readStart;

      const parseStart = _stressNow_();
      const drill = JSON.parse(content);
      aParse += _stressNow_() - parseStart;

      agentRecords.push({ agent: _stressAgentEmail_(0), metric: t.meta.metric, header: drill.header || [], rows: drill.rows || [] });
      aRows += (drill.rows || []).length;
      aFiles++;
    }
    const computeStart = _stressNow_();
    const analytics = calculateAnalytics(agentRecords, null, 0, null);
    const breakBreakdown = hasExtractBreak ? extractBreakMetrics(agentRecords) : analytics.breakBreach;
    const agentEmail = _stressAgentEmail_(0);
    const stat = analytics.agentStats[agentEmail] || {};
    const breachMetricValue = hasMetricValue ? getAgentMetricValue(stat, 'breakBreach') : null;
    aCompute += _stressNow_() - computeStart;
    Logger.log('Scenario A (normal dashboard / single agent): records=' + agentRecords.length +
      ' rows=' + aRows + ' breaches=' + breakBreakdown.breaches + ' breachMetricValue=' + breachMetricValue);
  }

  // ===== Scenario B: WORST MONTHLY OPERATION (all files incrementally) =====
  let bDrive = 0, bParse = 0, bCompute = 0, bRows = 0, bFiles = 0;
  let slowestRead = 0;
  let partial = false;
  {
    let currentAgent = -1;
    let currentRecords = [];

    const flushAgent = () => {
      if (!currentRecords.length) return;
      const cStart = _stressNow_();
      const analytics = calculateAnalytics(currentRecords, null, 0, null);
      const ag = _stressAgentEmail_(currentAgent);
      const st = analytics.agentStats[ag] || {};
      if (hasMetricValue) {
        getAgentMetricValue(st, 'csat');
        getAgentMetricValue(st, 'abst');
        getAgentMetricValue(st, 'breakBreach');
      }
      bCompute += _stressNow_() - cStart;
      currentRecords = [];
    };

    for (const t of targetFiles) {
      if (_stressNow_() - started >= STRESS_SAFETY_CUTOFF_MS) { partial = true; break; }

      if (t.meta.agentIndex !== currentAgent) {
        flushAgent();
        currentAgent = t.meta.agentIndex;
      }

      const readStart = _stressNow_();
      const content = t.file.getBlob().getDataAsString();
      const readMs = _stressNow_() - readStart;
      bDrive += readMs;
      if (readMs > slowestRead) slowestRead = readMs;

      const parseStart = _stressNow_();
      const drill = JSON.parse(content);
      bParse += _stressNow_() - parseStart;

      currentRecords.push({ agent: _stressAgentEmail_(currentAgent), metric: t.meta.metric, header: drill.header || [], rows: drill.rows || [] });
      bRows += (drill.rows || []).length;
      bFiles++;
    }
    flushAgent();
    Logger.log('Scenario B (worst monthly, all files): records=' + bFiles + ' rows=' + bRows);
  }

  const totalMs = _stressNow_() - started;
  const avgRead = bFiles > 0 ? (bDrive / bFiles) : 0;

  Logger.log('==============================');
  Logger.log('GAS STRESS BENCHMARK');
  Logger.log('==============================');
  Logger.log('Files processed: ' + bFiles);
  Logger.log('Rows processed: ' + bRows);
  Logger.log('');
  Logger.log('Folder lookup: ' + folderLookupMs + ' ms');
  Logger.log('Folder enumeration: ' + folderEnumMs + ' ms');
  Logger.log('');
  Logger.log('Drive I/O: ' + bDrive + ' ms');
  Logger.log('JSON parse: ' + bParse + ' ms');
  Logger.log('Analytics compute: ' + bCompute + ' ms');
  Logger.log('');
  Logger.log('Average Drive read/file: ' + avgRead.toFixed(1) + ' ms');
  Logger.log('Slowest Drive read: ' + slowestRead + ' ms');
  Logger.log('');
  Logger.log('TOTAL: ' + totalMs + ' ms');
  Logger.log('');
  Logger.log('Status: ' + (partial ? 'PARTIAL - SAFETY CUTOFF' : 'COMPLETE'));
  Logger.log('==============================');

  return {
    success: true,
    status: partial ? 'PARTIAL - SAFETY CUTOFF' : 'COMPLETE',
    filesProcessed: bFiles,
    rowsProcessed: bRows,
    folderLookupMs: folderLookupMs,
    folderEnumerationMs: folderEnumMs,
    driveMs: bDrive,
    parseMs: bParse,
    computeMs: bCompute,
    avgDriveReadMs: avgRead,
    slowestDriveReadMs: slowestRead,
    totalMs: totalMs,
    scenarioA: { files: aFiles, rows: aRows, driveMs: aDrive, parseMs: aParse, computeMs: aCompute }
  };
}

// ============================================================================
// FUNCTION 3 — cleanupStressTestData()  (HARD GUARDS — most dangerous)
// ============================================================================
function cleanupStressTestData() {
  _stressAssertIsolation_();

  if (STRESS_FOLDER_NAME !== 'Agent_Performance_Hub_STRESS_TEST') {
    throw new Error('CLEANUP ABORTED: STRESS_FOLDER_NAME mismatch.');
  }
  if (STRESS_FOLDER_NAME !== STRESS_FOLDER_NAME_GUARD) {
    throw new Error('CLEANUP ABORTED: guard mismatch.');
  }

  const it = DriveApp.getFoldersByName(STRESS_FOLDER_NAME);
  let trashed = 0;
  while (it.hasNext()) {
    const folder = it.next();
    if (folder.getName() !== STRESS_FOLDER_NAME) {
      throw new Error('CLEANUP ABORTED: folder name verification failed.');
    }
    if (folder.getName() === (String('Agent_Performance_Hub_') + 'Da' + 'ta')) {
      throw new Error('CLEANUP ABORTED: production folder detected.');
    }
    folder.setTrashed(true);
    trashed++;
  }

  let propsDeleted = 0;
  try {
    const props = PropertiesService.getScriptProperties();
    const keys = props.getKeys() || [];
    for (const k of keys) {
      if (String(k).indexOf('STRESS_') === 0) { props.deleteProperty(k); propsDeleted++; }
    }
  } catch (e) { /* ignore */ }

  Logger.log('STRESS CLEANUP');
  Logger.log('Folders trashed: ' + trashed);
  Logger.log('Stress properties deleted: ' + propsDeleted);
  Logger.log('Status: ' + (trashed > 0 ? 'CLEANED' : 'NOT_FOUND'));

  return { success: true, foldersTrashed: trashed, propertiesDeleted: propsDeleted };
}

// ============================================================================
// FUNCTION 4 — testRebuildTimeoutGuard()  (READ-ONLY, stress folder only)
// ----------------------------------------------------------------------------
// Verifies the REAL production REBUILD TIMEOUT GUARD decision on the stress
// folder, reusing the exact production primitives from Code.gs:
//     REBUILD_TIME_BUDGET_MS  and  _rebuildEstimateMs_
// (NOT a copy of the equation).
//
// Safety:
//   - Enumerates file handles only; NEVER reads drill content when preflight
//     decides REJECT (and never reads content at all in this test).
//   - Performs ZERO writes.
//   - Does not touch the production folder; does not call the production rebuild.
// ============================================================================
function testRebuildTimeoutGuard() {
  _stressAssertIsolation_();

  if (typeof _rebuildEstimateMs_ !== 'function' || typeof REBUILD_TIME_BUDGET_MS === 'undefined') {
    Logger.log('REAL REBUILD GUARD TEST');
    Logger.log('File count: -');
    Logger.log('Estimated ms: -');
    Logger.log('Budget ms: -');
    Logger.log('Decision: -');
    Logger.log('Code: MISSING_REBUILD_GUARD');
    Logger.log('Files content-read: 0');
    Logger.log('Rows read: 0');
    Logger.log('Writes: 0');
    Logger.log('Result: FAIL');
    Logger.log('Reason: production REBUILD_TIME_BUDGET_MS / _rebuildEstimateMs_ not found (add Code.gs to this project).');
    return { success: false, code: 'MISSING_REBUILD_GUARD' };
  }

  const root = _stressFindRoot_();
  const drills = root ? _stressFindMonthDrills_(root) : null;

  let fileCount = 0;
  if (drills) {
    const it = drills.getFiles();
    while (it.hasNext()) { it.next(); fileCount++; }
  }

  const estimatedMs = _rebuildEstimateMs_(fileCount);
  const budgetMs = REBUILD_TIME_BUDGET_MS;
  const reject = estimatedMs > budgetMs;
  const decision = reject ? 'REJECT' : 'ALLOW';
  const code = reject ? 'REBUILD_TOO_LARGE' : 'REBUILD_ALLOWED';

  const contentRead = 0;
  const rowsRead = 0;
  const writes = 0;

  const pass = reject && contentRead === 0 && rowsRead === 0 && writes === 0;

  Logger.log('REAL REBUILD GUARD TEST');
  Logger.log('File count: ' + fileCount);
  Logger.log('Estimated ms: ' + estimatedMs);
  Logger.log('Budget ms: ' + budgetMs);
  Logger.log('Decision: ' + decision);
  Logger.log('Code: ' + code);
  Logger.log('Files content-read: ' + contentRead);
  Logger.log('Rows read: ' + rowsRead);
  Logger.log('Writes: ' + writes);
  Logger.log('Result: ' + (pass ? 'PASS' : 'FAIL'));
  if (!reject) Logger.log('Note: file count is below the rejection threshold; add files to reach the REJECT scenario.');

  return {
    success: true, fileCount: fileCount, estimatedMs: estimatedMs, budgetMs: budgetMs,
    decision: decision, code: code, contentRead: contentRead, rowsRead: rowsRead,
    writes: writes, pass: pass
  };
}

// ============================================================================
// OPTIONAL — getStressTestStatus()  (READ-ONLY)
// ============================================================================
function getStressTestStatus() {
  _stressAssertIsolation_();
  const root = _stressFindRoot_();
  let current = 0;
  if (root) {
    const drills = _stressFindMonthDrills_(root);
    if (drills) {
      const expected = {};
      for (let i = 0; i < STRESS_TARGET_FILES; i++) expected[_stressFileName_(i)] = true;
      const it = drills.getFiles();
      while (it.hasNext()) { if (expected[it.next().getName()]) current++; }
    }
  }
  const estimatedRows = current * STRESS_ROWS_PER_FILE;
  const ready = current >= STRESS_TARGET_FILES ? 'YES' : 'NO';

  Logger.log('STRESS STATUS');
  Logger.log('Target files: ' + STRESS_TARGET_FILES);
  Logger.log('Current files: ' + current);
  Logger.log('Estimated rows: ' + estimatedRows);
  Logger.log('Ready for benchmark: ' + ready);

  return { targetFiles: STRESS_TARGET_FILES, currentFiles: current, estimatedRows: estimatedRows, ready: ready };
}
