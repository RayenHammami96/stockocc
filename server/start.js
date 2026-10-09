/**
 * Point d'entrée de production.
 * Si la base n'existe pas encore (premier démarrage), on crée le compte éditeur.
 * Le seed complet (avec boutiques de démo) reste npm run seed, à ne pas appeler en prod.
 */
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data.db');
const isFirstRun = !fs.existsSync(DB_PATH);

// db.js crée le schéma au require() via db.exec(schema.sql)
const { db, hashPin } = require('./db');

if (isFirstRun) {
  console.log('Premier démarrage — création du compte éditeur.');
  const editorPhone = process.env.EDITOR_PHONE || '98000000';
  const editorPin   = process.env.EDITOR_PIN   || '1234';
  db.prepare(
    `INSERT OR IGNORE INTO users (tenant_id,name,phone,pin_hash,role,status)
     VALUES (NULL,'Éditeur',?,?,'editeur','actif')`
  ).run(editorPhone, hashPin(editorPin));
  console.log(`Éditeur créé : numéro=${editorPhone}  code=${editorPin}`);
  if (editorPin === '1234') {
    console.warn("EDITOR_PIN par defaut - changez-la en variable env");
  }
}

const app = require('./index');
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Stock Occasion — port ' + PORT));
