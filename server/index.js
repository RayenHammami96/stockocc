const express = require('express');
const path = require('path');
const {
  db, hashPin, checkPin, makeToken, readToken, scope, audit, today, addMonths
} = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const PRICE_PER_PDV = 49;          // DT / mois / point de vente
const TRIAL_DAYS = 14;
const slugify = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

/* =================== authentification =================== */
function auth(req, res, next) {
  const t = readToken((req.headers.authorization || '').replace('Bearer ', ''));
  if (!t) return res.status(401).json({ error: 'non authentifié' });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(t.uid);
  if (!u || u.status !== 'actif') return res.status(401).json({ error: 'compte inactif' });
  req.user = u;
  if (u.tenant_id) {
    req.tenant = db.prepare('SELECT * FROM tenants WHERE id=?').get(u.tenant_id);
    if (!req.tenant) return res.status(401).json({ error: 'boutique introuvable' });
    if (['suspendu', 'ferme'].includes(req.tenant.status)) {
      return res.status(402).json({ error: 'boutique suspendue', status: req.tenant.status });
    }
    req.s = scope(u.tenant_id);
  }
  db.prepare("UPDATE users SET last_seen_at=datetime('now') WHERE id=?").run(u.id);
  next();
}
const RANK = { vendeur: 1, stock: 2, gerant: 3, proprio: 4, editeur: 9 };
const need = min => (req, res, next) =>
  RANK[req.user.role] >= RANK[min] ? next() : res.status(403).json({ error: 'droit insuffisant' });
const editeur = (req, res, next) =>
  req.user.role === 'editeur' ? next() : res.status(403).json({ error: 'réservé à l’éditeur' });

// Le vendeur ne voit jamais le coût d'achat ni la marge.
function serialize(device, role) {
  const d = { ...device };
  if (RANK[role] < RANK.stock) { delete d.purchase_price; delete d.repair_cost; }
  if (RANK[role] >= RANK.gerant && device.sale_price != null) {
    d.margin = +(device.sale_price - device.purchase_price - device.repair_cost).toFixed(3);
  }
  if (d.warranty_end) {
    d.warranty_days_left = Math.max(0,
      Math.ceil((new Date(d.warranty_end) - new Date(today())) / 864e5));
  }
  return d;
}

/* =================== inscription d'une boutique =================== */
// Libre : la boutique démarre en essai. L'éditeur n'intervient qu'au paiement.
app.post('/api/signup', (req, res) => {
  const { shop, city, phone, owner_name, owner_phone, pin, pdvs } = req.body || {};
  if (!shop || !owner_phone || !pin) return res.status(400).json({ error: 'champs manquants' });
  if (!/^\d{4}$/.test(String(pin))) return res.status(400).json({ error: 'le code doit faire 4 chiffres' });

  let slug = slugify(shop), n = 1;
  while (db.prepare('SELECT 1 FROM tenants WHERE slug=?').get(slug)) slug = `${slugify(shop)}-${++n}`;

  const out = db.transaction(() => {
    const t = db.prepare(
      `INSERT INTO tenants (name,slug,city,phone,status,plan,trial_ends_at)
       VALUES (?,?,?,?,'essai','essai',?)`
    ).run(shop, slug, city || null, phone || null, addMonths(today(), 0).replace(today(),
      new Date(Date.now() + TRIAL_DAYS * 864e5).toISOString().slice(0, 10)));
    const tid = t.lastInsertRowid;

    const list = (Array.isArray(pdvs) && pdvs.length ? pdvs : ['Boutique principale']);
    const first = list.map(name =>
      db.prepare('INSERT INTO pdv (tenant_id,name) VALUES (?,?)').run(tid, name).lastInsertRowid)[0];

    const uid = db.prepare(
      `INSERT INTO users (tenant_id,name,phone,pin_hash,role,pdv_id,status)
       VALUES (?,?,?,?,'proprio',?,'actif')`
    ).run(tid, owner_name || 'Propriétaire', owner_phone, hashPin(pin), first).lastInsertRowid;

    audit(tid, uid, 'signup', 'tenant', tid, { shop });
    return { tid, uid };
  })();

  res.status(201).json({
    token: makeToken({ uid: out.uid }),
    tenant: db.prepare('SELECT * FROM tenants WHERE id=?').get(out.tid),
  });
});

