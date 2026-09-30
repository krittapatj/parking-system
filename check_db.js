const db = require('./db');
const fs = require('fs');

db.query('DESCRIBE parking_slots', (err, results) => {
    if (err) {
        fs.writeFileSync('db_out.txt', 'Error: ' + JSON.stringify(err));
    } else {
        fs.writeFileSync('db_out.txt', 'Columns: ' + JSON.stringify(results.map(r => r.Field)));
    }
    process.exit(0);
});
