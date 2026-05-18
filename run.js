const db = require('./shared/db');
const all = db.getRecentMessages(500);
console.log('Total messages in SQLite:', all.length);
console.log('DB path:', process.env.DB_PATH || require('path').join(__dirname, 'data/mirror.db'));