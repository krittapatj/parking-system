const express = require('express');
const router = express.Router();
const db = require('../db');

// POST /api/parking/update - Update parking slot status
// Expects JSON: { "slot_number": "Slot 1", "spot_status": "ว่าง" } OR { "sensor_id": "SENSOR_01", "spot_status": "..." }
// spot_status ENUM('ว่าง', 'มีรถเล็ก', 'มีรถใหญ่', 'ไม่ใช่รถ', 'ยังไม่ติดตั้งแม่เหล็ก')
router.post('/update', (req, res) => {
    let { slot_number, sensor_id, spot_status } = req.body;

    if ((!slot_number && !sensor_id) || !spot_status) {
        return res.status(400).json({ error: 'Missing slot_number/sensor_id or spot_status' });
    }

    const validStatuses = ['ว่าง', 'มีรถเล็ก', 'มีรถใหญ่', 'ไม่ใช่รถ', 'ยังไม่ติดตั้งแม่เหล็ก', 'ถูกจอง'];
    if (!validStatuses.includes(spot_status)) {
        return res.status(400).json({ error: 'Invalid spot_status. Must be one of: ' + validStatuses.join(', ') });
    }

    const performUpdate = (targetSlot) => {
        // Check current status first to handle reservation logic
        db.query("SELECT spot_status FROM parking_slots WHERE slot_number = ?", [targetSlot], (err, results) => {
            if (err) return res.status(500).json({ error: 'Database checking error' });
            if (results.length === 0) return res.status(404).json({ error: 'Slot not found' });

            const currentStatus = results[0].spot_status;

            // Rule: If current status is 'ถูกจอง' (Reserved) AND sensor says 'ว่าง' (Empty),
            // IGNORE the update. The user hasn't arrived yet.
            if (currentStatus === 'ถูกจอง' && spot_status === 'ว่าง') {
                return res.json({ message: 'Slot is reserved, ignoring empty signal', slot: targetSlot });
            }

            // Otherwise, update normally (e.g. car arrives -> 'มีรถ...', or 'ว่าง' -> 'ว่าง')
            const updateQuery = 'UPDATE parking_slots SET spot_status = ?, last_updated = NOW() WHERE slot_number = ?';
            db.query(updateQuery, [spot_status, targetSlot], (err, result) => {
                if (err) return res.status(500).json({ error: 'Database update error' });

                console.log(`Updated ${targetSlot}: Status=${spot_status}`);
                res.json({ message: 'Slot updated successfully', slot: targetSlot, status: spot_status });
            });
        });
    };

    if (sensor_id) {
        // Look up slot_number by sensor_id
        db.query("SELECT slot_number FROM parking_slots WHERE sensor_id = ?", [sensor_id], (err, results) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            if (results.length === 0) return res.status(404).json({ error: 'Sensor ID not mapped to any slot' });

            performUpdate(results[0].slot_number);
        });
    } else {
        performUpdate(slot_number);
    }
});

// POST /api/parking/reserve - Reserve a spot in a zone
router.post('/reserve', (req, res) => {
    const { zone_id, user_id, booking_type, entry_date, exit_date, entry_time, exit_time } = req.body; 

    if (!zone_id || !user_id || !booking_type || !entry_date) {
        return res.status(400).json({ message: 'Missing required booking information' });
    }

    // Check if user already has an active booking that overlaps
    // Simplified: Check any active booking for this user
    db.query("SELECT id FROM bookings WHERE user_id = ? AND status IN ('reserved', 'parked')", [user_id], (errActive, resActive) => {
        if (errActive) return res.status(500).json({ message: 'Database error', error: errActive });
        if (resActive.length > 0) return res.status(400).json({ message: 'คุณมีการจองหรือกำลังจอดรถอยู่แล้ว' });

        // Find a free slot in the zone
        // In a real system, this would check overlapping times. For now, find a slot not used by any active booking
        const findSlotSql = `
            SELECT id, slot_number 
            FROM parking_slots 
            WHERE zone_id = ? 
            AND id NOT IN (
                SELECT slot_id FROM bookings WHERE status IN ('reserved', 'parked')
            )
            LIMIT 1`;

        db.query(findSlotSql, [zone_id], (err, results) => {
            if (err) return res.status(500).json({ message: 'Database error', error: err });

            if (results.length === 0) {
                return res.status(400).json({ message: 'ไม่พบที่จอดรถว่างในโซนและเวลาที่คุณเลือก (No available slots)' });
            }

            const slot = results[0];

            // Insert into bookings table
            const insertBookingSql = `
                INSERT INTO bookings (user_id, zone_id, slot_id, booking_type, entry_date, exit_date, entry_time, exit_time, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved')`;
            const bVals = [user_id, zone_id, slot.id, booking_type, entry_date, exit_date || null, entry_time || null, exit_time || null];
            
            db.query(insertBookingSql, bVals, (upErr, upRes) => {
                if (upErr) return res.status(500).json({ message: 'Booking error', error: upErr });

                // Update slot status to lock it visually in admin dashboard if needed, though 'bookings' table is the source of truth now.
                db.query("UPDATE parking_slots SET spot_status = 'ถูกจอง', last_updated = NOW() WHERE id = ?", [slot.id]);

                res.json({
                    message: 'จองที่จอดรถสำเร็จ (Reservation Successful)',
                    slot_number: slot.slot_number,
                    status: 'ถูกจอง',
                    booking_id: upRes.insertId
                });
            });
        });
    });
});

