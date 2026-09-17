/**
 * ============================================================================
 * AGENT PERFORMANCE HUB - GOOGLE WORKSPACE DRIVE BACKEND
 * ============================================================================
 * نظام قاعدة بيانات سحابية متكاملة وسريعة تعمل بالكامل داخل Google Drive (DriveApp)
 * في نطاق ورك سبيس الشركة، بدون قيود أو حدود لخلايا Google Sheets
 * مع دعم التحديث التلقائي للملخص الإداري في Google Sheet (اختيارياً وبدون تكديس JSON)
 * ============================================================================
 */

const CONFIG = {
  // اسم المجلد المخصص في Google Drive الذي تُحفظ داخله قاعدة البيانات
  DRIVE_FOLDER_NAME: "Agent_Performance_Hub_Data",

  // اسم ملف قاعدة البيانات JSON المباشر داخل المجلد
  DB_FILE_NAME: "database.json",

  // معرف ملف Google Sheet للتخزين التلخيصي الإداري (اختياري)
  // - إذا كان السكربت مرتبطاً بالشيت (Container-bound) اتركه فارغاً ""
  // - إذا كان سكربتاً مستقلاً (Standalone) ضع معرف الشيت هنا
  SPREADSHEET_ID: "",

  // أسماء أوراق العمل في Google Sheet (للملخص الإداري النظيف بدون أي JSON في الخلايا)
  SHEET_SUMMARY: "Daily_Summary",       // ملخص أداء الوكلاء لليوم
  SHEET_ARCHIVE: "Historical_Archive",   // أرشيف الملخص التاريخي التراكمي
  SHEET_LOGS: "System_Logs"              // سجل أحداث وعمليات المزامنة
};

/**
 * ============================================================================
 * دالة تخديم الواجهة (Web App)
 * ============================================================================
 */
