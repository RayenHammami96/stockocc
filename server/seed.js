const { db, hashPin, today, addMonths } = require('./db');

db.exec(`DELETE FROM audit_log; DELETE FROM payments; DELETE FROM sales;
         DELETE FROM device_events; DELETE FROM devices; DELETE FROM customers;
         DELETE FROM suppliers; DELETE FROM users; DELETE FROM pdv; DELETE FROM tenants;`);

// Compte éditeur (tenant_id NULL) : accès à la console, à rien d'autre.
db.prepare(`INSERT INTO users (tenant_id,name,phone,pin_hash,role,status)
            VALUES (NULL,'Rayen — éditeur','98000000',?,'editeur','actif')`).run(hashPin('1234'));

function tenant(t) {
  const id = db.prepare(`INSERT INTO tenants (name,slug,city,phone,color,logo_url,status,plan,trial_ends_at,paid_until)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(t.name, t.slug, t.city, t.phone, t.color, t.logo || null,
    t.status, t.plan, t.trial || null, t.paid || null).lastInsertRowid;
  const pdvIds = t.pdvs.map(n => db.prepare('INSERT INTO pdv (tenant_id,name) VALUES (?,?)').run(id, n).lastInsertRowid);
  t.users.forEach(u => db.prepare(
    `INSERT INTO users (tenant_id,name,phone,pin_hash,role,pdv_id,status) VALUES (?,?,?,?,?,?,'actif')`
  ).run(id, u[0], u[1], hashPin(u[2]), u[3], pdvIds[u[4] || 0]));
  return { id, pdvIds };
}

const ps = tenant({
  name: 'PStore +', slug: 'pstore-plus', city: 'Tunis', phone: '71860400', color: '#0F5E5C',
  logo: 'https://pstore.tn/wp-content/uploads/2025/12/pstore-logo-removebg-preview.png',
  status: 'actif', plan: 'standard', paid: addMonths(today(), 1),
  pdvs: ["L'Aouina", 'Ennasser'],
  users: [
    ['Rayen Mansour', '22100100', '1111', 'proprio', 0],
    ['Sami Ferchichi', '22100200', '2222', 'gerant', 0],
    ['Nizar Ouali', '22100300', '3333', 'stock', 0],
    ['Amine Belhaj', '22100400', '4444', 'vendeur', 0],
    ['Yosr Khelifi', '22100500', '5555', 'vendeur', 1],
  ],
});

tenant({
  name: 'Phone House', slug: 'phone-house', city: 'Sousse', phone: '73221908', color: '#2B4B8C',
  status: 'essai', plan: 'essai', trial: addMonths(today(), 0),
  pdvs: ['Sousse centre'],
  users: [['Hatem Jlassi', '23500100', '1111', 'proprio', 0]],
});

tenant({
  name: 'Smart Mobile', slug: 'smart-mobile', city: 'Sfax', phone: '74410332', color: '#8C3A2B',
  status: 'attente_paiement', plan: 'essai',
  pdvs: ['Sfax Lafrane'],
  users: [['Walid Amri', '24700100', '1111', 'proprio', 0]],
});

// Un peu de stock chez PStore+
const sup = db.prepare('INSERT INTO suppliers (tenant_id,name) VALUES (?,?)').run(ps.id, 'Import Plus').lastInsertRowid;
const cli = db.prepare(`INSERT INTO customers (tenant_id,name,phone,id_doc_type,id_doc_num)
  VALUES (?,?,?,'cin','09876543')`).run(ps.id, 'Mehdi Chaouch', '20334455').lastInsertRowid;

const devs = [
  ['353012110932847', 'Apple', 'iPhone 13 Pro', '128 Go', 'Bleu alpin', 'A', 89, 'stock', 'reprise', cli, null, 1750, 0, 2290, 6],
  ['351209874556310', 'Apple', 'iPhone 12', '64 Go', 'Noir', 'B', 81, 'stock', 'fournisseur', null, sup, 1180, 140, 1590, 3],
  ['356789012345671', 'Samsung', 'Galaxy S22', '128 Go', 'Vert', 'B', 86, 'stock', 'fournisseur', null, sup, 1020, 0, 1450, 3],
  ['352998776655441', 'Apple', 'iPhone 11', '128 Go', 'Blanc', 'C', 74, 'bloque', 'reprise', cli, null, 890, 0, null, 3],
  ['869911003344557', 'Xiaomi', 'Redmi Note 13 Pro', '256 Go', 'Noir', 'A', 95, 'test', 'reprise', cli, null, 640, 0, 890, 3],
];
devs.forEach(d => {
  const id = db.prepare(`INSERT INTO devices (tenant_id,imei,brand,model,capacity,color,grade,battery,
    status,pdv_id,source_type,seller_id,supplier_id,purchase_price,repair_cost,sale_price,warranty_months)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    ps.id, d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7], ps.pdvIds[0], d[8], d[9], d[10], d[11], d[12], d[13], d[14]
  ).lastInsertRowid;
  db.prepare(`INSERT INTO device_events (tenant_id,device_id,type,user_id,pdv_id)
              VALUES (?,?,'acquisition',?,?)`).run(ps.id, id, 1, ps.pdvIds[0]);
});

console.log(`Base prête : ${db.prepare('SELECT COUNT(*) n FROM tenants').get().n} boutiques, ` +
            `${db.prepare('SELECT COUNT(*) n FROM users').get().n} utilisateurs, ` +
            `${db.prepare('SELECT COUNT(*) n FROM devices').get().n} appareils.`);
console.log(`
  Éditeur (console)      98000000 / 1234
  PStore+ propriétaire   22100100 / 1111
  PStore+ gérant         22100200 / 2222
  PStore+ resp. stock    22100300 / 3333
  PStore+ vendeur        22100400 / 4444
  Phone House (essai)    23500100 / 1111`);
