# لوحة تحكم أداء الوكلاء — Google Apps Script & Drive Database

مشروع متكامل ومستقل يعمل 100% داخل بيئة **Google Workspace** في نطاق الشركة بدون الحاجة لأي خوادم خارجية، ويعتمد على **Google Drive (`DriveApp`)** كقاعدة بيانات سحابية سريعة وغير محدودة.

---

## 🌟 مميزات المشروع

1. **قاعدة بيانات Google Drive السحابية (`DriveApp`):**
   - تم القضاء نهائياً على خطأ "الـ 50 ألف حرف" في Google Sheets.
   - يتم تخزين مئات وآلاف التذاكر والـ Drills داخل مجلد مخصص في درايف الشركة باسم: `Agent_Performance_Hub_Data`.
   - استيعاب غير محدود للبيانات والصفوف وبسرعة استرجاع فائقة (أقل من ثانية).
2. **منع التكرار الذكي (Deduplication):**
   - تحديث السجلات القائمة لنفس اليوم والوكيل والمقياس تلقائياً دون أي تكرار تراكمي للأرقام.
3. **تزامن إداري اختياري مع Google Sheets:**
   - تحديث تلقائي لجدول الملخص العام اليومي في Google Sheet لمن يحب الاطلاع على التقارير السريعة بصيغة جداول، وبدون حشر أي JSON في الخلايا.
4. **نظرة عامة متكاملة (Overview) وتحليل تفصيلي عميق (Drill-down View):**
   - مطابقة تامة مع واجهة `agent-dashboard-viewer.html` من حيث الفلاتر الذكية، الألوان، الرسوم البيانية التفاعلية SVG، واستعراض التذاكر الفردية.

---

## 📁 هيكل ملفات المشروع

### 1. الملفات الأساسية للرفع إلى Google Apps Script (المجلد الرئيسي فقط):
```
gas-agent-dashboard/
├── Code.gs             # الباك إند السحابي (محرك قاعدة بيانات Drive المقسمة شهرياً، وتخديم Web App)
├── Index.html          # واجهة الداشبورد الرئيسية (مدمج بها نافذة الإدارة وترحيل البيانات)
├── Styles.html         # تنسيقات الواجهة CSS
├── Scripts.html        # جافاسكربت الواجهة وتفاعلات الفلاتر والمخططات
├── appsscript.json     # ملف الإعدادات والصلاحيات والمنطقة الزمنية
└── local-dev/          # مجلد الأدوات المحلية (لا يُرفع إلى GAS)
```

> **ملاحظة هامة:** فقط الملفات الـ 5 أعلاه هي التي يتم نسخها/رفعها إلى `script.google.com`. المجلد الفرعي `local-dev/` يحتوي على المعاينة المحلية والبيانات التجريبية والتوثيق، ولا حاجة لرفعه.

---

## 🚀 طريقة التثبيت والنشر في Google Apps Script خطوة بخطوة

### الخطوة 1: إنشاء أو فتح مشروع Google Apps Script
1. افتح [Google Sheets](https://sheets.google.com) أو ادخل مباشرة على [script.google.com](https://script.google.com).
2. أنشئ مشروعاً جديداً باسم: `Agent Performance Hub`.

### الخطوة 2: نسخ الملفات
في محرر Google Apps Script، انسخ الملفات الخمسة الأساسية فقط:
1. افتح ملف `Code.gs`، واستبدل محتواه بمحتوى ملف [`Code.gs`](file:///d:/UserData/Desktop/tabby/gas-agent-dashboard/Code.gs).
2. اضغط `+` واختر **HTML** وسمّه: `Index`، والصق فيه محتوى [`Index.html`](file:///d:/UserData/Desktop/tabby/gas-agent-dashboard/Index.html).
3. اضغط `+` واختر **HTML** وسمّه: `Styles`، والصق فيه محتوى [`Styles.html`](file:///d:/UserData/Desktop/tabby/gas-agent-dashboard/Styles.html).
4. اضغط `+` واختر **HTML** وسمّه: `Scripts`، والصق فيه محتوى [`Scripts.html`](file:///d:/UserData/Desktop/tabby/gas-agent-dashboard/Scripts.html).
5. من إعدادات المشروع (Project Settings)، فعّل خيار `Show "appsscript.json" manifest file in editor`، والصق فيه محتوى [`appsscript.json`](file:///d:/UserData/Desktop/tabby/gas-agent-dashboard/appsscript.json).

### الخطوة 3: نشر لوحة التحكم (Deploy Web App)
1. في أعلى يمين محرر السكربت، اضغط على **Deploy** ثم **New deployment**.
2. اختر نوع النشر: **Web app**.
3. في خانة **Execute as**، اختر: `Me` (حسابك - حتى يتمكن جميع أعضاء الفريق من القراءة من قاعدة بيانات Drive المشتركة).
4. في خانة **Who has access**، اختر: `Anyone within your organization` (أي شخص في نطاق ورك سبيس الشركة).
5. اضغط **Deploy** وانسخ رابط الـ Web App الناتج.

---

## 💡 كيفية إدخال وتحديث البيانات
1. بعد تشغيل أداة الجمع في صفحة العمل، اضغط **(نسخ النتائج)**.
2. افتح رابط التطبيق المنشور، ثم اضغط زر **⚙️ Admin** (أو أضف `?page=admin` في نهاية الرابط).
3. الصق النص في المربع الكبير واضغط **(حفظ ومزامنة البيانات في Google Drive)**.
4. سيتم حفظ كافة التذاكر في مجلد `Agent_Performance_Hub_Data` في درايف الشركة فوراً وبدون أي أخطاء!

> **الصلاحيات:** يجب أن تكون ضمن المدراء (أو قائمة المستخدمين المصرح لهم) لفتح اللوحة، وزر الاستيراد متاح للمدراء فقط.
