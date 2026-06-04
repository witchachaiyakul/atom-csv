const express = require('express');
const { Storage } = require('@google-cloud/storage');
const { Firestore } = require('@google-cloud/firestore');
const csv = require('csv-parse'); // อย่าลืมติดตั้งไลบรารีนี้

const app = express();
app.use(express.json()); // สำคัญ: ให้ Cloud Run อ่าน JSON ได้

app.post('/', async (req, res) => {
  const { bucket, name } = req.body;
  console.log(`กำลังประมวลผลไฟล์: ${name} จาก Bucket: ${bucket}`);
  
  // 1. ดึงไฟล์จาก Storage
  const storage = new Storage();
  const file = storage.bucket(bucket).file(name);
  
  // 2. ใช้ csv-parse สับไฟล์และจัดการข้อมูลตามรายการที่พี่ต้องการ
  file.createReadStream()
    .pipe(csv.parse({ columns: true }))
    .on('data', async (row) => {
       // ใส่ Logic การแยกรายการของพี่ที่นี่ (เช่น ยิงลง Firestore)
    })
    .on('end', () => res.status(200).send('Processed!'));
});

app.listen(8080, () => console.log('Server ready'));