function doGet(e) {
  const page = (e && e.parameter && (e.parameter.page || e.parameter.p || '')) || '';
  const openAdmin = (page.toLowerCase() === 'admin');

  // إذا طلب المستخدم صفحة Admin
  if (openAdmin) {
    try {
      return HtmlService.createHtmlOutputFromFile('Admin')
        .setTitle('Admin Portal — استيراد وحفظ البيانات | Google Drive DB')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
        .addMetaTag('viewport', 'width=device-width, initial-scale=1');
    } catch (errAdmin) {
      // احتياطي في حال استدعاء الملف من قالب موحد
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
    const saveResult = savePayloadToDrive(payload);

    const logMsg = `مزامنة Drive ناجحة: (${saveResult.summaryCount}) وكيل ملخص، و (${saveResult.drillCount}) مقياس، و (${saveResult.ticketsCount}) تذكرة لتاريخ ${saveResult.date}.`;
    logSystemEvent("SUCCESS", "Extension Sync to Drive", logMsg);

    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      summaryCount: saveResult.summaryCount,
      drillCount: saveResult.drillCount,
      ticketsCount: saveResult.ticketsCount,
      date: saveResult.date,
      message: `تم حفظ البيانات بنجاح وبدون حدود في Google Drive! (${saveResult.summaryCount} وكيل، ${saveResult.drillCount} مقياس، ${saveResult.ticketsCount} تذكرة)`
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
 * محرك قاعدة بيانات Google Drive (Drive Database Engine)
 * ============================================================================
 */

/**
 * الحصول على مجلد البيانات في Google Drive أو إنشاؤه تلقائياً
 */
function getOrCreateDataFolder() {
  const folderName = CONFIG.DRIVE_FOLDER_NAME || "Agent_Performance_Hub_Data";
  const folders = DriveApp.getFoldersByName(folderName);
  if (folders.hasNext()) {
    return folders.next();
  }
  return DriveApp.createFolder(folderName);
}

/**
 * الحصول على ملف قاعدة البيانات JSON داخل المجلد أو إنشاؤه بهيكل نظيف
 */
function getOrCreateDatabaseFile() {
  const folder = getOrCreateDataFolder();
  const files = folder.getFilesByName(CONFIG.DB_FILE_NAME);
  if (files.hasNext()) {
    return files.next();
  }
  const initialDb = {
    version: 2,
    engine: "Google Drive JSON Database (DriveApp)",
    createdDate: Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM-dd HH:mm:ss'),
    lastUpdated: Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM-dd HH:mm:ss'),
    summaryAgents: [],
    historicalArchive: {}, // "YYYY-MM-DD": [ agent summary rows ]
    drills: []             // array of drill records matching agent-dashboard-viewer standard
  };
  return folder.createFile(CONFIG.DB_FILE_NAME, JSON.stringify(initialDb, null, 2), MimeType.PLAIN_TEXT);
}

/**
 * قراءة كائن قاعدة البيانات بالكامل من Google Drive
 */
function loadDatabaseFromDrive() {
  try {
    const file = getOrCreateDatabaseFile();
    const content = file.getBlob().getDataAsString();
    if (!content || !content.trim()) {
      return { version: 2, summaryAgents: [], historicalArchive: {}, drills: [] };
    }
    const db = JSON.parse(content);
    if (!db.summaryAgents) db.summaryAgents = [];
    if (!db.historicalArchive) db.historicalArchive = {};
    if (!db.drills) db.drills = [];
    return db;
  } catch (err) {
    console.error("Error loading database from Drive:", err);
    return { version: 2, summaryAgents: [], historicalArchive: {}, drills: [] };
  }
}

/**
 * حفظ وتحديث كائن قاعدة البيانات في Google Drive
 */
function saveDatabaseToDrive(db) {
  const file = getOrCreateDatabaseFile();
  db.lastUpdated = Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM-dd HH:mm:ss');
  file.setContent(JSON.stringify(db));
  return db;
}

/**
 * رابط مجلد قاعدة البيانات في Google Drive لفتحه في نافذة جديدة
 */
function getDriveFolderUrl() {
  try {
    const folder = getOrCreateDataFolder();
    return folder.getUrl();
  } catch (e) {
    return "";
  }
}

/**
 * رابط ملف قاعدة البيانات المباشر في Google Drive
 */
function getDatabaseFileUrl() {
  try {
    const file = getOrCreateDatabaseFile();
    return file.getUrl();
  } catch (e) {
    return "";
  }
}

/**
 * ============================================================================
 * حفظ وتحديث البيانات في Google Drive مع منع التكرار وإلغاء حدود الخلايا نهائياً
 * ============================================================================
 */
function savePayloadToDrive(payload) {
  const dateStr = payload.date || Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM-dd');
  const db = loadDatabaseFromDrive();

  let summaryCount = 0;
  let drillCount = 0;
  let ticketsCount = 0;

  // 1. معالجة وتحديث الوكلاء الملخصين (summaryAgents)
  const incomingAgents = payload.agents || payload.summaryAgents || [];
  if (Array.isArray(incomingAgents) && incomingAgents.length > 0) {
    const agentMap = {};
    (db.summaryAgents || []).forEach(a => {
      const em = String(a.email || "").trim().toLowerCase();
      if (em) agentMap[em] = a;
    });

    incomingAgents.forEach(a => {
      const email = String(a.email || "").trim();
      if (!email) return;
      const emLower = email.toLowerCase();
      const updatedAgent = {
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
      agentMap[emLower] = updatedAgent;
    });

    db.summaryAgents = Object.values(agentMap);
    summaryCount = db.summaryAgents.length;

    // حفظ نسخة في الأرشيف التاريخي لهذا اليوم
    if (!db.historicalArchive) db.historicalArchive = {};
    db.historicalArchive[dateStr] = JSON.parse(JSON.stringify(db.summaryAgents));
  }

  // 2. معالجة وتحديث نتائج الـ Drills التفصيلية (CSAT, AGBT, ABST, Lateness, Breaches, Idle)
  const incomingResults = payload.results || (Array.isArray(payload) && payload[0]?.metric ? payload : []);
  if (Array.isArray(incomingResults) && incomingResults.length > 0) {
    if (!db.drills) db.drills = [];

    // خريطة لتحديد السجلات القائمة وتحديثها بدون تكرار (Key: date|email|metric)
    const drillMap = {};
    db.drills.forEach((d, idx) => {
      const k = String(d.date || "") + "|" + String(d.agent || "").trim().toLowerCase() + "|" + String(d.metric || "").trim().toLowerCase();
      drillMap[k] = idx;
    });

    const nowStr = Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM-dd HH:mm:ss');

    incomingResults.forEach(res => {
      const agent = (res.agent || "").trim();
      const metric = (res.metric || "").trim();
      const rows = res.rows || [];
      if (!agent || !metric) return;

      const normalized = normalizeDrillRecord(res.header || [], rows);
      const recCount = normalized.rows.length;
      ticketsCount += recCount;

      const drillRecord = {
        date: dateStr,
        agent: agent,
        metric: metric.toLowerCase(),
        title: String(res.title || `${metric.toUpperCase()} - ${agent}`).substring(0, 200),
        header: normalized.header,
        rows: normalized.rows,
        count: recCount,
        savedAt: nowStr
      };

      const k = dateStr + "|" + agent.toLowerCase() + "|" + metric.toLowerCase();
      if (drillMap.hasOwnProperty(k)) {
        // تحديث السجل القائم في مكانه
        db.drills[drillMap[k]] = drillRecord;
      } else {
        drillMap[k] = db.drills.length;
        db.drills.push(drillRecord);
      }
      drillCount++;
    });
  }

  // إذا لم يتوفر summaryAgents، نستخرج ملخص الوكلاء تلقائياً من الـ drills
  if (summaryCount === 0 && db.drills.length > 0) {
    db.summaryAgents = extractSummaryFromDrills(db.drills, dateStr);
    summaryCount = db.summaryAgents.length;
    if (!db.historicalArchive) db.historicalArchive = {};
    db.historicalArchive[dateStr] = JSON.parse(JSON.stringify(db.summaryAgents));
  }

  // حفظ قاعدة البيانات بالكامل في Google Drive
  saveDatabaseToDrive(db);

  // تحديث اختياري آمن لـ Google Sheet (أرقام الملخص الإحصائي فقط دون حشر أي JSON)
  try {
    syncSummaryToGoogleSheetIfConfigured(db.summaryAgents, dateStr);
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
 * دالة مساعدة لاستخراج ملخص الوكلاء من الـ Drills إذا لم يتم إرسال جدول رئيسي
 */
function extractSummaryFromDrills(drills, dateStr) {
  const agentSummaries = {};
  drills.forEach(d => {
    if (d.date !== dateStr) return;
    const agent = d.agent;
    const metric = d.metric.toLowerCase();
    const rows = d.rows || [];

    if (!agentSummaries[agent]) {
      agentSummaries[agent] = {
        date: dateStr,
        name: agent.split("@")[0].replace(".", " "),
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
      rows.forEach(r => {
        const rating = String(r[1] || r[3] || "");
        if (rating) {
          total++;
          if (rating.includes("5") || rating.includes("4") || rating.toLowerCase().includes("good")) good++;
        }
      });
      agentSummaries[agent].csat = total > 0 ? parseFloat(((good / total) * 100).toFixed(1)) : 0;
    } else if (metric === "lateness") {
      let totalLate = 0;
      rows.forEach(r => {
        const m = parseFloat(r[3] || r[4] || r[2] || 0) || 0;
        totalLate += m;
      });
      agentSummaries[agent].lateness = parseFloat(totalLate.toFixed(1));
    } else if (metric === "breakbreach" || metric === "break") {
      agentSummaries[agent].breakBreach = String(rows.length);
    }
  });

  return Object.values(agentSummaries);
}

/**
 * ============================================================================
 * قراءة بيانات النظرة العامة للوكلاء — مباشرة من Google Drive
 * ============================================================================
 */
function getOverviewData() {
  try {
    const db = loadDatabaseFromDrive();
    const agents = db.summaryAgents || [];

    if (agents.length === 0 && (!db.drills || db.drills.length === 0)) {
      return {
        success: true,
        isEmpty: true,
        agents: [],
        summary: { totalAgents: 0, avgCsat: "—", totalLateness: "—", lastSync: "—", totalDrillRows: 0 },
        message: "لا توجد بيانات مسجلة في Google Drive حتى الآن. استخدم صفحة الإدارة (Admin) للصق النتائج وحفظها."
      };
    }

    let totalCsat = 0, countCsat = 0;
    let totalLateness = 0;
    let latestUpdateTime = "";

    agents.forEach(a => {
      const csatVal = parseFloat(a.csat) || 0;
      const latenessVal = parseFloat(a.lateness) || 0;
      if (csatVal > 0) {
        totalCsat += csatVal;
        countCsat++;
      }
      totalLateness += latenessVal;
      if (!latestUpdateTime && a.updatedAt) latestUpdateTime = String(a.updatedAt);
    });

    // حساب إجمالي صفوف التذاكر والاتجاهات التاريخية
    let totalDrillRows = 0;
    const dailyAggregates = {};

    (db.drills || []).forEach(d => {
      const day = d.date;
      if (!day) return;
      const rows = d.rows || [];
      const header = d.header || [];
      totalDrillRows += rows.length;
      if (rows.length === 0) return;

      if (!dailyAggregates[day]) {
        dailyAggregates[day] = { day: day, sessions: 0, abstSecsSum: 0, abstCount: 0, agbtSecsSum: 0, agbtCount: 0, csatGood: 0, csatBad: 0, long: 0 };
      }
      const agg = dailyAggregates[day];
      const metric = String(d.metric || "").toLowerCase();

      if (metric === 'abst') {
        const timeIdx = findColIndex(header, 'basket_session_time_min', 'session_time', 'abst');
        const over20Idx = findColIndex(header, '> 20', '20');
        for (const row of rows) {
          agg.sessions++;
          if (over20Idx !== -1) {
            const ov = String(row[over20Idx] || '').trim().toLowerCase();
            if (ov === 'high' || ov === 'yes' || ov === '1' || ov === 'true') agg.long++;
          }
          if (timeIdx !== -1) {
            const mins = parseFloat(row[timeIdx]);
            if (!isNaN(mins) && mins > 0) {
              agg.abstSecsSum += mins * 60;
              agg.abstCount++;
              if (mins >= 20 && over20Idx === -1) agg.long++;
            }
          }
        }
      } else if (metric === 'agbt') {
        const sessionIdx = findColIndex(header, 'sessions count', 'sessions');
        const ticketIdx = findColIndex(header, 'tickets');
        const basketIdx = findColIndex(header, 'sum_basket_time_for_ticket_per_hour_min_online_womt', 'basket_time', 'agbt');
        for (const row of rows) {
          let s = 1;
          if (sessionIdx !== -1) { const v = parseInt(row[sessionIdx], 10); if (!isNaN(v) && v > 0) s = v; }
          else if (ticketIdx !== -1) { const v = parseInt(row[ticketIdx], 10); if (!isNaN(v) && v > 0) s = v; }
          agg.sessions += Math.max(1, s);
          if (basketIdx !== -1) {
            const mins = parseFloat(row[basketIdx]);
            if (!isNaN(mins) && mins > 0) {
              agg.agbtSecsSum += mins * 60;
              agg.agbtCount++;
            }
          }
        }
      } else if (metric === 'csat') {
        const scoreIdx = findColIndex(header, 'csat_adjusted', 'csat', 'score');
        for (const row of rows) {
          agg.sessions++;
          if (scoreIdx !== -1) {
            const sc = String(row[scoreIdx] || '').trim().toLowerCase();
            if (sc === 'good' || sc === '5' || sc === '4' || sc === 'positive') agg.csatGood++;
            else if (sc === 'bad' || sc === '1' || sc === '2' || sc === 'negative') agg.csatBad++;
          }
        }
      }
    });

    const historicalDays = Object.keys(dailyAggregates).map(k => {
      const item = dailyAggregates[k];
      const csatEval = (item.csatGood || 0) + (item.csatBad || 0);
      return {
        day: item.day,
        sessions: item.sessions,
        abstSecs: item.abstCount > 0 ? Math.round(item.abstSecsSum / item.abstCount) : 0,
        agbtSecs: item.agbtCount > 0 ? Math.round(item.agbtSecsSum / item.agbtCount) : 0,
        csat: csatEval > 0 ? Math.round(((item.csatGood || 0) / csatEval) * 100) : 0,
        long: item.long || 0
      };
    }).filter(d => d.sessions > 0)
      .sort((a, b) => a.day.localeCompare(b.day));

    const avgCsat = countCsat > 0 ? (totalCsat / countCsat).toFixed(1) : "0";

    return {
      success: true,
      isEmpty: agents.length === 0,
      summary: {
        totalAgents: agents.length,
        avgCsat: avgCsat,
        totalLateness: totalLateness.toFixed(1),
        lastSync: latestUpdateTime || Utilities.formatDate(new Date(), 'Asia/Riyadh', 'HH:mm'),
        totalMetrics: 7,
        totalDrillRows: totalDrillRows
      },
      agents: agents,
      historicalDays: historicalDays
    };

  } catch (err) {
    return {
      success: false,
      isEmpty: true,
      agents: [],
      summary: { totalAgents: 0, avgCsat: "—", totalLateness: "—", lastSync: "—", totalDrillRows: 0 },
      message: "حدث خطأ أثناء قراءة بيانات Google Drive: " + err.message
    };
  }
}

/**
 * ============================================================================
 * قراءة البيانات التفصيلية (Drill Records) لوكيل معين ومقياس معين من Google Drive
 * ============================================================================
 */
function getAgentDetailData(email, metric) {
  try {
    const db = loadDatabaseFromDrive();

    // 1. إذا كان المطلوب "كل الوكلاء" (All Agents)
    if (!email || email === 'all' || email === '') {
      return getAllAgentsMetricSummary(db.summaryAgents || [], metric);
    }

    // 2. إذا كان المطلوب وكيلاً محدداً
    const targetEmail = email.trim().toLowerCase();
    const targetMetric = (metric || "csat").trim().toLowerCase();

    const matchingDrills = (db.drills || []).filter(d => {
      const em = String(d.agent || "").trim().toLowerCase();
      const met = String(d.metric || "").trim().toLowerCase();
      return em === targetEmail && met === targetMetric;
    });

    if (matchingDrills.length === 0) {
      return {
        success: true,
        found: false,
        isAllAgents: false,
        email: email,
        metric: metric,
        header: [],
        rows: [],
        count: 0,
        message: `لم يتم العثور على سجلات تفصيلية لمقياس (${metric}) لهذا الوكيل. يمكنك سحبها من الإضافة ثم حفظها.`
      };
    }

    // أحدث سجل محفوظ
    const latestDrill = matchingDrills[matchingDrills.length - 1];

    return {
      success: true,
      found: true,
      isAllAgents: false,
      email: email,
      metric: metric,
      title: latestDrill.title || `${metric.toUpperCase()} - ${email}`,
      header: latestDrill.header || [],
      rows: latestDrill.rows || [],
      count: (latestDrill.rows || []).length,
      date: latestDrill.date || "",
      savedAt: latestDrill.savedAt || ""
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
  if (!ss) return; // لا يوجد شيت محدد أو متصل

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
 * ============================================================================
 * دوال التوافق التي تستدعيها الواجهة الأمامية (Scripts.html)
 * ============================================================================
 */
function getDashboardDataFromSheet() {
  return getOverviewData();
}

function getAgentDrillRowsFromSheet(email, metric) {
  return getAgentDetailData(email, metric);
}

/**
 * ============================================================================
 * دالة استيراد وحفظ البيانات المنسوخة من بوابة الأدمن مباشرة في Google Drive
 * ============================================================================
 */
function importDataFromAdminPortal(rawJson, options) {
  try {
    options = options || { smartDates: true, updateSummary: true, updateArchive: true };
    if (!rawJson || typeof rawJson !== 'string' || !rawJson.trim()) {
      return { success: false, message: "لم يتم استلام أي نص JSON." };
    }

    const payload = JSON.parse(rawJson);
    const saveResult = savePayloadToDrive(payload);

    const logMsg = `استيراد إلى Google Drive: (${saveResult.summaryCount}) وكيل، و (${saveResult.drillCount}) مقياس، و (${saveResult.ticketsCount}) تذكرة لتاريخ ${saveResult.date}.`;
    logSystemEvent("SUCCESS", "Admin Import to Drive", logMsg);

    const driveFolderUrl = getDriveFolderUrl();

    return {
      success: true,
      agentsCount: saveResult.summaryCount,
      drillCount: saveResult.drillCount,
      ticketsCount: saveResult.ticketsCount,
      date: saveResult.date,
      folderUrl: driveFolderUrl,
      message: `تم بنجاح حفظ وتحديث البيانات في Google Drive (${saveResult.summaryCount} وكيل، ${saveResult.drillCount} مقياس، ${saveResult.ticketsCount} تذكرة)!`
    };

  } catch (err) {
    logSystemEvent("ERROR", "Admin Import Failed", err.message);
    return {
      success: false,
      message: err.message
    };
  }
}

/**
 * ============================================================================
 * أدوات مساعدة وتطبيع البيانات
 * ============================================================================
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

function getSpreadsheetUrl() {
  try {
    const ss = getTargetSpreadsheet();
    return ss ? ss.getUrl() : "";
  } catch (e) {
    return "";
  }
}
