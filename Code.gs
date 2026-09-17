/**
 * ============================================================================
 * AGENT PERFORMANCE HUB - GOOGLE APPS SCRIPT BACKEND
 * ============================================================================
 * نظام قراءة وعرض أداء الوكلاء حصرياً من Google Sheets
 * يتم تغذية الشيت حصرياً من إضافة المتصفح (Agent Dashboard Extension)
 * مع منع تكرار البيانات نهائياً (Deduplication) وتحديث السجلات القائمة فقط
 * ============================================================================
 */

const CONFIG = {
  // معرف ملف Google Sheet للتخزين
  // - إذا كان السكربت مرتبطاً بالشيت (Container-bound عبر Extensions > Apps Script) اتركه فارغاً ""
  // - إذا كان سكربتاً مستقلاً (Standalone) ضع معرف الشيت هنا بين علامتي التنصيص
  SPREADSHEET_ID: "",

  // أسماء أوراق العمل في Google Sheet
  SHEET_SUMMARY: "Daily_Summary",       // ملخص أداء الوكلاء لليوم
  SHEET_ARCHIVE: "Historical_Archive",   // أرشيف الملخص التاريخي التراكمي
  SHEET_DRILLS: "Drill_Archive",         // الأرشيف التفصيلي لسجلات المقاييس (Drills)
  SHEET_LOGS: "System_Logs"              // سجل أحداث وعمليات المزامنة
};

/**
 * دالة تخديم الواجهة (Web App)
 */