/* =================== connexion =================== */
app.post('/api/login', (req, res) => {
  const { phone, pin } = req.body || {};
  const users = db.prepare("SELECT * FROM users WHERE phone=? AND status='actif'").all(phone || '');
  const u = users.find(x => checkPin(pin, x.pin_hash));
  if (!u) return res.status(401).json({ error: 'numéro ou code incorrect' });
  audit(u.tenant_id, u.id, 'login');
  res.json({ token: makeToken({ uid: u.id }), role: u.role });
});

app.get('/api/me', auth, (req, res) => {
  res.json({
    user: { id: req.user.id, name: req.user.name, role: req.user.role, pdv_id: req.user.pdv_id },
    tenant: req.tenant || null,
    pdvs: req.tenant ? req.s.all('SELECT * FROM pdv WHERE tenant_id=? AND active=1') : [],
  });
});

/* =================== stock =================== */
app.get('/api/devices', auth, (req, res) => {
  const { status, q } = req.query;
  let sql = 'SELECT * FROM devices WHERE tenant_id=?';
  const args = [];
  if (status) { sql += ' AND status=?'; args.push(status); }
  if (q) { sql += ' AND (imei LIKE ? OR model LIKE ? OR brand LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY acquired_at DESC';
  res.json(req.s.all(sql, ...args).map(d => serialize(d, req.user.role)));
});

app.get('/api/devices/:id', auth, (req, res) => {
  const d = req.s.get('SELECT * FROM devices WHERE tenant_id=? AND id=?', req.params.id);
  if (!d) return res.status(404).json({ error: 'appareil introuvable' });
  res.json({
    device: serialize(d, req.user.role),
    events: req.s.all(
      `SELECT e.*, u.name AS user_name FROM device_events e
       LEFT JOIN users u ON u.id=e.user_id
       WHERE e.tenant_id=? AND e.device_id=? ORDER BY e.created_at`, d.id),
  });
});

// Entrée de stock. Reprise = on enregistre le NUMÉRO de pièce, jamais d'image.
app.post('/api/devices', auth, (req, res) => {
  const b = req.body || {};
  if (!b.imei || !/^\d{15}$/.test(String(b.imei))) return res.status(400).json({ error: 'IMEI invalide (15 chiffres)' });
  if (!b.brand || !b.model) return res.status(400).json({ error: 'marque et modèle requis' });
  if (req.s.get('SELECT 1 AS x FROM devices WHERE tenant_id=? AND imei=?', b.imei))
    return res.status(409).json({ error: 'IMEI déjà présent dans cette boutique' });

  if (req.tenant.status === 'essai') {
    const n = req.s.get('SELECT COUNT(*) AS n FROM devices WHERE tenant_id=?').n;
    if (n >= req.tenant.device_limit)
      return res.status(402).json({ error: `limite d’essai atteinte (${req.tenant.device_limit} appareils)` });
  }

  let sellerId = null, supplierId = null;
  if (b.source_type === 'reprise') {
    if (!b.seller || !b.seller.id_doc_num)
      return res.status(400).json({ error: 'numéro de CIN ou passeport obligatoire pour une reprise' });
    const ex = req.s.get('SELECT * FROM customers WHERE tenant_id=? AND phone=?', b.seller.phone || '');
    sellerId = ex ? ex.id : req.s.run(
      `INSERT INTO customers (tenant_id,name,phone,id_doc_type,id_doc_num) VALUES (?,?,?,?,?)`,
      b.seller.name || 'Particulier', b.seller.phone || null,
      b.seller.id_doc_type || 'cin', b.seller.id_doc_num).lastInsertRowid;
  } else {
    const name = (b.supplier && b.supplier.name) || 'Fournisseur';
    const ex = req.s.get('SELECT * FROM suppliers WHERE tenant_id=? AND name=?', name);
    supplierId = ex ? ex.id : req.s.run('INSERT INTO suppliers (tenant_id,name) VALUES (?,?)', name).lastInsertRowid;
  }

  const blocked = b.icloud_locked ? 'bloque' : (b.is_new ? 'stock' : 'test');
  const r = req.s.run(
    `INSERT INTO devices (tenant_id,imei,imei2,serial,brand,model,capacity,color,is_new,grade,
       battery,status,pdv_id,source_type,supplier_id,seller_id,purchase_price,repair_cost,
       sale_price,warranty_months,notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    b.imei, b.imei2 || null, b.serial || null, b.brand, b.model, b.capacity || null, b.color || null,
    b.is_new ? 1 : 0, b.grade || null, b.battery ?? null, blocked, b.pdv_id || req.user.pdv_id,
    b.source_type || 'fournisseur', supplierId, sellerId,
    b.purchase_price || 0, b.repair_cost || 0, b.sale_price ?? null,
    b.warranty_months || (b.is_new ? 12 : 3), b.notes || null);

  const id = r.lastInsertRowid;
  req.s.run(
    `INSERT INTO device_events (tenant_id,device_id,type,payload,user_id,pdv_id) VALUES (?,?,'acquisition',?,?,?)`,
    id, JSON.stringify({ source: b.source_type, price: b.purchase_price }),
    req.user.id, b.pdv_id || req.user.pdv_id);
  audit(req.tenant.id, req.user.id, 'device.create', 'device', id, { imei: b.imei });
  res.status(201).json(serialize(req.s.get('SELECT * FROM devices WHERE tenant_id=? AND id=?', id), req.user.role));
});

// Fin de test -> mise en vente
app.post('/api/devices/:id/release', auth, need('stock'), (req, res) => {
  const d = req.s.get('SELECT * FROM devices WHERE tenant_id=? AND id=?', req.params.id);
  if (!d) return res.status(404).json({ error: 'appareil introuvable' });
  if (d.status === 'bloque') return res.status(409).json({ error: 'appareil bloqué iCloud, non vendable' });
  req.s.run(`UPDATE devices SET status='stock', sale_price=COALESCE(@price, sale_price)
             WHERE tenant_id=@tenant AND id=@id`,
    { price: req.body.sale_price ?? null, id: d.id });
  req.s.run(`INSERT INTO device_events (tenant_id,device_id,type,user_id,pdv_id) VALUES (?,?,'mise_en_vente',?,?)`,
    d.id, req.user.id, d.pdv_id);
  res.json(serialize(req.s.get('SELECT * FROM devices WHERE tenant_id=? AND id=?', d.id), req.user.role));
});

/* =================== vente =================== */
app.post('/api/sales', auth, (req, res) => {
  const b = req.body || {};
  const d = req.s.get('SELECT * FROM devices WHERE tenant_id=? AND id=?', b.device_id);
  if (!d) return res.status(404).json({ error: 'appareil introuvable' });
  if (!['stock', 'reserve'].includes(d.status)) return res.status(409).json({ error: `appareil non vendable (${d.status})` });
  const months = [3, 6, 12].includes(b.warranty_months) ? b.warranty_months : d.warranty_months;
  const price = Number(b.price ?? d.sale_price ?? 0);
  const discount = Number(b.discount || 0);
  if (discount > 200 && RANK[req.user.role] < RANK.gerant)
    return res.status(403).json({ error: 'remise au-delà de 200 DT : validation du gérant requise' });

  const out = db.transaction(() => {
    let customerId = null;
    if (b.customer && b.customer.phone) {
      const ex = req.s.get('SELECT * FROM customers WHERE tenant_id=? AND phone=?', b.customer.phone);
      customerId = ex ? ex.id : req.s.run('INSERT INTO customers (tenant_id,name,phone) VALUES (?,?,?)',
        b.customer.name || 'Client', b.customer.phone).lastInsertRowid;
    }
    const end = addMonths(today(), months);
    req.s.run(`UPDATE devices SET status='vendu', sold_at=@sold, warranty_end=@end,
               warranty_months=@months, sale_price=@net
               WHERE tenant_id=@tenant AND id=@id`,
      { sold: today(), end, months, net: price - discount, id: d.id });
    const sid = req.s.run(
      `INSERT INTO sales (tenant_id,device_id,customer_id,user_id,pdv_id,price,discount,
         payment_method,deposit,trade_in_id,warranty_months)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      d.id, customerId, req.user.id, d.pdv_id, price, discount,
      b.payment_method || 'especes', b.deposit || 0, b.trade_in_id || null, months).lastInsertRowid;
    req.s.run(`INSERT INTO device_events (tenant_id,device_id,type,payload,user_id,pdv_id)
               VALUES (?,?,'vente',?,?,?)`, d.id,
      JSON.stringify({ price, discount, warranty_months: months }), req.user.id, d.pdv_id);
    audit(req.tenant.id, req.user.id, 'sale.create', 'sale', sid, { imei: d.imei });
    return { sid, end };
  })();

  res.status(201).json({ sale_id: out.sid, warranty_end: out.end, warranty_months: months });
});

