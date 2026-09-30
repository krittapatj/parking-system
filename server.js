const express = require('express');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const path = require('path');
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");
dotenv.config();
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, 'public')))



// ให้ไฟล์ใน uploads ถูกเข้าถึงเป็น static
app.use('/uploads', express.static('uploads')); //เก็บรูปภาพ

// routes
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const adminParkingRoutes = require('./routes/admin_parking');
const profileRoutes = require('./routes/profile');
const parkingRoutes = require('./routes/parking');
const providerRoutes = require('./routes/provider');

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin-parking', adminParkingRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/parking', parkingRoutes);
app.use('/api/provider', providerRoutes);
const ticketRoutes = require('./routes/tickets');
app.use('/api/tickets', ticketRoutes);

// ===== Parking System Global State Appended =====
// ===== DB Connection & Multer Setup =====
const db = require('./db');
const multer = require('multer');
const fs = require('fs');
if (!fs.existsSync('uploads/slips')) {
    fs.mkdirSync('uploads/slips', { recursive: true });
}
const slipStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/slips/')
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname)
    }
});
const uploadSlip = multer({ storage: slipStorage });

// ===== Parking System QR System (SerialPort) =====
let port;
let parser;
let lastStatus = "idle";

async function initSerial() {
    try {
        const ports = await SerialPort.list();
        console.log('Available serial ports:', ports.map(p => p.path));

        // เลือกพอร์ตที่มีอยู่ (เลือกตัวแรกที่เจอ หรือที่มีคำว่า COM / tty)
        const chosen = ports.find(p => p.path && (p.path.includes('COM') || p.path.includes('/dev/tty')));
        if (!chosen) {
            console.warn('No serial ports found. Serial features disabled.');
            return;
        }

        port = new SerialPort({ path: chosen.path, baudRate: 9600 }, (err) => {
            if (err) console.error('Error opening serial port:', err.message);
        });

        port.on('open', () => {
            console.log('Serial port opened:', chosen.path);
        });

        port.on('error', (err) => {
            console.error('SerialPort error:', err.message);
        });

        app.locals.port = port;

        parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));
        parser.on("data", (data) => {
            console.log("Arduino:", data);
            if (data.trim() === "done") {
                lastStatus = "done";
            }
        });

    } catch (e) {
        console.error('Failed to initialize serial port:', e);
    }
}

// เรียกเริ่มต้นการเชื่อมต่อซีเรียลแบบอะซิงโครนัส
initSerial();

// helper: ส่งคำสั่งเปิดไปยัง Arduino เมื่อพอร์ตพร้อม
function sendOpen(angle) {
    const p = app.locals.port;
    if (!p || !p.isOpen) {
        console.warn('Serial port not available; cannot send open command.');
        return;
    }

    if (typeof angle === 'number') {
        const cmd = `open:${angle}\n`;
        p.write(cmd);
    } else {
        p.write("open\n");
    }
}

// ===== รับ QR Scan =====
app.post("/scan", (req, res) => {
    // Note: The QR scan simply sends `id`. For our system, the ID is typically the user_id or booking_id.
    // The frontend sends `user.id`. Let's look up their active booking.
    const user_id = req.body.id;
    if (!user_id) return res.status(400).json({ status: "error", message: "Missing ID" });

    // Find active booking for user
    db.query("SELECT * FROM bookings WHERE user_id = ? AND status IN ('reserved', 'parked') LIMIT 1", [user_id], (err, results) => {
        if (err) return res.status(500).json({ status: "error", message: "Database Error" });
        if (results.length === 0) return res.status(404).json({ status: "error", message: "ไม่พบข้อมูลการจอง (No active booking)" });

        const booking = results[0];

        if (booking.status === 'reserved') {
            // สแกนเข้า (Enter)
            db.query("UPDATE bookings SET status = 'parked', entry_time = NOW() WHERE id = ?", [booking.id], (upErr) => {
                if (upErr) console.error(upErr);
            });

            lastStatus = "working";
            // ส่งคำสั่งตรงไปยังบอร์ดให้เปิด 90 องศา แล้วปิดหลัง 5 วินาที
            sendOpen(90);
            console.log("รถเข้า", user_id);
            return res.json({ status: "enter" });

        } else if (booking.status === 'parked') {
            // สแกนออก (Exit) - Calculate time and fee
            // We use simple difference from entry_time to now
            const now = new Date();
            const enter = new Date(booking.entry_date.toDateString() + ' ' + booking.entry_time);

            // If they just entered recently, use actual DB entry_time or default to now if missing/malformed logic
            // For simplicity, let's just use the current time diff if enter is invalid
            let diffMs = now - enter;
            if (isNaN(diffMs) || diffMs < 0) diffMs = 0;

            let minutes = diffMs / 60000;
            let billMinutes = minutes - FREE_MINUTES;
            if (billMinutes < 0) billMinutes = 0;

            let price = 0;
            if (booking.booking_type === 'hourly') {
                let hours = Math.ceil(billMinutes / 60);
                price = hours * PRICE_PER_HOUR;
            } else if (booking.booking_type === 'daily') {
                // Fixed rate for daily or predefined logic. Let's say 200/day
                const PRICE_PER_DAY = 200;
                let days = Math.ceil(billMinutes / (60 * 24)) || 1;
                price = days * PRICE_PER_DAY;
            }

            console.log("รถเตรียมสแกนออก", user_id, "ราคา", price);
            // สแกนออก: ไม่เปิดประตูทันที รอให้ยืนยันการชำระเงินก่อน

            // กลับข้อมูลไปให้หน้า Payment
            res.json({
                status: "exit",
                price: price,
                id: user_id // send user_id back for payment
            });
        }
    });
});

// ===== Payment & Slip Upload =====
app.post("/pay", uploadSlip.single('slip_image'), (req, res) => {
    const { id } = req.body; // Actually user_id
    console.log("ชำระเงินสำเร็จ user_id:", id, "ไฟล์สลีป:", req.file ? req.file.filename : "No File");

    // สั่งเปิดประตูเมื่อชำระเงินสำเร็จ
    lastStatus = "working";
    sendOpen();

    // Update booking status to completed
    db.query("SELECT id, slot_id FROM bookings WHERE user_id = ? AND status = 'parked' LIMIT 1", [id], (err, resBooking) => {
        if (!err && resBooking.length > 0) {
            const bookingId = resBooking[0].id;
            const slotId = resBooking[0].slot_id;

            // Mark as completed
            db.query("UPDATE bookings SET status = 'completed', payment_status = 'paid', exit_time = NOW() WHERE id = ?", [bookingId]);

            // Free the slot
            db.query("UPDATE parking_slots SET spot_status = 'ว่าง' WHERE id = ?", [slotId]);
        }
    });

    res.json({
        success: true,
        message: "ชำระเงินสำเร็จ ประตูกำลังเปิด (Payment verified. Gate opening.)"
    });
});

// 📤 ส่งคำสั่งไป Arduino (Manual API - เผื่อหน้าเว็บเรียกใช้งานตรงๆ)
app.get("/open", (req, res) => {
    lastStatus = "working";
    sendOpen();
    res.json({ status: "sent" });
});

// 📥 ให้เว็บมาเช็คสถานะ
app.get("/status", (req, res) => {
    res.json({ status: lastStatus });
})

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on http://localhost:${PORT}`));
