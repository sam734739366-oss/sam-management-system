const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const OUT = path.resolve(__dirname, '..', '.tmp', 'dbtest.txt');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, '');
const log = (s) => fs.appendFileSync(OUT, s + '\n');

log('electron=' + process.versions.electron + ' node=' + process.versions.node + ' abi=' + process.versions.modules);

app.whenReady().then(() => {
  log('ready');
  let Database = null;
  try {
    Database = require('better-sqlite3');
    log('require ok, type=' + typeof Database);
  } catch (e) {
    log('REQUIRE FAILED: ' + e.message);
    app.exit(2);
    return;
  }
  try {
    const db = new Database(':memory:');
    db.exec("CREATE TABLE t(a INTEGER, b TEXT); INSERT INTO t VALUES (1,'x'),(2,'y');");
    const rows = db.prepare('SELECT * FROM t ORDER BY a').all();
    db.close();
    log('OK ' + JSON.stringify(rows));
    app.exit(0);
  } catch (e) {
    log('RUNTIME FAILED: ' + e.message);
    app.exit(1);
  }
});
