const express = require('express');
const { Storage } = require('@google-cloud/storage');
const { Firestore } = require('@google-cloud/firestore');
const csv = require('csv-parse'); 

const app = express();
app.use(express.json()); 

const firestore = new Firestore();
const storage = new Storage();

app.post('/', async (req, res) => {
  const { bucket, name } = req.body;
  console.log(`🚀 กำลังประมวลผลไฟล์: ${name}`);
  
  if (!bucket || !name) {
    return res.status(400).send('Missing bucket or name');
  }
  
  try {
    const file = storage.bucket(bucket).file(name);
    
    const fileName = name.split('/').pop(); 
    const cleanFileName = fileName.replace('.csv', '');
    const parts = cleanFileName.split('_'); 

    if (parts.length < 3) {
      console.log(`❌ [ABORT] ชื่อไฟล์ไม่ตรงตามโครงสร้างมาตรฐาน: "${fileName}"`);
      return res.status(400).send('Invalid file name structure');
    }

    // 🎯 [ปรับปรุงระบบแกะชื่อไฟล์]: แยกเคสพิเศษสำหรับชื่อรายงานยาวที่มีขีดล่าง เพื่อความปลอดภัย 100%
    let reportType = "";
    let standardStore = "";
    const docDateId = parts.pop();   // ตัวท้ายสุด = วันที่ ("2026-02-03")

    if (cleanFileName.includes('_sales_by_user_')) {
      reportType = 'sales_by_user';
      standardStore = cleanFileName.split('_sales_by_user_')[0]; // ดึงทุกคำข้างหน้าขีดล่างกลับมาทั้งหมด
    } else {
      reportType = parts.pop();  // "BestSeller", "Payment", "Discounts"
      standardStore = parts.join('_');
    }

    // ตั้งชื่อคอลเลกชันหลักปลายทางให้ล้อตามประเภทรายงาน
    let collectionName = 'income'; 
    if (reportType === 'Discounts') collectionName = 'discounts';
    if (reportType === 'BestSeller') collectionName = 'bestseller';
    if (reportType === 'sales_by_user') collectionName = 'sales_by_user'; // 🌟 เพิ่มพิกัดตระกูลโฟลเดอร์ใหม่

    console.log(`📌 [ระบบขีดล่างมาตรฐาน] รายงาน: ${collectionName} (${reportType}) | เอกสารชื่อร้านค้า: "${standardStore}" | วันที่: ${docDateId}`);

    // 🔍 สับไฟล์ CSV เป็นตารางข้อมูลดิบ
    const parser = file.createReadStream().pipe(csv.parse({ columns: false, skip_empty_lines: true }));
    const tbl = [];
    for await (const row of parser) {
      tbl.push(row.map(c => (c ?? "").toString().replace(/\u00A0/g," ").trim()));
    }

    if (!tbl.length) {
      console.log(`⏩ ข้ามไฟล์เนื่องจากไม่มีข้อมูลภายใน CSV`);
      return res.status(200).send('Empty CSV');
    }

    let processedRecords = [];

    // Helper functions สำหรับแปลงตัวเลข (คงเดิมเพื่อความแม่นยำ)
    const toMoney = (s) => {
      if (s == null) return 0;
      const raw = s.toString();
      if (/\b\d{4}[-/]\d{2}[-/]\d{2}\b/.test(raw) || /\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/.test(raw) || /\b\d{1,2}:\.?\d{2}/.test(raw)) return 0;
      const cleaned = raw.replace(/[^\d.\-]/g,"");
      if (!cleaned || /^[\-.]$/.test(cleaned)) return 0;
      const n = parseFloat(cleaned);
      return isNaN(n) ? 0 : +n.toFixed(2);
    };

    const toInt = (s) => {
      if (s == null) return 0;
      const cleaned = s.toString().replace(/[^\d\-]/g,"");
      if (!cleaned) return 0;
      const n = parseInt(cleaned, 10);
      return isNaN(n) ? 0 : n;
    };

    const toPct = (s) => {
      if (s == null) return 0;
      const cleaned = s.toString().replace(/[^\d.\-]/g,"");
      if (!cleaned) return 0;
      const n = parseFloat(cleaned);
      return isNaN(n) ? 0 : +n.toFixed(2);
    };

    // ==========================================
    // 🛠️ CASE A: ประมวลผลรายงาน PAYMENT CHANNEL
    // ==========================================
    if (reportType === 'Payment') {
      const summary = {
        Cash: 0, VISA: 0, Mastercard: 0, "Bank Transfer": 0, Other: 0,
        SplitAmount: 0, "-Cash": 0, "-VISA": 0, "-Mastercard": 0, "Total Amount Collected": 0
      };

      const keyOfPayment = (txt) => {
        const t = (txt || "").toLowerCase().replace(/\s+/g," ").trim();
        if (/(?:^\s*[-–—]\s*cash\b|\bcash\s*[-–—]\s*$|-\s*เงินสด)/i.test(t)) return "-Cash";
        if (/(?:^\s*[-–—]\s*visa\b|\bvisa\s*[-–—]\s*$|-\s*วีซ่า)/i.test(t)) return "-VISA";
        if (/(?:^\s*[-–—]\s*master\s*card\b|\bmaster\s*card\s*[-–—]\s*$|-\s*มาสเตอร์การ์ด)/i.test(t)) return "-Mastercard";
        if (/แยก\s*ตาม\s*จำนวน\s*เงิน|separate.*amount|split.*amount/i.test(t)) return "SplitAmount";
        if (/^เงินสด$|(?:^|\s)cash(?:\s|$)/.test(t)) return "Cash";
        if (/(?:^|\s)visa(?:\s|$)/.test(t)) return "VISA";
        if (/(?:^|\s)master\s*card(?:\s|$)|มาสเตอร์การ์ด/.test(t)) return "Mastercard";
        if (/bank.*transfer|โอน(เงิน)?|โอนผ่าน(ธนาคาร)?|transfer/.test(t)) return "Bank Transfer";
        if (/\bother(s)?\b|อื่นๆ|อื่น ๆ|อื่น\b/.test(t)) return "Other";
        if (/ยอด.?เงิน.?รวม.?ที่.?ได้รับ|ยอด.?รวม.*ได้รับ|^total( amount collected)?$|total amount collected/.test(t)) return "Total Amount Collected";
        return null;
      };

      const isThaiCashStrict = /^(Atom|Good_Time)$/i.test(standardStore) || /(ATOM|Good_Time)\s*-\s*ช่องทางการชำระเงิน/i.test(fileName);

      for (let r = 0; r < tbl.length; r++) {
        const row = tbl[r];
        let key = null, keyIdx = -1, rawKeyText = "";
        for (let c = 0; c < row.length; c++) {
          const k = keyOfPayment(row[c]);
          if (k) { key = k; keyIdx = c; rawKeyText = row[c]; break; }
        }
        if (!key) continue;

        let amount = NaN;
        if (isThaiCashStrict && key === "Cash" && /เงินสด/.test(rawKeyText)) {
          for (let c = row.length - 1; c > keyIdx; c--) {
            const n = toMoney(row[c]); if (n !== 0 || !isNaN(n)) { amount = n; break; }
          }
        }

        if (isNaN(amount) || amount === 0) {
          for (let c = keyIdx + 1; c <= keyIdx + 2 && c < row.length; c++) {
            const n = toMoney(row[c]); if (n !== 0) { amount = n; break; }
          }
        }
        
        if (isNaN(amount) || amount === 0) {
          for (let dr = 1; dr <= 2; dr++) {
            const rr = r + dr; if (rr >= tbl.length) break;
            for (let dc = keyIdx; dc <= keyIdx + 2; dc++) {
              const n = toMoney((tbl[rr] || [])[dc]); if (n !== 0) { amount = n; break; }
            }
            if (!isNaN(amount) && amount !== 0) break;
          }
        }

        if (!isNaN(amount) && amount !== 0) {
          if (key === "Total Amount Collected") {
            summary[key] = Math.max(summary[key] || 0, amount);
          } else {
            summary[key] += amount;
          }
        }
      }
      
      Object.keys(summary).forEach(k => { summary[k] = summary[k] ? +summary[k].toFixed(2) : 0; });
      processedRecords = [summary]; 
    }

    // ==========================================
    // 🛠️ CASE B: ประมวลผลรายงาน BEST SELLER
    // ==========================================
    else if (reportType === 'BestSeller') {
      const isHeader = (r) => {
        const t = r.join(" ").toLowerCase();
        const score = (/\bno\.?|ลำดับ/.test(t) ? 1 : 0) + (/\bitem\s*name|ชื่อ\s*สินค้า/.test(t) ? 1 : 0) +
                      (/\bcategory|ประเภท\s*สินค้า?/.test(t) ? 1 : 0) + (/\bitem\s*price|ราคา\s*สินค้า?/.test(t) ? 1 : 0) +
                      (/\bquantity\s*sold|จำนวน(ที่)?ขาย/.test(t) ? 1 : 0) + (/\bpercentage|เปอร์เซ(นต์|็นต์)/.test(t) ? 1 : 0) +
                      (/\bsales|ยอด\s*ขาย/.test(t) ? 1 : 0);
        return score >= 3;
      };

      let headerRow = -1;
      for (let i = 0; i < Math.min(tbl.length, 30); i++) { if (isHeader(tbl[i])) { headerRow = i; break; } }

      if (headerRow >= 0) {
        const h = tbl[headerRow].map(x => x.toLowerCase());
        const findIdx = (...pats) => { for (let i = 0; i < h.length; i++) if (pats.some(p => p.test(h[i]))) return i; return -1; };

        const idx = {
          no: findIdx(/\bno\.?|ลำดับ/), itemName: findIdx(/\bitem\s*name/, /ชื่อ\s*สินค้า/),
          category: findIdx(/\bcategory/, /ประเภท\s*สินค้า?/), price: findIdx(/\bitem\s*price/, /ราคา\s*สินค้า?/),
          qty: findIdx(/\bquantity\s*sold/, /จำนวน(ที่)?ขาย/), pct: findIdx(/\bpercentage/, /เปอร์เซ(นต์|็นต์)/), sales: findIdx(/\bsales/, /ยอด\s*ขาย/)
        };

        for (let r = headerRow + 1; r < tbl.length; r++) {
          const row = tbl[r];
          if (!row || row.every(x => x.trim() === "")) break;

          const rec = {
            no: idx.no >= 0 ? row[idx.no] : "",
            item_name: idx.itemName >= 0 ? row[idx.itemName] : "",
            category: idx.category >= 0 ? row[idx.category] : "",
            item_price: idx.price >= 0 ? toMoney(row[idx.price]) : 0,
            qty_sold: idx.qty >= 0 ? toInt(row[idx.qty]) : 0,
            percentage: idx.pct >= 0 ? toPct(row[idx.pct]) : 0,
            sales: idx.sales >= 0 ? toMoney(row[idx.sales]) : 0
          };
          if (rec.item_name && rec.sales !== 0) processedRecords.push(rec);
        }
      }
    }

    // ==========================================
    // 🛠️ CASE C: ประมวลผลรายงาน DISCOUNTS APPLIED
    // ==========================================
    else if (reportType === 'Discounts') {
      const joinRow = (r) => (r || []).join(" ").toLowerCase();
      const idxSummaryTitle = tbl.findIndex(r => /(discounts?\s*appl(?:ied)?\s*-\s*summary|discount.*summary|summary.*discount|สรุป.*ส่วนลดที่ใช้)/i.test(joinRow(r)));

      if (idxSummaryTitle >= 0) {
        let headerRow = -1;
        for (let i = idxSummaryTitle + 1; i < Math.min(tbl.length, idxSummaryTitle + 20); i++) {
          const t = joinRow(tbl[i]);
          const score = (/\bno\.?|ลำดับ/.test(t) ? 1 : 0) + (/ชื่อ\s*รายการ\s*ส่วนลด|discount.*name/i.test(t) ? 1 : 0) +
                        (/ประเภท\s*ส่วนลด|discount.*type/i.test(t) ? 1 : 0) + (/จำนวน|qty|quantity/i.test(t) ? 1 : 0) +
                        (/ยอด\s*ส่วนลดทั้งหมด|total.*discount/i.test(t) ? 1 : 0);
          if (score >= 3) { headerRow = i; break; }
        }

        if (headerRow >= 0) {
          let endRow = tbl.length - 1;
          for (let i = headerRow + 1; i < tbl.length; i++) {
            const t = joinRow(tbl[i]);
            if (/discounts?\s*appl(?:ied)?\s*-\s*details?/i.test(t) || tbl[i].some(c => /^total$/i.test(c.trim()))) { 
              endRow = i - 1; break; 
            }
          }

          const COL_B = 1, COL_C = 2, COL_E = 4, COL_F = 5, COL_G = 6;
          for (let r = headerRow + 1; r <= endRow; r++) {
            const row = tbl[r] || [];
            const b = (row[COL_B] || "").trim();
            if (!/^\d+$/.test(b)) continue; 

            processedRecords.push({
              no: b,
              discount_name: (row[COL_C] || "").trim(),
              discount_type: (row[COL_E] || "").trim(),
              qty: toInt(row[COL_F]),
              total_discount: toMoney(row[COL_G])
            });
          }
        }
      }
    }

    // ==========================================
    // 🌟 CASE D: ประมวลผลรายงาน SALES BY USER (เพิ่มใหม่)
    // ==========================================
    else if (reportType === 'sales_by_user') {
      let currentUser = "Unknown";
      let currentOrder = null;

      for (let r = 0; r < tbl.length; r++) {
        const row = tbl[r];
        if (!row || row.length < 6) continue;

        // 1. ดักจับและจดจำชื่อพนักงานประจำรอบล็อกอิน
        if (row[1] === 'User' || row[1] === 'พนักงาน') {
          currentUser = row[2] || "Unknown";
          continue;
        }

        // ข้ามแถวหัวตารางดิบ
        if (row[1] === 'No.' || row[1] === 'หมายเลขอ้างอิง' || row[1] === 'Sales / Reference Number') {
          continue;
        }

        const noVal = row[1];
        
        // 2. หากพบค่า No. ในแถว แสดงว่าจุดนี้คือบิลใบใหม่ (เริ่มต้นชุดหลัก)
        if (noVal && noVal !== "") {
          if (currentOrder) {
            processedRecords.push(currentOrder); // ดันบิลใบเก่าที่สะสมเสร็จแล้วเข้าชุดสรุปผล
          }

          const rawTimestamp = row[3] || "";
          let orderHour = null;
          const hourMatch = rawTimestamp.match(/(\d{2}):\d{2}:\d{2}/);
          if (hourMatch) {
            orderHour = parseInt(hourMatch[1], 10); // ตัดดึงข้อมูลชั่วโมง (0-23) ออกมาทำกลุ่มวิเคราะห์ช่วงเวลา
          }

          currentOrder = {
            no: toInt(noVal),
            reference_number: row[2] || "",
            timestamp: rawTimestamp,
            hour: orderHour, 
            type: row[4] || "",
            subtotal: toMoney(row[9]), // ดักจับจำนวนเงินรวมสุทธิของบิลใบนั้น
            user_staff: currentUser,
            items: []
          };
        }

        // 3. สะสมรายการสินค้า (Sub-items) ที่ขี่อยู่ข้างใต้บิลใบปัจจุบัน
        if (currentOrder) {
          const itemName = row[5];
          if (itemName && itemName !== "") {
            currentOrder.items.push({
              item_name: itemName,
              item_price: toMoney(row[6]),
              quantity: toInt(row[7]),
              sales: toMoney(row[8]) // ถอดราคาส่วนลดที่ติดลบลงอาร์เรย์ได้อย่างถูกต้อง
            });
          }
        }
      }

      // เก็บตกบิลใบสุดท้ายเมื่อลูปประมวลผลจนถึงแถวสุดท้ายของไฟล์
      if (currentOrder) {
        processedRecords.push(currentOrder);
      }
    }

    // 🔍 4. ยิงข้อมูลลงพิกัดห้องเวอร์ชันขีดล่างสากลใน Firestore
    await firestore
      .collection(collectionName)
      .doc(standardStore)
      .collection('daily_records')
      .doc(docDateId)
      .set({
        records: processedRecords,         
        total_rows: processedRecords.length,
        store: standardStore,     
        report_type: reportType,
        source_file: fileName,
        importedAt: new Date()
      }, { merge: true });        

    console.log(`✅ [SUCCESS] บันทึกข้อมูลเข้าห้องมาตรฐาน "${standardStore}" เรียบร้อยแล้ว!`);
    res.status(200).send('Processed!');

  } catch (error) {
    console.error('❌ เกิดข้อผิดพลาดในการประมวลผลไฟล์:', error);
    res.status(500).send(`Error: ${error.message}`);
  }
});

app.post('/test', (req, res) => {
  res.status(200).send('Test endpoint ok');
});

app.listen(8080, () => console.log('Server ready'));