function doGet(e) {
  const page = (e && e.parameter && (e.parameter.page || e.parameter.p || '')) || '';
  const openAdmin = (page.toLowerCase() === 'admin');

  // إذا طلب المستخدم صفحة Admin وكان ملف Admin المستقل موجوداً، يتم تخديمه
  if (openAdmin) {
    try {
      return HtmlService.createHtmlOutputFromFile('Admin')
        .setTitle('Admin Portal — استيراد وحفظ البيانات | Agent Dashboard')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
        .addMetaTag('viewport', 'width=device-width, initial-scale=1');
    } catch (errAdmin) {
      // إذا لم يكن ملف Admin موجوداً، نخدم الداشبورد فوراً مع فتح نافذة الإدارة المنبثقة تلقائياً
    }
  }

  const template = HtmlService.createTemplateFromFile('Index');
  template.initialData = JSON.stringify({
    title: "Agent Dashboard | لوحة أداء الوكلاء",
    timestamp: new Date().toISOString(),
    openAdmin: openAdmin
  });

  return template.evaluate()
    .setTitle(openAdmin ? 'Admin Portal — استيراد وحفظ البيانات' : 'Agent Dashboard — قراءة النتائج')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * ============================================================================
 * استقبال وحفظ البيانات المرسلة من إضافة المتصفح فقط عبر POST
 * مع منع التكرار نهائياً وتحديث البيانات القائمة فقط
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
    const dateStr = payload.date || Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM-dd');
    let summaryCount = 0;
    let drillCount = 0;

    // 1. إذا تم إرسال مصفوفة الوكلاء الملخصة (agents أو summaryAgents) من الجدول الرئيسي
    const agentsList = payload.agents || payload.summaryAgents || (Array.isArray(payload) ? payload : null);
    if (agentsList && Array.isArray(agentsList) && agentsList.length > 0) {
      saveAgentsToSheet(agentsList, dateStr);
      summaryCount = agentsList.length;
    }

    // 2. إذا تم إرسال نتائج المقاييس التفصيلية (results) الناتجة عن الـ Drills
    if (payload.results && Array.isArray(payload.results) && payload.results.length > 0) {
      saveExtensionResultsToSheet(payload.results, dateStr, summaryCount === 0);
      drillCount = payload.results.length;
    }

    const logMsg = `مزامنة بدون تكرار: (${summaryCount}) وكيل ملخص، و (${drillCount}) مقياس تفصيلي لتاريخ ${dateStr}.`;
    logSystemEvent("SUCCESS", "Extension Sync", logMsg);

    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      summaryCount: summaryCount,
      drillCount: drillCount,
      date: dateStr,
      message: `تم حفظ وتحديث البيانات بنجاح في Google Sheet بدون تكرار! (${summaryCount} وكيل، ${drillCount} مقياس)`
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
 * قراءة بيانات النظرة العامة للوكلاء — حصرياً ومباشرة من Google Sheet
 * ============================================================================
 */
function getOverviewData() {
  try {
    const ss = getTargetSpreadsheet();
    if (!ss) {
      return {
        success: false,
        isEmpty: true,
        agents: [],
        summary: { totalAgents: 0, avgCsat: "—", totalLateness: "—", lastSync: "—", totalDrillRows: 0 },
        message: "تعذر فتح Google Sheet. يرجى التأكد من تحديد SPREADSHEET_ID أو تشغيل السكربت داخل الشيت."
      };
    }

    const summarySheet = ss.getSheetByName(CONFIG.SHEET_SUMMARY);
    if (!summarySheet || summarySheet.getLastRow() <= 1) {
      return {
        success: true,
        isEmpty: true,
        agents: [],
        summary: { totalAgents: 0, avgCsat: "—", totalLateness: "—", lastSync: "—", totalDrillRows: 0 },
        message: "لا توجد بيانات مسجلة في الشيت حتى الآن. افتح صفحة العمل واستخدم الإضافة للضغط على ☁️ مزامنة سريعة إلى Google Sheets."
      };
    }

    const lastRow = summarySheet.getLastRow();
    const data = summarySheet.getRange(2, 1, lastRow - 1, 11).getValues();

    const agents = [];
    let totalCsat = 0, countCsat = 0;
    let totalLateness = 0;
    let latestUpdateTime = "";

    data.forEach(row => {
      const email = String(row[2] || "").trim();
      if (!email) return;

      const csatVal = parseFloat(row[3]) || 0;
      const latenessVal = parseFloat(row[7]) || 0;
      if (csatVal > 0) {
        totalCsat += csatVal;
        countCsat++;
      }
      totalLateness += latenessVal;

      let dateFormatted = row[0];
      if (row[0] instanceof Date) {
        dateFormatted = Utilities.formatDate(row[0], 'Asia/Riyadh', 'yyyy-MM-dd');
      }

      let updatedFormatted = row[10];
      if (row[10] instanceof Date) {
        updatedFormatted = Utilities.formatDate(row[10], 'Asia/Riyadh', 'HH:mm');
      }
      if (!latestUpdateTime && updatedFormatted) {
        latestUpdateTime = String(updatedFormatted);
      }

      agents.push({
        date: dateFormatted,
        name: String(row[1] || email.split("@")[0]),
        email: email,
        csat: csatVal,
        agbt: String(row[4] || "00:00"),
        abst: String(row[5] || "00:00"),
        breakBreach: String(row[6] || "0"),
        lateness: latenessVal,
        idle: String(row[8] || "0"),
        productivity: String(row[9] || "0%"),
        updatedAt: updatedFormatted || "—"
      });
    });

    // قراءة عدد صفوف الـ Drills التفصيلية وحساب الاتجاهات اليومية من السجلات الحقيقية (Header + Rows JSON)
    let totalDrillRows = 0;
    const drillSheet = ss.getSheetByName(CONFIG.SHEET_DRILLS);
    const dailyAggregates = {};
    if (drillSheet && drillSheet.getLastRow() > 1) {
      const drillRows = drillSheet.getRange(2, 1, drillSheet.getLastRow() - 1, 7).getValues();
      for (const r of drillRows) {
        let d = r[0];
        if (d instanceof Date) d = Utilities.formatDate(d, 'Asia/Riyadh', 'yyyy-MM-dd');
        d = String(d || '').trim();
        if (!d) continue;

        const metric = String(r[2] || '').trim().toLowerCase();
        let header = [];
        let rows = [];
        try { header = JSON.parse(r[4] || '[]'); } catch (e) { header = []; }
        try { rows = JSON.parse(r[5] || '[]'); } catch (e) { rows = []; }

        if (Array.isArray(rows)) totalDrillRows += rows.length;
        if (!Array.isArray(rows) || rows.length === 0) continue;

        if (!dailyAggregates[d]) {
          dailyAggregates[d] = { day: d, sessions: 0, abstSecsSum: 0, abstCount: 0, agbtSecsSum: 0, agbtCount: 0, csatGood: 0, csatBad: 0, long: 0 };
        }
        const agg = dailyAggregates[d];

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
      }
    }

    // تحويل الأيام إلى مصفوفة نظيفة مع استبعاد الأيام بدون جلسات فعلية
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
      message: "حدث خطأ أثناء قراءة بيانات الشيت: " + err.message
    };
  }
}

/**
 * ============================================================================
 * قراءة البيانات التفصيلية (Drill Records) لوكيل معين ومقياس معين من الشيت
 * ============================================================================
 */
