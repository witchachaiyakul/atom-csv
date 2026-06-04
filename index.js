const express = require('express');
const { Storage } = require('@google-cloud/storage');
const { Firestore } = require('@google-cloud/firestore');
const csv = require('csv-parse'); 

const app = express();
app.use(express.json()); 

const firestore = new Firestore();
const storage = new Storage();

// 🎯 มาตรฐานชื่อร้าน 5 ร้านหลักตามระเบียบเดิมของพี่วิชชา
const ALLOWED_STORES = ['Atom', 'Atom_Beach', 'Good_Time', 'Paradise', 'Tiger_King_Bar_&_Bistro'];

/**
 * 🧼 ฟังก์ชันล้างค่าและจัดการชื่อร้านให้ตรงกับมาตรฐานฐานข้อมูล (ดึงมาจากโค้ดเดิมของพี่เป๊ะๆ)
 */
function getUnifiedShopName(rawShop) {
  if (!rawShop) return "Unknown";
  
  const lookupKey = rawShop.toString().toLowerCase().replace(/[\s_\-]+/g, '').trim();
  
  const shopMap = {
    'atom':                 'Atom',        
    'atombeach':            'Atom_Beach',  
    'goodtime':             'Good_Time',   
    'paradise':             'Paradise',    
    'tiger':                'Tiger_King_Bar_&_Bistro',
    'tigerking':            'Tiger_King_Bar_&_Bistro', 
    'tigerkingbarbistro':   'Tiger_King_Bar_&_Bistro',
    'tigerkingbar&bistro':  'Tiger_King_Bar_&_Bistro',
    'office':               'Office',
    'ส่วนกลาง':              'Office',
    'kitchen':              'ครัวกลาง',
    'mainkitchen':          'ครัวกลาง',
    'ครัวกลาง':              'ครัวกลาง'
  };
  
  return shopMap[lookupKey] || rawShop.trim();
}

app.post('/', async (req, res) => {
  const { bucket, name } = req.body;
  console.log(`🚀 กำลังประมวลผลไฟล์: ${name}`);
  
  if (!bucket || !name) {
    return res.status(400).send('Missing bucket or name');
  }
  
  try {
    const file = storage.bucket(bucket).file(name);
    
    // 🔍 1. แตก Path เพื่อหาประเภทรายงาน และ ชื่อร้านค้าต้นทางจากโฟลเดอร์บน Storage
    // โครงสร้าง: ocha/raw_reports/Payment/Atom/2026/06/Atom_Payment_2026-06-02.csv
    const pathParts = name.split('/');
    const reportType = pathParts[2] || 'Payment'; // Payment, Discounts, BestSeller
    const rawStore = pathParts[3] || 'Unknown';
    
    // นำชื่อร้านดิบที่แกะจาก Path ไปผ่านตัวกรอง Unified ให้เป็นชื่อมาตรฐานของพี่
    const standardStore = getUnifiedShopName(rawStore);
    
    // กำหนดชื่อคอลเลกชันหลักปลายทางให้ล้อตามประเภทรายงาน
    let collectionName = 'income'; 
    if (reportType === 'Discounts') collectionName = 'discounts';
    if (reportType === 'BestSeller') collectionName = 'bestseller';

    // 🔍 2. ดึงเฉพาะชื่อไฟล์ตัวท้ายสุด เพื่อแกะวันที่ (รูปแบบ YYYY-MM-DD)
    const fileName = pathParts[pathParts.length - 1];
    const dateMatch = fileName.match(/\d{4}-\d{2}-\d{2}/); 
    const docDateId = dateMatch ? dateMatch[0] : null; // ได้ค่าเป็น '2026-06-02'

    if (!docDateId) {
      console.log(`⚠️ ไม่พบรูปแบบวันที่ในชื่อไฟล์: ${fileName}`);
      return res.status(400).send('Invalid file name format (Missing Date)');
    }

    // 🔍 3. สับไฟล์ CSV และดูดข้อมูลลงอาร์เรย์
    const parser = file.createReadStream().pipe(csv.parse({ columns: true, skip_empty_lines: true }));
    const allRows = [];
    
    for await (const row of parser) {
      allRows.push(row);
    }

    // 🔍 4. 🎯 ยิงข้อมูลลงพิกัดโครงสร้างแบบเจาะจงห้องของพี่วิชชา
    // พิกัด: คอลเลกชันหลัก -> ชื่อร้านมาตรฐาน -> daily_records -> เอกสารชื่อวันที่
    await firestore
      .collection(collectionName)
      .doc(standardStore)
      .collection('daily_records')
      .doc(docDateId)
      .set({
        records: allRows,         // อัดทุกบรรทัดใน CSV ลงที่นี่เป็นอาเรย์ชิ้นใหญ่
        total_rows: allRows.length,
        store: standardStore,     // บันทึกระบุหัวไว้ด้านในอีกชั้นเพื่อความชัวร์
        report_type: reportType,
        importedAt: new Date()
      }, { merge: true });        // ใช้ merge เผื่อมีการอัปเดตไฟล์เดิม ข้อมูลอื่นจะไม่พังครับ

    console.log(`✅ [SUCCESS] บันทึกข้อมูลร้าน ${standardStore} ของวันที่ ${docDateId} ลงใน ${collectionName}/.../daily_records เรียบร้อยแล้ว! (จำนวน ${allRows.length} แถว)`);
    res.status(200).send('Processed!');

  } catch (error) {
    console.error('❌ เกิดข้อผิดพลาดในการประมวลผลไฟล์:', error);
    res.status(500).send(`Error: ${error.message}`);
  }
});

app.listen(8080, () => console.log('Server ready'));