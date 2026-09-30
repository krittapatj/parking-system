const express = require("express");
const app = express();

app.use(express.json());
app.use(express.static("public")); // ใช้โชว์เว็บ

// ✅ เก็บข้อมูลช่องจอดทั้งหมด
let parkingData = {};

// ===============================
// 📡 รับข้อมูลจาก Arduino (POST)
// ===============================
app.post("/api/parking/update", (req, res) => {
  const { slot_number, sensor_id, spot_status } = req.body;

  if (!slot_number || !spot_status) {
    return res.status(400).json({ error: "Missing data" });
  }

  parkingData[slot_number] = {
    sensor_id,
    status: spot_status,
    time: new Date()
  };

  console.log("📡 Update:", parkingData[slot_number]);

  res.json({ status: "ok" });
});

// ===============================
// 📊 ส่งข้อมูลให้หน้าเว็บ
// ===============================
app.get("/api/parking", (req, res) => {
  res.json(parkingData);
});

// ===============================
app.listen(3000, () => {
  console.log("🚀 Server running on port 3000");
});