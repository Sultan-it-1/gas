/**
 * ============================================================================
 * AGENT PERFORMANCE HUB - GRANULAR MICRO-PARTITIONED DRIVE BACKEND
 * ============================================================================
 * معمارية التجزئة الدقيقة فائقة السرعة (Granular Micro-Partitioned Storage):
 * 1. الشاشة الرئيسية: ملف مستقل وخفيف جداً (summary_overview.json < 10KB) + كاش الذاكرة (CacheService).
 * 2. تذاكر الوكلاء: كل مقياس (CSAT, AGBT, ABST, Lateness...) لكل موظف يُحفظ في ملف JSON مستقل ومعزول تماماً!
 *    مثال: drills/agent_ahmed_csat.json, drills/agent_ahmed_agbt.json
 * 3. استرجاع فوري: عند طلب CSAT للوكيل، يُقرأ ملف الـ CSAT فقط الخاص به، دون تحميل باقي المقاييس أو بقية الموظفين!
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

/**
 * ============================================================================
 * دالة تخديم الواجهة (Web App)
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

/**
 * ============================================================================
 * استقبال وحفظ البيانات المرسلة من إضافة المتصفح عبر POST
 * ============================================================================
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return ContentService.createTextOutput(JSON.stringify({ 
        success: false, 
        message: "لا توجد بيانات مستلمة في الطلب." 
      })).setMimeType(ContentService.MimeType.JSON);
    }

    const payload = JSON.parse(e.postData.contents);
    const saveResult = savePayloadToMicroPartitionedDrive(payload);

    const logMsg = `مزامنة تجزئة دقيقة لـ Drive: (${saveResult.summaryCount}) وكيل ملخص، و (${saveResult.drillCount}) مقياس، و (${saveResult.ticketsCount}) تذكرة لتاريخ ${saveResult.date}.`;
    logSystemEvent("SUCCESS", "Extension Sync to Granular Drive", logMsg);

    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      summaryCount: saveResult.summaryCount,
      drillCount: saveResult.drillCount,
      ticketsCount: saveResult.ticketsCount,
      date: saveResult.date,
      message: `تم حفظ وتجزئة كل مقياس لكل موظف في ملف مستقل في Google Drive! (${saveResult.summaryCount} وكيل، ${saveResult.drillCount} مقياس)`
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
 * إدارة المجلدات وأسماء الملفات الدقيقة في Google Drive
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

/**
 * إنشاء اسم ملف مخصص لكل موظف ولكل مقياس بشكل مستقل تماماً
 * مثال: agent_sultan_tabby_ai_csat
 */
function getAgentMetricFileSlug(email, metric) {
  const safeEmail = String(email || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '_');
  const safeMetric = String(metric || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '_');
  return `agent_${safeEmail}_${safeMetric}`;
}

/**
 * إدارة الذاكرة المؤقتة السريعة (CacheService)
 */
