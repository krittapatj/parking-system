const db = require('./db');
console.log('Running Alter Table...');
db.query('ALTER TABLE parking_slots ADD COLUMN sensor_id VARCHAR(100) DEFAULT NULL', (err, results) => {
    if (err) {
        console.error('Error altering table:', err.message);
    } else {
        console.log('Success! Column sensor_id added.');
    }
    process.exit(0);
});
