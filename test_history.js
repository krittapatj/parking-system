const db = require('./db');

async function test() {
    const user_id = 1; // Assuming user ID 1 exists, or we can just run the query without WHERE to test syntax
    const sql = `
        SELECT b.id as booking_id, b.status as booking_status, b.booking_type, b.entry_date, b.entry_time, b.exit_date, b.exit_time, b.created_at,
               ps.slot_number, pz.name as zone_name, pl.name as location_name
        FROM bookings b
        LEFT JOIN parking_slots ps ON b.slot_id = ps.id
        LEFT JOIN parking_zones pz ON b.zone_id = pz.id
        LEFT JOIN parking_locations pl ON pz.location_id = pl.id
        ORDER BY b.id DESC
        LIMIT 5;
    `;
    try {
        db.query(sql, [], (err, results) => {
            if (err) {
                console.error("SQL ERROR:", err);
            } else {
                console.log("RESULTS:", results);
            }
            process.exit(0);
        });
    } catch(err) {
        console.error("CATCH ERROR:", err);
        process.exit(1);
    }
}

test();