function getCachedOverview() {
  try {
    const cache = CacheService.getScriptCache();
    const cached = cache.get("SUMMARY_OVERVIEW_DATA");
    if (cached) {
      return JSON.parse(cached);
    }
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
 * ============================================================================
 * حفظ وتجزئة كل مقياس لكل موظف في ملف مستقل (Granular Micro-Partitioning)
 * ============================================================================
 */
function savePayloadToMicroPartitionedDrive(payload) {
  const dateStr = payload.date || Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM-dd');
  const nowStr = Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM-dd HH:mm:ss');
  const parentFolder = getOrCreateDataFolder();
  const drillsFolder = getOrCreateDrillsFolder();

  let summaryCount = 0;
  let drillCount = 0;
  let ticketsCount = 0;

  // 1. قراءة أو تهيئة ملف الملخص العام الحالي
  let overviewData = {
    version: 3,
    lastUpdated: nowStr,
    summary: { totalAgents: 0, avgCsat: "—", totalLateness: "—", lastSync: Utilities.formatDate(new Date(), 'Asia/Riyadh', 'HH:mm'), totalMetrics: 7, totalDrillRows: 0 },
    agents: [],
    historicalDays: []
  };

  const summaryFiles = parentFolder.getFilesByName(CONFIG.SUMMARY_FILE_NAME);
  let summaryFile = null;
  if (summaryFiles.hasNext()) {
    summaryFile = summaryFiles.next();
    try {
      const content = summaryFile.getBlob().getDataAsString();
      if (content && content.trim()) {
        overviewData = JSON.parse(content);
      }
    } catch (e) {
      console.warn("Failed to parse existing summary file:", e);
    }
  }

  // خريطة الوكلاء الحاليين لمنع التكرار (Key: email)
  const agentMap = {};
  (overviewData.agents || []).forEach(a => {
    const em = String(a.email || "").trim().toLowerCase();
    if (em) agentMap[em] = a;
  });

  // تحديث الوكلاء من المصفوفة المرفقة إن وجدت
  const incomingAgents = payload.agents || payload.summaryAgents || [];
  if (Array.isArray(incomingAgents) && incomingAgents.length > 0) {
    incomingAgents.forEach(a => {
      const email = String(a.email || "").trim();
      if (!email) return;
      const emLower = email.toLowerCase();
      agentMap[emLower] = {
        date: dateStr,
        name: String(a.name || email.split("@")[0]),
        email: email,
        csat: parseFloat(a.csat) || 0,
        agbt: String(a.agbt || "00:00"),
        abst: String(a.abst || "00:00"),
        breakBreach: String(a.breakBreach || "0"),
        lateness: parseFloat(a.lateness) || 0,
        idle: String(a.idle || "0"),
        productivity: String(a.productivity || "0%"),
        updatedAt: Utilities.formatDate(new Date(), 'Asia/Riyadh', 'HH:mm')
      };
    });
  }

  // 2. تجزئة وحفظ كل مقياس لكل موظف في ملف مستقل: drills/agent_{email}_{metric}.json
  const incomingResults = payload.results || (Array.isArray(payload) && payload[0]?.metric ? payload : []);

  if (Array.isArray(incomingResults) && incomingResults.length > 0) {
    incomingResults.forEach(res => {
      const agent = (res.agent || "").trim();
      const metric = String(res.metric || "").trim().toLowerCase();
      const rows = res.rows || [];
      if (!agent || !metric) return;

      const norm = normalizeDrillRecord(res.header || [], rows);
      const recCount = norm.rows.length;
      ticketsCount += recCount;
      drillCount++;

      // كائن المقياس المستقل
      const metricDoc = {
        date: dateStr,
        agent: agent,
        metric: metric,
        title: String(res.title || `${metric.toUpperCase()} - ${agent}`).substring(0, 200),
        header: norm.header,
        rows: norm.rows,
        count: recCount,
        savedAt: nowStr
      };

      // حفظ الملف المنفصل الخاص بهذا المقياس لهذا الوكيل
      const fileName = getAgentMetricFileSlug(agent, metric) + ".json";
      const existingFiles = drillsFolder.getFilesByName(fileName);
      const jsonContent = JSON.stringify(metricDoc);

      if (existingFiles.hasNext()) {
        existingFiles.next().setContent(jsonContent);
      } else {
        drillsFolder.createFile(fileName, jsonContent, MimeType.PLAIN_TEXT);
      }

      // استخراج وتحديث أرقام الملخص للوكيل مباشرة
      const emLower = agent.toLowerCase();
      if (!agentMap[emLower]) {
        agentMap[emLower] = {
          date: dateStr,
          name: emLower.split("@")[0].replace(".", " "),
          email: agent,
          csat: 0,
          agbt: "00:00",
          abst: "00:00",
          breakBreach: "0",
          lateness: 0,
          idle: "0",
          productivity: "0%",
          updatedAt: Utilities.formatDate(new Date(), 'Asia/Riyadh', 'HH:mm')
        };
      }

      if (metric === "csat") {
        let good = 0, total = 0;
        norm.rows.forEach(r => {
          const rating = String(r[1] || r[3] || "");
          if (rating) { total++; if (rating.includes("5") || rating.includes("4") || rating.toLowerCase().includes("good")) good++; }
        });
        if (total > 0) agentMap[emLower].csat = parseFloat(((good / total) * 100).toFixed(1));
      } else if (metric === "lateness") {
        let lateVal = 0;
        norm.rows.forEach(r => { lateVal += (parseFloat(r[3] || r[4] || r[2] || 0) || 0); });
        agentMap[emLower].lateness = parseFloat(lateVal.toFixed(1));
      } else if (metric === "breakbreach" || metric === "break") {
        agentMap[emLower].breakBreach = String(norm.rows.length);
      }
    });
  }

  overviewData.agents = Object.values(agentMap);
  summaryCount = overviewData.agents.length;

  // 3. الحساب المسبق للإحصائيات العامة والخط الزمني (Pre-calculated Timeline)
  let totalCsat = 0, countCsat = 0;
  let totalLateness = 0;

  overviewData.agents.forEach(a => {
    const csat = parseFloat(a.csat) || 0;
    const late = parseFloat(a.lateness) || 0;
    if (csat > 0) { totalCsat += csat; countCsat++; }
    totalLateness += late;
  });

  const avgCsat = countCsat > 0 ? (totalCsat / countCsat).toFixed(1) : "0";

  if (!overviewData.historicalDays) overviewData.historicalDays = [];
  const existingDayIdx = overviewData.historicalDays.findIndex(d => d.day === dateStr);
  const currentDayStats = {
    day: dateStr,
    sessions: Math.max(1, ticketsCount || overviewData.agents.length * 5),
    abstSecs: 90,
    agbtSecs: 210,
    csat: Math.round(parseFloat(avgCsat) || 90),
    long: 2
  };

  if (existingDayIdx !== -1) {
    overviewData.historicalDays[existingDayIdx] = currentDayStats;
  } else {
    overviewData.historicalDays.push(currentDayStats);
  }
  overviewData.historicalDays.sort((a, b) => a.day.localeCompare(b.day));

  overviewData.summary = {
    totalAgents: overviewData.agents.length,
    avgCsat: avgCsat,
    totalLateness: totalLateness.toFixed(1),
    lastSync: Utilities.formatDate(new Date(), 'Asia/Riyadh', 'HH:mm'),
    totalMetrics: 7,
    totalDrillRows: ticketsCount || overviewData.summary.totalDrillRows || 0
  };
  overviewData.lastUpdated = nowStr;

  // 4. حفظ ملف summary_overview.json الصغير وتحديث الكاش الفوري
  const summaryJsonStr = JSON.stringify(overviewData);
  if (summaryFile) {
    summaryFile.setContent(summaryJsonStr);
  } else {
    parentFolder.createFile(CONFIG.SUMMARY_FILE_NAME, summaryJsonStr, MimeType.PLAIN_TEXT);
  }

  // تحديث الذاكرة المؤقتة السريعة
  clearCachedOverview();
  setCachedOverview(overviewData);

  // تحديث اختياري لـ Google Sheet (الملخص فقط بدون تذاكر)
  try {
    syncSummaryToGoogleSheetIfConfigured(overviewData.agents, dateStr);
  } catch (sheetErr) {
    console.warn("Sheet summary sync skipped or failed:", sheetErr.message);
  }

  return {
    success: true,
    summaryCount: summaryCount,
    drillCount: drillCount,
    ticketsCount: ticketsCount,
    date: dateStr
  };
}

/**
 * ============================================================================
 * قراءة بيانات النظرة العامة للوكلاء — استجابة فورية من الذاكرة أو الملف الخفيف
 * ============================================================================
 */
function getOverviewData() {
  try {
    // 1. فحص الذاكرة المؤقتة السريعة أولاً (< 5 مللي ثانية!)
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
      message: "حدث خطأ أثناء قراءة البيانات السريعة: " + err.message
    };
  }
}

/**
 * ============================================================================
 * قراءة البيانات التفصيلية — قراءة الملف المخصص حصرياً لهذا المقياس ولهذا الوكيل
 * ============================================================================
 */
function getAgentDetailData(email, metric) {
  try {
    // 1. إذا كان المطلوب "كل الوكلاء" (مقارنة من جدول الملخص الخفيف)
    if (!email || email === 'all' || email === '') {
      const overview = getOverviewData();
      return getAllAgentsMetricSummary(overview.agents || [], metric);
    }

    // 2. قراءة ملف المقياس المعزول حصرياً للوكيل والمقياس المطلوب فقط
    const drillsFolder = getOrCreateDrillsFolder();
    const targetMetric = (metric || "csat").trim().toLowerCase();
    const fileName = getAgentMetricFileSlug(email, targetMetric) + ".json";
    const files = drillsFolder.getFilesByName(fileName);

    if (!files.hasNext()) {
      // فحص احتياطي إذا كان محفوظاً بصيغة الملف الموحد القديم
      const legacySlug = getAgentFileSlug(email) + ".json";
      const legacyFiles = drillsFolder.getFilesByName(legacySlug);
      if (legacyFiles.hasNext()) {
        try {
          const doc = JSON.parse(legacyFiles.next().getBlob().getDataAsString());
          const drill = doc.metrics && doc.metrics[targetMetric];
          if (drill) {
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
          }
        } catch (e) {}
      }

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
 * توليد جدول مقارنة جميع الوكلاء لمقياس معين بدون تفاصيل التذاكر الفردية
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
 * ============================================================================
 * تحديث اختياري لـ Google Sheet (الملخص الإحصائي فقط بدون حشر أي JSON)
 * ============================================================================
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

/**
 * الحصول على كائن Spreadsheet النشط أو المحدد إن وجد
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

/**
 * دوال التوافق التي تستدعيها الواجهة الأمامية (Scripts.html)
 */
function getDashboardDataFromSheet() {
  return getOverviewData();
}

function getAgentDrillRowsFromSheet(email, metric) {
  return getAgentDetailData(email, metric);
}

/**
 * دالة استيراد وحفظ البيانات المنسوخة من بوابة الأدمن مباشرة في Google Drive
 */
function importDataFromAdminPortal(rawJson, options) {
  try {
    options = options || { smartDates: true, updateSummary: true, updateArchive: true };
    if (!rawJson || typeof rawJson !== 'string' || !rawJson.trim()) {
      return { success: false, message: "لم يتم استلام أي نص JSON." };
    }

    const payload = JSON.parse(rawJson);
    const saveResult = savePayloadToMicroPartitionedDrive(payload);

    const logMsg = `استيراد إلى Google Drive (تجزئة دقيقة): (${saveResult.summaryCount}) وكيل، و (${saveResult.drillCount}) مقياس، و (${saveResult.ticketsCount}) تذكرة لتاريخ ${saveResult.date}.`;
    logSystemEvent("SUCCESS", "Admin Import to Granular Drive", logMsg);

    const driveFolderUrl = getDriveFolderUrl();

    return {
      success: true,
      agentsCount: saveResult.summaryCount,
      drillCount: saveResult.drillCount,
      ticketsCount: saveResult.ticketsCount,
      date: saveResult.date,
      folderUrl: driveFolderUrl,
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
 * أدوات مساعدة وتطبيع البيانات
 */
function findColIndex(headers, ...candidates) {
  if (!Array.isArray(headers)) return -1;
  const lower = headers.map(h => String(h).toLowerCase().trim());
  for (const candidate of candidates) {
    const target = candidate.toLowerCase();
    const idx = lower.findIndex(h => h === target || h.includes(target));
    if (idx !== -1) return idx;
  }
  return -1;
}

function textCell(v) {
  if (v === null || v === undefined) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function normalizeDrillRecord(header, rows) {
  const flatHeader = (function () {
    if (!Array.isArray(header)) return [];
    const levels = header.some(Array.isArray)
      ? header.map(function (lvl) { return Array.isArray(lvl) ? lvl : [lvl]; })
      : [header];
    const width = levels.reduce(function (max, lvl) { return Math.max(max, lvl.length); }, 0);
    return Array.from({ length: width }, function (_, col) {
      const names = levels.map(function (lvl) { return textCell(lvl[col]); }).filter(Boolean);
      return [...new Set(names)].join(' / ') || 'Column ' + (col + 1);
    });
  })();

  const flatRows = (Array.isArray(rows) ? rows : []).map(function (row) {
    if (Array.isArray(row)) return row;
    if (row && typeof row === 'object') {
      return flatHeader.map(function (name) {
        if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
        const key = Object.keys(row).find(function (k) { return String(k).toLowerCase() === String(name).toLowerCase(); });
        return key ? row[key] : '';
      });
    }
    return [];
  });

  return { header: flatHeader, rows: flatRows, width: flatHeader.length };
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
