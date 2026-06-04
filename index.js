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
 * 🧼 ฟังก์ชันล้างค่าและจัดการชื่อร้านให้ตรงกับมาตรฐานฐานข้อมูล
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
    
    // 🔍 1. ใช้ RegEx ดักจับประเภทรายงานและชื่อร้านค้าแบบเจาะจง (ปลอดภัยกว่าการนับ Index ของสแลช)
    const reportTypeMatch = name.match(/(Payment|Discounts|BestSeller)/i);
    let reportType = reportTypeMatch ? reportTypeMatch[1] : 'Payment';
    
    if (reportType.toLowerCase() === 'payment') reportType = 'Payment';
    if (reportType.toLowerCase() === 'discounts') reportType = 'Discounts';
    if (reportType.toLowerCase() === 'bestseller') reportType = 'BestSeller';

    let collectionName = 'income'; 
    if (reportType === 'Discounts') collectionName = 'discounts';
    if (reportType === 'BestSeller') collectionName = 'bestseller';

    const storeMatch = name.match(new RegExp(`${reportType}/([^/]+)`, 'i'));
    const rawStore = storeMatch ? storeMatch[1] : 'Unknown';
    
    const standardStore = getUnifiedShopName(rawStore);

    console.log(`📌 แกะค่าได้ -> รายงาน: ${collectionName} (${reportType}) | ร้านค้ามาตรฐาน: ${standardStore}`);

    if (!standardStore || standardStore === 'Unknown' || standardStore.trim() === '') {
      console.log(`❌ [ABORT] ปฏิเสธการบันทึกเนื่องจากชื่อร้านค้าไม่ถูกต้อง: "${rawStore}"`);
      return res.status(400).send('Invalid shop name extracted');
    }

    // 🔍 2. ดึงเฉพาะชื่อไฟล์ตัวท้ายสุด เพื่อแกะวันที่ (รูปแบบ YYYY-MM-DD)
    // แก้ไขใช้ .split('/').pop() เรียบร้อยแล้ว ชัวร์แน่นอนครับ
    const fileName = name.split('/').pop(); 
    const dateMatch = fileName.match(/\d{4}-\d{2}-\d{2}/); 
    const docDateId = dateMatch ? dateMatch[0] : null; 

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
    await firestore
      .collection(collectionName)
      .doc(standardStore)
      .collection('daily_records')
      .doc(docDateId)
      .set({
        records: allRows,         
        total_rows: allRows.length,
        store: standardStore,     
        report_type: reportType,
        importedAt: new Date()
      }, { merge: true });        

    console.log(`✅ [SUCCESS] บันทึกข้อมูลร้าน ${standardStore} ของวันที่ ${docDateId} ลงใน ${collectionName}/.../daily_records เรียบร้อยแล้ว! (จำนวน ${allRows.length} แถว)`);
    res.status(200).send('Processed!');

  } catch (error) {
    console.error('❌ เกิดข้อผิดพลาดในการประมวลผลไฟล์:', error);
    res.status(500).send(`Error: ${error.message}`);
  }
});

app.listen(8080, () => console.log('Server ready'));