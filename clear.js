// run once: clear-master-session.js
require('dotenv').config({ path: '.env' });
const { clearSession } = require('./shared/session-sync');
const path = require('path');
const SESSION_DIR = path.join(__dirname, 'master/master_session');
clearSession('master', SESSION_DIR).then(() => {
  console.log('Done');
  process.exit(0);
});