/* =================== garantie au comptoir =================== */
app.get('/api/warranty/:imei', auth, (req, res) => {
  const d = req.s.get('SELECT * FROM devices WHERE tenant_id=? AND imei=?', req.params.imei);
  if (!d) return res.status(404).json({ error: 'IMEI inconnu dans cette boutique' });
  if (!d.sold_at) return res.json({ sold: false, status: d.status, model: `${d.brand} ${d.model}` });
  const left = Math.ceil((new Date(d.warranty_end) - new Date(today())) / 864e5);
  res.json({
    sold: true, model: `${d.brand} ${d.model}`, imei: d.imei,
    sold_at: d.sold_at, warranty_end: d.warranty_end, warranty_months: d.warranty_months,
    covered: left > 0, days_left: Math.max(0, left),
  });
});

/* =================== équipe =================== */
app.get('/api/users', auth, need('gerant'), (req, res) => {
  res.json(req.s.all(
    `SELECT id,name,phone,role,pdv_id,status,last_seen_at FROM users WHERE tenant_id=? ORDER BY role DESC, name`));
});

app.post('/api/users', auth, need('gerant'), (req, res) => {
  const b = req.body || {};
  if (!b.phone || !b.name) return res.status(400).json({ error: 'nom et numéro requis' });
  if (!['vendeur', 'stock', 'gerant'].includes(b.role)) return res.status(400).json({ error: 'rôle invalide' });
  if (b.role === 'gerant' && req.user.role !== 'proprio')
    return res.status(403).json({ error: 'seul le propriétaire nomme un gérant' });
  if (req.s.get('SELECT 1 AS x FROM users WHERE tenant_id=? AND phone=?', b.phone))
    return res.status(409).json({ error: 'ce numéro est déjà dans l’équipe' });
  const pin = String(Math.floor(1000 + Math.random() * 9000));   // envoyé par SMS en prod
  const id = req.s.run(
    `INSERT INTO users (tenant_id,name,phone,pin_hash,role,pdv_id,status) VALUES (?,?,?,?,?,?,'actif')`,
    b.name, b.phone, hashPin(pin), b.role, b.pdv_id || null).lastInsertRowid;
  audit(req.tenant.id, req.user.id, 'user.invite', 'user', id, { role: b.role });
  res.status(201).json({ id, pin_provisoire: pin });
});