function getAgentDetailData(email, metric) {
  try {
    const ss = getTargetSpreadsheet();
    if (!ss) {
      return { success: false, found: false, message: "تعذر فتح Google Sheet." };
    }

    // 1. إذا كان المطلوب "كل الوكلاء" (All Agents)
    if (!email || email === 'all' || email === '') {
      return getAllAgentsMetricSummary(ss, metric);
    }

    // 2. إذا كان المطلوب وكيلاً محدداً
    const drillSheet = ss.getSheetByName(CONFIG.SHEET_DRILLS);
    if (!drillSheet || drillSheet.getLastRow() <= 1) {
      return {
        success: true,
        found: false,
        email: email,
        metric: metric,
        header: [],
        rows: [],
        count: 0,
        message: "لا توجد سجلات تفصيلية محفوظة في ورقة Drill_Archive حتى الآن."
      };
    }

    const lastRow = drillSheet.getLastRow();
    const data = drillSheet.getRange(2, 1, lastRow - 1, 7).getValues();

    const targetEmail = email.trim().toLowerCase();
    const targetMetric = (metric || "csat").trim().toLowerCase();

    // البحث من الأحدث إلى الأقدم
    for (let i = data.length - 1; i >= 0; i--) {
      const rowEmail = String(data[i][1] || "").trim().toLowerCase();
      const rowMetric = String(data[i][2] || "").trim().toLowerCase();

      if (rowEmail === targetEmail && rowMetric === targetMetric) {
        let header = [];
        let rows = [];

        try { header = JSON.parse(data[i][4] || "[]"); } catch (e) { header = []; }
        try { rows = JSON.parse(data[i][5] || "[]"); } catch (e) { rows = []; }

        const recCount = Array.isArray(rows) ? rows.length : 0;

        return {
          success: true,
          found: true,
          isAllAgents: false,
          email: email,
          metric: metric,
          title: String(data[i][3] || ""),
          header: header,
          rows: rows,
          count: recCount,
          date: String(data[i][0] || ""),
          savedAt: String(data[i][6] || "")
        };
      }
    }

    return {
      success: true,
      found: false,
      isAllAgents: false,
      email: email,
      metric: metric,
      header: [],
      rows: [],
      count: 0,
      message: `لم يتم العثور على سجلات تفصيلية لمقياس (${metric}) لهذا الوكيل. يمكنك سحبها من الإضافة ثم الضغط على مزامنة.`
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
 * دالة مساعدة لتوليد جدول مقارنة جميع الوكلاء لمقياس معين بدون تفاصيل التذاكر الفردية
 * يطابق متطلب: "إذا كنت في وضع كل الوكلاء يطلع كل الاجينت كجدول مع رقم الميركش الخاص بهم بدون أي تفاصيل"
 */
function getAllAgentsMetricSummary(ss, metric) {
  const summarySheet = ss.getSheetByName(CONFIG.SHEET_SUMMARY);
  if (!summarySheet || summarySheet.getLastRow() <= 1) {
    return {
      success: true,
      found: false,
      isAllAgents: true,
      metric: metric,
      header: [],
      rows: [],
      message: "لا توجد بيانات مسجلة في الشيت حتى الآن."
    };
  }

  const lastRow = summarySheet.getLastRow();
  const data = summarySheet.getRange(2, 1, lastRow - 1, 11).getValues();
  const m = (metric || "csat").toLowerCase();

  let header = ["الترتيب", "اسم الوكيل", "البريد الإلكتروني", "قيمة المقياس", "الحالة والتقييم"];
  let metricColIdx = 3; // CSAT default
  let metricLabel = "CSAT %";

  if (m === "agbt") { metricColIdx = 4; metricLabel = "AGBT (المناولة)"; }
  else if (m === "abst") { metricColIdx = 5; metricLabel = "ABST (سرعة الرد)"; }
  else if (m === "breakbreach" || m === "break") { metricColIdx = 6; metricLabel = "تجاوزات البريك"; }
  else if (m === "lateness") { metricColIdx = 7; metricLabel = "دقائق التأخير"; }
  else if (m === "idle") { metricColIdx = 8; metricLabel = "وقت الخمول"; }
  else if (m === "productivity") { metricColIdx = 9; metricLabel = "الإنتاجية"; }

  header[3] = metricLabel;

  const rows = [];
  data.forEach((row, idx) => {
    const name = String(row[1] || "").trim();
    const email = String(row[2] || "").trim();
    if (!email) return;

    const val = row[metricColIdx];
    let displayVal = String(val ?? "—");
    let status = "طبيعي";

    if (m === "csat") {
      const num = parseFloat(val) || 0;
      displayVal = num + "%";
      status = num >= 90 ? "ممتاز 🟢" : (num >= 80 ? "جيد 🟡" : "يحتاج تحسين 🔴");
    } else if (m === "abst") {
      // ABST: كلما قل الرقم كان إيجابياً (استجابة أسرع)، وكلما زاد كان سلبياً (بطيء)
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
 * حفظ وتحديث ملخص الوكلاء في Google Sheet مع منع التكرار نهائياً
 * ============================================================================
 */
function saveAgentsToSheet(agents, dateStr) {
  const ss = getTargetSpreadsheet();
  if (!ss) throw new Error("تعذر فتح ملف Google Sheet. تأكد من تحديد SPREADSHEET_ID أو تشغيل السكربت داخل الشيت.");

  // 1. ورقة Daily_Summary
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

  // 2. ورقة Historical_Archive
  let archiveSheet = ss.getSheetByName(CONFIG.SHEET_ARCHIVE);
  if (!archiveSheet) {
    archiveSheet = ss.insertSheet(CONFIG.SHEET_ARCHIVE);
    archiveSheet.setRightToLeft(true);
    archiveSheet.appendRow([
      "التاريخ", "اسم الوكيل", "البريد الإلكتروني", "CSAT %", "AGBT", "ABST", 
      "تأخيرات البريك", "دقائق التأخير", "وقت الخمول", "الإنتاجية", "وقت التسجيل"
    ]);
    archiveSheet.getRange("A1:K1").setFontWeight("bold").setBackground("#0f172a").setFontColor("#38bdf8");
    archiveSheet.setFrozenRows(1);
  }

  const nowStr = Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM-dd HH:mm:ss');

  // --- بناء فهرس السجلات الحالية في Daily_Summary لمنع التكرار ---
  const summaryLastRow = summarySheet.getLastRow();
  const summaryEmailMap = {}; // email -> row index (1-based)
  if (summaryLastRow > 1) {
    const emailsData = summarySheet.getRange(2, 3, summaryLastRow - 1, 1).getValues();
    for (let i = 0; i < emailsData.length; i++) {
      const em = String(emailsData[i][0] || "").trim().toLowerCase();
      if (em) summaryEmailMap[em] = i + 2;
    }
  }

  // --- بناء فهرس السجلات الحالية في Historical_Archive لمنع التكرار (Date + Email) ---
  const archiveLastRow = archiveSheet.getLastRow();
  const archiveKeyMap = {}; // "date|email" -> row index (1-based)
  if (archiveLastRow > 1) {
    const archiveData = archiveSheet.getRange(2, 1, archiveLastRow - 1, 3).getValues();
    for (let i = 0; i < archiveData.length; i++) {
      let dVal = archiveData[i][0];
      if (dVal instanceof Date) dVal = Utilities.formatDate(dVal, 'Asia/Riyadh', 'yyyy-MM-dd');
      else dVal = String(dVal).trim();
      const emVal = String(archiveData[i][2] || "").trim().toLowerCase();
      if (dVal && emVal) archiveKeyMap[dVal + "|" + emVal] = i + 2;
    }
  }

  const newSummaryRows = [];
  const newArchiveRows = [];

  agents.forEach(a => {
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

    // 1. تحديث أو إضافة في Daily_Summary
    if (summaryEmailMap[emLower]) {
      // تحديث الصف القائم في مكانه دون إضافة أي سطر مكرر
      summarySheet.getRange(summaryEmailMap[emLower], 1, 1, rowValues.length).setValues([rowValues]);
    } else {
      newSummaryRows.push(rowValues);
      summaryEmailMap[emLower] = summaryLastRow + newSummaryRows.length;
    }

    // 2. تحديث أو إضافة في Historical_Archive
    const archKey = dateStr + "|" + emLower;
    if (archiveKeyMap[archKey]) {
      // مسجل مسبقاً لهذا التاريخ -> تحديث الأرقام
      archiveSheet.getRange(archiveKeyMap[archKey], 1, 1, rowValues.length).setValues([rowValues]);
    } else {
      newArchiveRows.push(rowValues);
      archiveKeyMap[archKey] = archiveLastRow + newArchiveRows.length;
    }
  });

  if (newSummaryRows.length > 0) {
    summarySheet.getRange(summarySheet.getLastRow() + 1, 1, newSummaryRows.length, newSummaryRows[0].length).setValues(newSummaryRows);
  }
  if (newArchiveRows.length > 0) {
    archiveSheet.getRange(archiveSheet.getLastRow() + 1, 1, newArchiveRows.length, newArchiveRows[0].length).setValues(newArchiveRows);
  }
}

/**
 * ============================================================================
 * حفظ وتحديث نتائج الـ Drills التفصيلية في ورقة Drill_Archive مع منع التكرار
 * يتم تسجيل البيانات كأعمدة وصفوف نظيفة وطبيعية تماماً (بدون تكديس JSON في الخلايا)
 * المفتاح الفريد: (التاريخ + البريد الإلكتروني + المقياس)
 * ============================================================================
 */
function saveExtensionResultsToSheet(results, dateStr, shouldUpdateSummary) {
  const ss = getTargetSpreadsheet();
  if (!ss) throw new Error("تعذر فتح ملف Google Sheet. تأكد من تحديد SPREADSHEET_ID أو تشغيل السكربت داخل الشيت.");

  let drillSheet = ss.getSheetByName(CONFIG.SHEET_DRILLS);
  if (!drillSheet) {
    drillSheet = ss.insertSheet(CONFIG.SHEET_DRILLS);
    drillSheet.setRightToLeft(true);
    drillSheet.appendRow([
      "التاريخ", "البريد الإلكتروني", "المقياس", "العنوان", 
      "ترويسة الأعمدة (JSON)", "الصفوف (JSON)", "وقت الحفظ"
    ]);
    drillSheet.getRange("A1:G1").setFontWeight("bold").setBackground("#0f172a").setFontColor("#38bdf8");
    drillSheet.setFrozenRows(1);
  }

  const nowStr = Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM-dd HH:mm:ss');

  // --- بناء فهرس السجلات الحالية في Drill_Archive لمنع التكرار ---
  const lastRow = drillSheet.getLastRow();
  const drillKeyMap = {}; // "date|email|metric" -> row index (1-based)
  if (lastRow > 1) {
    const existingDrills = drillSheet.getRange(2, 1, lastRow - 1, 3).getValues();
    for (let i = 0; i < existingDrills.length; i++) {
      let d = existingDrills[i][0];
      if (d instanceof Date) d = Utilities.formatDate(d, 'Asia/Riyadh', 'yyyy-MM-dd');
      else d = String(d).trim();
      const em = String(existingDrills[i][1] || "").trim().toLowerCase();
      const met = String(existingDrills[i][2] || "").trim().toLowerCase();
      if (d && em && met) drillKeyMap[d + "|" + em + "|" + met] = i + 2;
    }
  }

  const newDrillRows = [];
  const agentSummaries = {};

  results.forEach(res => {
    const agent = (res.agent || "").trim();
    const metric = (res.metric || "").trim();
    const rows = res.rows || [];
    if (!agent || !metric) return;

    // تطبيع السجل التفصيلي (Header ثابت + Rows مصفوفة) ثم تخزينه كاملاً ليظل قابلاً للقراءة والعرض لاحقاً
    const normalized = normalizeDrillRecord(res.header || [], rows);

    const rowValues = [
      dateStr,
      agent,
      metric.toUpperCase(),
      String(res.title || `${metric.toUpperCase()} - ${agent}`).substring(0, 200),
      JSON.stringify(normalized.header),
      JSON.stringify(normalized.rows),
      nowStr
    ];

    const drillKey = dateStr + "|" + agent.toLowerCase() + "|" + metric.toLowerCase();
    if (drillKeyMap[drillKey]) {
      // تحديث السجل القائم لنفس اليوم والوكيل والمقياس
      drillSheet.getRange(drillKeyMap[drillKey], 1, 1, rowValues.length).setValues([rowValues]);
    } else {
      newDrillRows.push(rowValues);
      drillKeyMap[drillKey] = lastRow + newDrillRows.length;
    }

    // استخراج ملخص الوكيل إذا لزم الأمر
    if (shouldUpdateSummary) {
      if (!agentSummaries[agent]) {
        agentSummaries[agent] = {
          name: agent.split("@")[0].replace(".", " "),
          email: agent,
          csat: 0,
          agbt: "00:00",
          abst: "00:00",
          breakBreach: "0",
          lateness: 0,
          idle: "0",
          productivity: "0%"
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
      } else if (metric === "breakBreach") {
        agentSummaries[agent].breakBreach = String(rows.length);
      }
    }
  });

  if (newDrillRows.length > 0) {
    drillSheet.getRange(drillSheet.getLastRow() + 1, 1, newDrillRows.length, newDrillRows[0].length).setValues(newDrillRows);
  }

  if (shouldUpdateSummary) {
    const summaryList = Object.values(agentSummaries);
    if (summaryList.length > 0) {
      saveAgentsToSheet(summaryList, dateStr);
    }
  }
}

/**
 * الحصول على كائن Spreadsheet النشط أو المحدد
 */
function getTargetSpreadsheet() {
  if (CONFIG.SPREADSHEET_ID && CONFIG.SPREADSHEET_ID.trim() !== "" && !CONFIG.SPREADSHEET_ID.includes("YOUR_")) {
    return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  }
  return SpreadsheetApp.getActiveSpreadsheet();
}

/**
 * ============================================================================
 * واجهات القراءة التي تستدعيها الواجهة الأمامية (Scripts.html)
 * ============================================================================
 */
function getDashboardDataFromSheet() {
  return getOverviewData();
}

function getAgentDrillRowsFromSheet(email, metric) {
  return getAgentDetailData(email, metric);
}

/**
 * البحث عن فهرس عمود داخل ترويسة مقروءة من السجلات (مرن تجاه الأسماء).
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

/**
 * توحيد شكل السجل التفصيلي القادم من الإضافة قبل تخزينه:
 * - تحويل الترويسة متعددة المستويات إلى ترويسة مسطحة واحدة.
 * - تحويل الصفوف الكائنية إلى مصفوفات بناءً على أسماء الأعمدة.
 */
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

/**
 * تسجيل سجلات أحداث النظام في الشيت
 */
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

/**
 * مساعدة لتضمين ملفات HTML الفرعية (Styles, Scripts) داخل Index.html
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
  * الحصول على رابط Google Sheet لفتحه من المتصفح
  */
function getSpreadsheetUrl() {
  try {
    const ss = getTargetSpreadsheet();
    return ss ? ss.getUrl() : "";
  } catch (e) {
    return "";
  }
}

/**
 * دالة استيراد وحفظ البيانات المنسوخة من بوابة الأدمن
 */
function importDataFromAdminPortal(rawJson, options) {
  try {
    options = options || { smartDates: true, updateSummary: true, updateArchive: true };
    if (!rawJson || typeof rawJson !== 'string' || !rawJson.trim()) {
      return { success: false, message: "لم يتم استلام أي نص JSON." };
    }

    const payload = JSON.parse(rawJson);
    const dateStr = payload.date || Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM-dd');
    let summaryCount = 0;
    let drillCount = 0;
    let ticketsCount = 0;

    // 1. استخراج وحفظ الوكلاء الملخصين
    const agentsList = payload.agents || payload.summaryAgents || (Array.isArray(payload) && payload[0]?.email && !payload[0]?.metric ? payload : null);
    if (agentsList && Array.isArray(agentsList) && agentsList.length > 0 && options.updateSummary !== false) {
      saveAgentsToSheet(agentsList, dateStr);
      summaryCount = agentsList.length;
    }

    // 2. استخراج وحفظ مقاييس الـ Drills التفصيلية
    const results = payload.results || (Array.isArray(payload) && payload[0]?.metric ? payload : null);
    if (results && Array.isArray(results) && results.length > 0) {
      saveExtensionResultsToSheet(results, dateStr, summaryCount === 0);
      drillCount = results.length;
      results.forEach(r => {
        if (r.rows && Array.isArray(r.rows)) ticketsCount += r.rows.length;
      });

      if (summaryCount === 0) {
        summaryCount = new Set(results.map(r => r.agent).filter(Boolean)).size;
      }
    }

    const logMsg = `استيراد من بوابة الأدمن: (${summaryCount}) وكيل، و (${drillCount}) مقياس، و (${ticketsCount}) تذكرة لتاريخ ${dateStr}.`;
    logSystemEvent("SUCCESS", "Admin Portal Import", logMsg);

    return {
      success: true,
      agentsCount: summaryCount,
      drillCount: drillCount,
      ticketsCount: ticketsCount,
      date: dateStr,
      message: `تم بنجاح حفظ وتحديث البيانات في Google Sheet!`
    };

  } catch (err) {
    logSystemEvent("ERROR", "Admin Portal Failed", err.message);
    return {
      success: false,
      message: err.message
    };
  }
}

