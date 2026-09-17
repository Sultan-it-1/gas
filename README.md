# لوحة تحكم أداء الوكلاء — Google Apps Script (النسخة المستقلة)

مشروع متكامل ومستقل يعمل 100% داخل بيئة **Google Workspace** بدون الحاجة لأي إضافة متصفح (Extension)، وبدون أي خوادم خارجية.

---

## 🌟 مميزات المشروع

1. **أتمتة الجلب اليومي (11:00 PM):** مجدول زمني أوتوماتيكي يسحب بيانات الوكلاء الـ 31 ويخزنها يومياً بدون أي تدخل بشري.
2. **حفظ وأرشفة دائمة في Google Sheets:** حماية البيانات من التصفير الشهري الذي يحدث في النظام المصدر عبر الاحتفاظ بـ `Historical_Archive`.
3. **سرعة العرض الفائقة:** قراءة البيانات مباشرة من شيت التخزين الداخلي مما يجعل الداشبورد يفتح فوراً لجميع أعضاء الفريق.
4. **نظرة عامة متكاملة (Overview):** شاشة رئيسية تعرض ملخص أداء الفريق بالكامل وبطاقات لجميع الـ 31 وكيلاً في لمحة واحدة.
5. **تحليل تفصيلي عميق (Drill-down View):** بمجرد النقر على أي وكيل، تفتح واجهة تحليل احترافية بجميع المقاييس (CSAT, AGBT, ABST, Break Breach, Lateness, Idle) مع فلاتر التاريخ والقنوات والترتيب.

---

## 📁 هيكل ملفات المشروع

```
gas-agent-dashboard/
├── Code.gs             # الباك إند (الجلب بـ UrlFetchApp، المجدول الزمني 11 PM، الحفظ في الشيت، تخديم Web App)
├── Index.html          # الهيكل العام للواجهة (النظرة العامة + العرض التفصيلي)
├── Styles.html         # ملف التصميم الجمالي والستايلات العصرية
├── Scripts.html        # ملف الجافاسكربت لإدارة الفلاتر والتفاعل واستدعاء السيرفر
├── appsscript.json     # ملف الإعدادات والصلاحيات لبيئة Workspace
├── preview.html        # ملف المعاينة المحلية (يمكن فتحه مباشرة في المتصفح لرؤية الواجهة)
└── README.md           # هذا الدليل التوضيحي
```

---

## 🚀 طريقة التثبيت والنشر في Google Apps Script خطوة بخطوة

### الخطوة 1: إنشاء مشروع Google Apps Script جديد
1. افتح [Google Sheets](https://sheets.google.com) وأنشئ شيت جديد باسم: `Agent Performance Database`.
2. من القائمة العلوية للشيت، اضغط على **Extensions** (الإضافات) ثم **Apps Script**.
3. أعد تسمية المشروع إلى: `Agent Performance Hub`.

### الخطوة 2: نسخ الملفات
في محرر Google Apps Script:
1. افتح ملف `Code.gs` الافتراضي، واستبدل محتواه بالكامل بمحتوى ملف [`Code.gs`](file:///d:/UserData/Desktop/tabby/gas-agent-dashboard/Code.gs).
2. اضغط على علامة الزائد `+` بجانب Files واختر **HTML** وسمّه: `Index`، والصق فيه محتوى [`Index.html`](file:///d:/UserData/Desktop/tabby/gas-agent-dashboard/Index.html).
3. اضغط `+` واختر **HTML** وسمّه: `Styles`، والصق فيه محتوى [`Styles.html`](file:///d:/UserData/Desktop/tabby/gas-agent-dashboard/Styles.html).
4. اضغط `+` واختر **HTML** وسمّه: `Scripts`، والصق فيه محتوى [`Scripts.html`](file:///d:/UserData/Desktop/tabby/gas-agent-dashboard/Scripts.html).

### الخطوة 3: ضبط الإعدادات في `Code.gs`
في بداية ملف `Code.gs`، ستجد كائن الإعدادات `CONFIG`:
```javascript
const CONFIG = {
  // ضع هنا رابط الـ Web App المصدر الموجود داخل ورك سبيس العمل
  SOURCE_WEBAPP_URL: "https://script.google.com/macros/s/YOUR_SOURCE_SCRIPT_ID/exec",
  
  // اتركه فارغاً إذا فتحت السكربت من داخل الشيت مباشرة
  SPREADSHEET_ID: "", 

  SHEET_SUMMARY: "Daily_Summary",
  SHEET_ARCHIVE: "Historical_Archive",
  SHEET_LOGS: "System_Logs",
  
  DAILY_TRIGGER_HOUR: 23 // الساعة 11:00 PM بتوقيت الرياض
};
```

### الخطوة 4: تفعيل المجدول التلقائي (11:00 PM)
1. من القائمة المنسدلة لاختيار الدوال في أعلى محرر السكربت، اختر دالة: **`setupDailyTrigger`**.
2. اضغط على زر **Run (تشغيل)**.
3. سيطلب منك Google منح الصلاحيات (Review Permissions) بحساب العمل الخاص بك، وافق عليها.
4. بمجرد اكتمال التشغيل، سيتم تفعيل المؤقت ليعمل تلقائياً كل يوم الساعة 11:00 مساءً.

### الخطوة 5: نشر لوحة التحكم (Deploy Web App)
1. في أعلى يمين محرر السكربت، اضغط على **Deploy** ثم **New deployment**.
2. اختر نوع النشر: **Web app**.
3. في خانة **Execute as**، اختر: `User accessing the web app` أو `Me`.
4. في خانة **Who has access**، اختر: `Anyone within your organization` (أي شخص داخل نطاق ورك سبيس العمل).
5. اضغط **Deploy** وانسخ رابط الـ Web App الناتج لتوزيعه على الفريق أو استخدامه مباشرة!

---

## 🧪 المعاينة المحلية
يمكنك تجربة الواجهة والتفاعل معها الآن محلياً دون الحاجة لرفعها عبر فتح ملف:
[`preview.html`](file:///d:/UserData/Desktop/tabby/gas-agent-dashboard/preview.html) مباشرة في أي متصفح.