app.post('/api/users/:id/disable', auth, need('gerant'), (req, res) => {
  const u = req.s.get('SELECT * FROM users WHERE tenant_id=? AND id=?', req.params.id);
  if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
  if (u.role === 'proprio') return res.status(403).json({ error: 'le propriétaire ne peut pas être désactivé' });
  req.s.run("UPDATE users SET status='desactive' WHERE tenant_id=? AND id=?", u.id);
  audit(req.tenant.id, req.user.id, 'user.disable', 'user', u.id);
  res.json({ ok: true });   // l'historique de ses ventes reste intact
});

/* =================== console éditeur =================== */
app.get('/api/admin/tenants', auth, editeur, (req, res) => {
  res.json(db.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM pdv     WHERE tenant_id=t.id) AS pdv_count,
      (SELECT COUNT(*) FROM users   WHERE tenant_id=t.id AND status='actif') AS user_count,
      (SELECT COUNT(*) FROM devices WHERE tenant_id=t.id) AS device_count,
      (SELECT COUNT(*) FROM pdv WHERE tenant_id=t.id) * ${PRICE_PER_PDV} AS monthly_due
    FROM tenants t ORDER BY
      CASE t.status WHEN 'attente_paiement' THEN 0 WHEN 'suspendu' THEN 1 WHEN 'essai' THEN 2 ELSE 3 END,
      t.created_at DESC`).all());
});

app.get('/api/admin/tenants/:id', auth, editeur, (req, res) => {
  const t = db.prepare('SELECT * FROM tenants WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'boutique introuvable' });
  res.json({
    tenant: t,
    pdvs: db.prepare('SELECT * FROM pdv WHERE tenant_id=?').all(t.id),
    users: db.prepare('SELECT id,name,phone,role,status FROM users WHERE tenant_id=?').all(t.id),
    payments: db.prepare('SELECT * FROM payments WHERE tenant_id=? ORDER BY created_at DESC').all(t.id),
    device_count: db.prepare('SELECT COUNT(*) AS n FROM devices WHERE tenant_id=?').get(t.id).n,
    // volontairement : aucun accès au contenu du stock depuis la console
  });
});

// Validation d'un compte après encaissement.
app.post('/api/admin/tenants/:id/payments', auth, editeur, (req, res) => {
  const t = db.prepare('SELECT * FROM tenants WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'boutique introuvable' });
  const months = [1, 3, 12].includes(Number(req.body.months)) ? Number(req.body.months) : 1;
  const pdvCount = db.prepare('SELECT COUNT(*) AS n FROM pdv WHERE tenant_id=?').get(t.id).n || 1;
  const expected = +(PRICE_PER_PDV * pdvCount * months * (months === 12 ? 0.85 : 1)).toFixed(3);
  const amount = req.body.amount != null ? Number(req.body.amount) : expected;
  if (!['virement', 'd17', 'especes', 'cheque'].includes(req.body.method))
    return res.status(400).json({ error: 'mode de règlement invalide' });

  // On prolonge depuis l'échéance en cours si elle court encore.
  const from = (t.paid_until && t.paid_until > today()) ? t.paid_until : today();
  const until = addMonths(from, months);

  db.transaction(() => {
    db.prepare(`INSERT INTO payments (tenant_id,amount,method,reference,months,covers_until,validated_by)
                VALUES (?,?,?,?,?,?,?)`)
      .run(t.id, amount, req.body.method, req.body.reference || null, months, until, req.user.id);
    db.prepare(`UPDATE tenants SET status='actif', plan=?, paid_until=? WHERE id=?`)
      .run(months === 12 ? 'annuel' : 'standard', until, t.id);
    audit(t.id, req.user.id, 'tenant.payment', 'tenant', t.id, { amount, months, until });
  })();

  res.status(201).json({ ok: true, status: 'actif', paid_until: until, amount, expected });
});

app.post('/api/admin/tenants/:id/suspend', auth, editeur, (req, res) => {
  const t = db.prepare('SELECT * FROM tenants WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'boutique introuvable' });
  db.prepare("UPDATE tenants SET status='suspendu' WHERE id=?").run(t.id);
  audit(t.id, req.user.id, 'tenant.suspend', 'tenant', t.id, { motif: req.body.motif || null });
  res.json({ ok: true, status: 'suspendu' });
});

// Tâche quotidienne : essais expirés -> en attente de paiement, abonnements échus -> suspendus.
app.post('/api/admin/run-billing', auth, editeur, (req, res) => {
  const a = db.prepare(`UPDATE tenants SET status='attente_paiement'
                        WHERE status='essai' AND trial_ends_at < ?`).run(today()).changes;
  const b = db.prepare(`UPDATE tenants SET status='suspendu'
                        WHERE status='actif' AND paid_until IS NOT NULL AND paid_until < ?`).run(today()).changes;
  res.json({ essais_expires: a, abonnements_echus: b });
});

/* =================== démarrage =================== */
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Stock Occasion — http://localhost:${PORT}`));
}
module.exports = app;
