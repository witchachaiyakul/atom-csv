# ใช้ Node.js เวอร์ชันล่าสุด
FROM node:20

# กำหนดโฟลเดอร์ทำงาน
WORKDIR /usr/src/app

# คัดลอกไฟล์ package.json และติดตั้ง dependencies
COPY package*.json ./
RUN npm install

# คัดลอกโค้ดทั้งหมดเข้าไป
COPY . .

# สั่งให้แอปทำงาน (อ้างอิงจาก package.json ของพี่)
CMD [ "node", "index.js" ]