// POST /api/parking/cancel - Cancel a booking
router.post('/cancel', (req, res) => {
    const { booking_id, slot_id } = req.body;
    
    if (!booking_id || !slot_id) {
        return res.status(400).json({ message: 'Missing booking_id or slot_id' });
    }

    // Update booking status
    const updateBookingSql = `UPDATE bookings SET status = 'cancelled' WHERE id = ?`;
    db.query(updateBookingSql, [booking_id], (err, bRes) => {
        if (err) return res.status(500).json({ message: 'Database error', error: err });
        if (bRes.affectedRows === 0) return res.status(404).json({ message: 'Booking not found' });

        // Update slot status back to 'ว่าง'
        const updateSlotSql = `UPDATE parking_slots SET spot_status = 'ว่าง', last_updated = NOW() WHERE id = ?`;
        db.query(updateSlotSql, [slot_id], (err2, sRes) => {
            if (err2) return res.status(500).json({ message: 'Error updating slot status', error: err2 });
            
            res.json({ message: 'ยกเลิกการจองสำเร็จ (Booking Cancelled)' });
        });
    });
});

// GET /api/parking/my-booking/:user_id - Get current active booking for user
router.get('/my-booking/:user_id', (req, res) => {
    const { user_id } = req.params;
    const sql = `
        SELECT b.id as booking_id, b.status as booking_status, b.booking_type, b.entry_date, b.entry_time, b.exit_date, b.exit_time,
               b.actual_entry_time, b.actual_exit_time,
               ps.id as slot_id, ps.slot_number, ps.spot_status, 
               pz.name as zone_name, pl.name as location_name, pl.id as location_id 
        FROM bookings b
        JOIN parking_slots ps ON b.slot_id = ps.id
        JOIN parking_zones pz ON b.zone_id = pz.id
        JOIN parking_locations pl ON pz.location_id = pl.id
        WHERE b.user_id = ? AND b.status IN ('reserved', 'parked')
    `;
    db.query(sql, [user_id], (err, results) => {
        if (err) return res.status(500).json({ message: 'Database error', error: err });
        if (results.length === 0) return res.status(404).json({ message: 'No active booking' });
        res.json(results[0]);
    });
});

// GET /api/parking/history/:user_id - Get past bookings for a user
router.get('/history/:user_id', (req, res) => {
    const { user_id } = req.params;
    const sql = `
        SELECT b.id as booking_id, b.status as booking_status, b.booking_type, b.entry_date, b.entry_time, b.exit_date, b.exit_time, b.created_at,
               ps.id as slot_id, ps.slot_number, pz.name as zone_name, pl.name as location_name, pl.id as location_id
        FROM bookings b
        JOIN parking_slots ps ON b.slot_id = ps.id
        JOIN parking_zones pz ON b.zone_id = pz.id
        JOIN parking_locations pl ON pz.location_id = pl.id
        WHERE b.user_id = ?
        ORDER BY b.id DESC
    `;
    db.query(sql, [user_id], (err, results) => {
        if (err) return res.status(500).json({ message: 'Database error', error: err });
        res.json(results);
    });
});

