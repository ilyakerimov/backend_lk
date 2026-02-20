const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const db = new sqlite3.Database('database.sqlite');
const sql = fs.readFileSync('database.sql', 'utf8');
db.exec(sql, (err) => {
    if (err) console.error(err);
    else console.log('База данных инициализирована');
    db.close();
});