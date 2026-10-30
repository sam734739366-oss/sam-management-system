const { app } = require('electron');
const path = require('path');
const db = require(path.resolve(__dirname, '..', 'src', 'main', 'db.js'));

app.setName('SAM Management System');
app.whenReady().then(() => {
  db.init(process.env.SAM_DATA_DIR || app.getPath('userData'));
  const s = db.summary();
  const users = db.listUsers().map((u) => ({ u: u.username, role: u.role, active: u.is_active }));
  const lines = [
    'userData: ' + app.getPath('userData'),
    'summary: ' + JSON.stringify({ items: s.items, warehouses: s.warehouses, parties: s.parties, documents: s.documents, moves: s.moves }),
    'users: ' + JSON.stringify(users),
    'routing: ' + JSON.stringify(db.prodRouting())
  ];
  require('fs').writeFileSync(path.resolve(__dirname, '..', '.tmp', 'realdb.txt'), lines.join('\n'));
  app.exit(0);
});