// GET /api/parking/status - Get all slots status
router.get('/status', (req, res) => {
    const query = 'SELECT * FROM parking_slots';
    db.query(query, (err, results) => {
        if (err) {
            console.error('Error fetching parking status:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        res.json(results);
    });
});

// GET /api/parking/status/:zone_id - Get slots for a specific zone
router.get('/status/:zone_id', (req, res) => {
    const zoneId = req.params.zone_id;
    const query = 'SELECT * FROM parking_slots WHERE zone_id = ?';
    db.query(query, [zoneId], (err, results) => {
        if (err) {
            console.error('Error fetching zone status:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        res.json(results);
    });
});

// GET /api/parking/search - Search approved locations
router.get('/search', (req, res) => {
    const sql = `SELECT * FROM parking_locations WHERE status = 'approved'`;
    db.query(sql, (err, locations) => {
        if (err) return res.status(500).json({ message: 'Database error' });

        if (locations.length === 0) {
            return res.json([]);
        }

        // Get operating hours for these locations
        const locationIds = locations.map(l => l.id);
        const hoursSql = `SELECT * FROM operating_hours WHERE location_id IN (?)`;

        db.query(hoursSql, [locationIds], (err, hours) => {
            if (err) {
                console.error('Error fetching operating hours:', err);
                // Return locations without hours if error, or specific error? 
                // Let's return locations but logged error.
                return res.json(locations);
            }

            // Map hours to locations
            const locationsWithHours = locations.map(loc => {
                const locHours = hours.filter(h => h.location_id === loc.id);
                return { ...loc, operating_hours: locHours };
            });

            res.json(locationsWithHours);
        });
    });
});

// GET /api/parking/zones/:location_id - Get zones for a location with availability
router.get('/zones/:location_id', (req, res) => {
    const locId = req.params.location_id;
    const sql = `
        SELECT pz.id, pz.name, 
        (
            SELECT COUNT(*) FROM parking_slots ps WHERE ps.zone_id = pz.id
        ) - (
            SELECT COUNT(*) FROM bookings b WHERE b.zone_id = pz.id AND b.status IN ('reserved', 'parked')
        ) as available_slots 
        FROM parking_zones pz 
        WHERE pz.location_id = ?
    `;
    db.query(sql, [locId], (err, results) => {
        if (err) return res.status(500).json({ message: 'Database error', error: err });
        res.json(results);
    });
});

// POST /api/parking/record-entry - Record actual entry time
router.post('/record-entry', (req, res) => {
    const { booking_id, scanned_qr } = req.body;
    if (!booking_id) return res.status(400).json({ message: 'Missing booking_id' });
    
    // Check if the scanned QR matches the location's QR
    const checkQrSql = `
        SELECT pl.qr_code_text 
        FROM bookings b
        JOIN parking_zones pz ON b.zone_id = pz.id
        JOIN parking_locations pl ON pz.location_id = pl.id
        WHERE b.id = ?
    `;
    db.query(checkQrSql, [booking_id], (err, results) => {
        if (err || results.length === 0) return res.status(500).json({ message: 'Database error or booking not found' });
        
        const locationQr = results[0].qr_code_text;
        
        // If location has a QR code set, it MUST match the scanned QR
        if (locationQr && locationQr.trim() !== '' && locationQr !== scanned_qr) {
            return res.status(400).json({ message: 'รหัส QR Code ไม่ตรงกับสถานที่ที่จองไว้!' });
        }

        const now = new Date();
        const updateSql = `UPDATE bookings SET status = 'parked', actual_entry_time = ? WHERE id = ?`;
        db.query(updateSql, [now, booking_id], (err, result) => {
            if (err) return res.status(500).json({ message: 'Database error', error: err });
            if (result.affectedRows === 0) return res.status(404).json({ message: 'Booking not found' });
            
            // 🔥 สั่งเปิดไม้กั้น
            if (req.app.locals.port) {
                req.app.locals.lastStatus = "working";
                req.app.locals.port.write("open\n", (err) => {
                    if(err) console.error("Servo Write Error:", err.message);
                });
            }
            
            res.json({ message: 'Entry recorded', entry_time: now });
        });
    });
});

// POST /api/parking/calculate-fee - Calculate parking fee
router.post('/calculate-fee', (req, res) => {
    const { booking_id, hourly_rate, scanned_qr } = req.body;
    if (!booking_id || !hourly_rate) return res.status(400).json({ message: 'Missing booking_id or hourly_rate' });
    
    const checkQrSql = `
        SELECT pl.qr_code_text, b.actual_entry_time 
        FROM bookings b
        JOIN parking_zones pz ON b.zone_id = pz.id
        JOIN parking_locations pl ON pz.location_id = pl.id
        WHERE b.id = ?
    `;
    db.query(checkQrSql, [booking_id], (err, results) => {
        if (err || results.length === 0) return res.status(500).json({ message: 'Booking not found' });
        
        const locationQr = results[0].qr_code_text;
        if (locationQr && locationQr.trim() !== '' && locationQr !== scanned_qr) {
            return res.status(400).json({ message: 'รหัส QR Code ไม่ตรงกับสถานที่ทางออก!' });
        }
        
        const actual_entry_time = results[0].actual_entry_time;
        const actual_exit_time = new Date();
        // Calculate duration in minutes, discarding seconds (use floor to cut off seconds)
        const durationMinutes = Math.floor((actual_exit_time - actual_entry_time) / (1000 * 60));
        
        // Calculate fee based on complex rules
        let feePercentage = 0;
        let roundedMinutes = 0;
        
        if (durationMinutes <= 10) {
            feePercentage = 0;  // Free
        } else if (durationMinutes <= 14) {
            feePercentage = 0.25;  // 1/4 hour
            roundedMinutes = 15;
        } else if (durationMinutes <= 19) {
            feePercentage = 0.333;  // 2/6 hour
            roundedMinutes = 20;
        } else if (durationMinutes <= 40) {
            feePercentage = 0.5;  // 1/2 hour
            roundedMinutes = 30;
        } else if (durationMinutes < 60) {
            feePercentage = 1;  // 1 hour
            roundedMinutes = 60;
        } else {
            const hours = Math.floor(durationMinutes / 60);
            const minutes = durationMinutes % 60;
            
            if (minutes <= 5) {
                // Just hours, no additional
                feePercentage = hours;
            } else if (minutes <= 10) {
                feePercentage = hours + (1/6);
            } else if (minutes <= 20) {
                feePercentage = hours + (2/6);
            } else if (minutes <= 30) {
                feePercentage = hours + (3/6);
            } else if (minutes <= 40) {
                feePercentage = hours + (4/6);
            } else {
                feePercentage = hours + 1;  // Next full hour
            }
            roundedMinutes = durationMinutes;
        }
        
        const totalFee = Math.round(hourly_rate * feePercentage * 100) / 100;
        
        // Update booking with exit time and fee
        const updateSql = `UPDATE bookings SET actual_exit_time = ?, parking_fee = ?, status = 'completed' WHERE id = ?`;
        db.query(updateSql, [actual_exit_time, totalFee, booking_id], (err2) => {
            if (err2) return res.status(500).json({ message: 'Database error', error: err2 });
            res.json({
                booking_id,
                durationMinutes,
                roundedMinutes,
                hourly_rate,
                feePercentage: feePercentage.toFixed(3),
                totalFee,
                entry_time: actual_entry_time,
                exit_time: actual_exit_time
            });
        });
    });
});

// POST /api/parking/process-payment - Process E-Wallet payment
router.post('/process-payment', (req, res) => {
    const { booking_id, user_id, amount, payment_method } = req.body;
    if (!booking_id || !user_id || amount === undefined) {
        return res.status(400).json({ message: 'Missing required payment info' });
    }
    
    // Simulate E-Wallet deduction
    const insertPaymentSql = `
        INSERT INTO payments (booking_id, user_id, amount, payment_method, status, created_at)
        VALUES (?, ?, ?, ?, 'completed', NOW())
    `;
    db.query(insertPaymentSql, [booking_id, user_id, amount, payment_method || 'E-Wallet'], (err, result) => {
        if (err) return res.status(500).json({ message: 'Database error', error: err });
        
        // 🔥 สั่งเปิดไม้กั้น
        if (req.app.locals.port) {
            req.app.locals.lastStatus = "working";
            req.app.locals.port.write("open\n", (err) => {
                if (err) console.error("Servo Write Error:", err.message);
            });
        }
        
        res.json({
            message: 'Payment successful',
            payment_id: result.insertId,
            booking_id,
            amount,
            timestamp: new Date()
        });
    });
});

module.exports = router;
