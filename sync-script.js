/**
 * ============================================================================
 * AGENT PERFORMANCE HUB - DIRECT BROWSER PUSHER
 * ============================================================================
 * كود مزامنة مباشر وسريع: يقرأ بيانات الـ 31 وكيلاً من الصفحة المفتوحة
 * ويرسلها بضغطة زر واحدة مباشرة إلى Google Sheet عبر Web App بدون مشاكل CORS
 */

(async () => {
  // 1. ضع هنا رابط الـ Web App الخاص بك المنشور من Google Apps Script
  // مثال: https://script.google.com/macros/s/AKfycb.../exec
  const DESTINATION_WEBAPP_URL = "ضع_رابط_الويب_اب_حقك_هنا";

  console.log("⏳ جاري جمع بيانات الوكلاء من الصفحة...");

  // استخراج الوكلاء والبيانات من الجدول الظاهر
  const agents = [];
  const rows = document.querySelectorAll("tr");

  rows.forEach(tr => {
    const cells = [...tr.querySelectorAll("td")].map(td => td.innerText.trim());
    if (cells.length >= 6) {
      // البحث عن الإيميل في خلايا الصف أو من وسم .ag-em
      const emailEl = tr.querySelector(".ag-em");
      const email = emailEl?.getAttribute("title") || emailEl?.innerText?.trim() || cells.find(c => c.includes("@"));

      if (email && email.includes("@")) {
        // تنظيف وتحويل الأرقام
        const csat = parseFloat(cells[1]?.replace("%", "")) || 0;
        const agbt = cells[2] || "00:00";
        const abst = cells[3] || "00:00";
        const breakBreach = cells[4] || "0";
        const lateness = parseFloat(cells[5]) || 0;
        const idle = cells[6] || "0";
        const productivity = cells[7] || "0%";

        agents.push({
          email: email,
          name: email.split("@")[0].replace(".", " "),
          csat: csat,
          agbt: agbt,
          abst: abst,
          breakBreach: breakBreach,
          lateness: lateness,
          idle: idle,
          productivity: productivity
        });
      }
    }
  });

  // إزالة أي تكرار
  const uniqueAgents = Array.from(new Map(agents.map(a => [a.email, a])).values());

  if (uniqueAgents.length === 0) {
    alert("⚠️ لم يتم العثور على صفوف وكلاء. تأكد من فتح إطار Dashboard الصحيح واكتمال تحميل الجدول.");
    return;
  }

  console.log(`✅ تم استخراج بيانات ${uniqueAgents.length} وكيلاً. جاري الإرسال إلى Google Sheets...`);

  try {
    // إرسال البيانات عبر POST مع mode: no-cors لتخطي حظر CORS تماماً
    await fetch(DESTINATION_WEBAPP_URL, {
      method: "POST",
      mode: "no-cors",
      headers: {
        "Content-Type": "text/plain"
      },
      body: JSON.stringify({
        date: new Date().toISOString().split("T")[0],
        agents: uniqueAgents
      })
    });

    console.log("🎉 تم الإرسال بنجاح إلى Google Sheets!");

    // إظهار إشعار جميل في الصفحة
    showToast(`✅ تم بنجاح حفظ أداء ${uniqueAgents.length} وكيلاً في Google Sheets!`);

  } catch (err) {
    console.error("فشل الإرسال:", err);
    alert("❌ حدث خطأ أثناء الإرسال: " + err.message);
  }

  function showToast(msg) {
    const toast = document.createElement("div");
    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: #10b981;
      color: #ffffff;
      padding: 14px 22px;
      border-radius: 12px;
      font: bold 14px system-ui, sans-serif;
      box-shadow: 0 10px 30px rgba(0,0,0,0.3);
      z-index: 2147483647;
      direction: rtl;
      transition: all 0.3s ease;
    `;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => toast.remove(), 400);
    }, 4000);
  }
})();
