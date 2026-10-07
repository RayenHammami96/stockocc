/* Tests d'intégration — lance un serveur éphémère sur une base jetable. */
process.env.DB_PATH = require('path').join(__dirname, '..', 'test.db');
require('fs').rmSync(process.env.DB_PATH, { force: true });
require('fs').rmSync(process.env.DB_PATH + '-wal', { force: true });

require('./seed');
const app = require('./index');

let pass = 0, fail = 0;
const ok = (l, c, extra) => { c ? (pass++, console.log('  ok   ' + l)) : (fail++, console.log('  FAIL ' + l + (extra ? ' -> ' + JSON.stringify(extra) : ''))); };

let base;
const api = async (method, path, body, token) => {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const login = async (phone, pin) => (await api('POST', '/api/login', { phone, pin })).body.token;

(async () => {
  const srv = app.listen(0);
  base = 'http://127.0.0.1:' + srv.address().port;

  console.log('\nAuthentification');
  ok('connexion vendeur', !!(await login('22100400', '4444')));
  ok('mauvais code refusé', (await api('POST', '/api/login', { phone: '22100400', pin: '0000' })).status === 401);
  ok('sans jeton = 401', (await api('GET', '/api/devices')).status === 401);

  const vendeur = await login('22100400', '4444');
  const stock = await login('22100300', '3333');
  const gerant = await login('22100200', '2222');
  const proprio = await login('22100100', '1111');
  const autre = await login('23500100', '1111');      // Phone House
  const admin = await login('98000000', '1234');      // éditeur

  console.log('\nCloisonnement des données');
  const mine = (await api('GET', '/api/devices', null, vendeur)).body;
  ok('PStore+ voit ses 5 appareils', mine.length === 5, mine.length);
  const theirs = (await api('GET', '/api/devices', null, autre)).body;
  ok('Phone House voit 0 appareil', theirs.length === 0, theirs.length);
  const cross = await api('GET', '/api/devices/' + mine[0].id, null, autre);
  ok('accès croisé bloqué (404)', cross.status === 404, cross.status);
  const w = await api('GET', '/api/warranty/353012110932847', null, autre);
  ok('IMEI d’une autre boutique invisible', w.status === 404, w.status);

  console.log('\nDroits par rôle');
  const dv = (await api('GET', '/api/devices', null, vendeur)).body[0];
  ok('vendeur : prix d’achat masqué', dv.purchase_price === undefined);
  ok('vendeur : pas de marge', dv.margin === undefined);
  const ds = (await api('GET', '/api/devices', null, stock)).body[0];
  ok('resp. stock : prix d’achat visible', typeof ds.purchase_price === 'number');
  ok('resp. stock : pas de marge', ds.margin === undefined);
  const dg = (await api('GET', '/api/devices', null, gerant)).body.find(x => x.sale_price);
  ok('gérant : marge calculée', typeof dg.margin === 'number', dg.margin);
  ok('vendeur ne peut pas inviter', (await api('POST', '/api/users', { name: 'X', phone: '1', role: 'vendeur' }, vendeur)).status === 403);
  ok('gérant ne nomme pas un gérant', (await api('POST', '/api/users', { name: 'X', phone: '29000001', role: 'gerant' }, gerant)).status === 403);
  const inv = await api('POST', '/api/users', { name: 'Hichem Saadi', phone: '29000002', role: 'vendeur' }, gerant);
  ok('gérant invite un vendeur', inv.status === 201 && /^\d{4}$/.test(inv.body.pin_provisoire));
  ok('numéro en double refusé', (await api('POST', '/api/users', { name: 'Y', phone: '29000002', role: 'vendeur' }, gerant)).status === 409);

  console.log('\nEntrée de stock');
  const bad = await api('POST', '/api/devices', { imei: '123', brand: 'Apple', model: 'iPhone 14' }, stock);
  ok('IMEI invalide refusé', bad.status === 400, bad.body);
  const noCin = await api('POST', '/api/devices',
    { imei: '350000000000001', brand: 'Apple', model: 'iPhone 14', source_type: 'reprise', seller: { name: 'A' } }, stock);
  ok('reprise sans n° de pièce refusée', noCin.status === 400, noCin.body);
  const created = await api('POST', '/api/devices', {
    imei: '350000000000001', brand: 'Apple', model: 'iPhone 14', capacity: '128 Go', color: 'Minuit',
    grade: 'A', battery: 93, source_type: 'reprise', purchase_price: 2100, sale_price: 2690, warranty_months: 6,
    seller: { name: 'Ines Ben Salah', phone: '20998877', id_doc_type: 'cin', id_doc_num: '04412876' },
  }, stock);
  ok('reprise avec n° de CIN acceptée', created.status === 201, created.body);
  ok('passe en statut à tester', created.body.status === 'test', created.body.status);
  ok('IMEI en double refusé', (await api('POST', '/api/devices',
    { imei: '350000000000001', brand: 'A', model: 'B', source_type: 'fournisseur' }, stock)).status === 409);
  const blockedDev = (await api('GET', '/api/devices?status=bloque', null, stock)).body[0];
  ok('appareil iCloud bloqué non libérable',
    (await api('POST', `/api/devices/${blockedDev.id}/release`, {}, stock)).status === 409);
  ok('mise en vente après test', (await api('POST', `/api/devices/${created.body.id}/release`, {}, stock)).status === 200);

  console.log('\nVente et garantie');
  const tooMuch = await api('POST', '/api/sales', { device_id: created.body.id, price: 2690, discount: 300 }, vendeur);
  ok('remise > 200 DT bloquée pour le vendeur', tooMuch.status === 403, tooMuch.body);
  const sale = await api('POST', '/api/sales', {
    device_id: created.body.id, price: 2690, discount: 100, warranty_months: 6,
    payment_method: 'd17', customer: { name: 'Karim Trabelsi', phone: '22419038' },
  }, vendeur);
  ok('vente enregistrée', sale.status === 201, sale.body);
  ok('garantie 6 mois posée', sale.body.warranty_months === 6);
  const war = (await api('GET', '/api/warranty/350000000000001', null, vendeur)).body;
  ok('recherche par IMEI : sous garantie', war.covered === true);
  ok('jours restants cohérents', war.days_left > 170 && war.days_left <= 184, war.days_left);
  ok('revente impossible', (await api('POST', '/api/sales', { device_id: created.body.id, price: 100 }, vendeur)).status === 409);
  const det = (await api('GET', '/api/devices/' + created.body.id, null, gerant)).body;
  ok('historique complet', det.events.map(e => e.type).join(',') === 'acquisition,mise_en_vente,vente', det.events.map(e => e.type));
  ok('marge nette correcte', det.device.margin === 2590 - 2100, det.device.margin);

  console.log('\nConsole éditeur');
  ok('un gérant n’accède pas à la console', (await api('GET', '/api/admin/tenants', null, gerant)).status === 403);
  const list = (await api('GET', '/api/admin/tenants', null, admin)).body;
  ok('3 boutiques listées', list.length === 3, list.length);
  ok('les impayés remontent en premier', list[0].status === 'attente_paiement', list[0].status);
  const sm = list.find(t => t.slug === 'smart-mobile');
  ok('montant mensuel calculé', sm.monthly_due === 49, sm.monthly_due);
  const pay = await api('POST', `/api/admin/tenants/${sm.id}/payments`, { method: 'virement', months: 12, reference: 'VIR-0912' }, admin);
  ok('encaissement validé', pay.status === 201, pay.body);
  ok('remise annuelle appliquée', pay.body.expected === 499.8, pay.body.expected);
  ok('boutique activée', pay.body.status === 'actif');
  const smAfter = (await api('GET', '/api/admin/tenants/' + sm.id, null, admin)).body;
  ok('échéance enregistrée', smAfter.tenant.paid_until === pay.body.paid_until);
  ok('paiement tracé', smAfter.payments.length === 1 && smAfter.payments[0].reference === 'VIR-0912');
  ok('console sans accès au stock', smAfter.devices === undefined);

  console.log('\nSuspension');
  const ph = list.find(t => t.slug === 'phone-house');
  await api('POST', `/api/admin/tenants/${ph.id}/suspend`, { motif: 'test' }, admin);
  const blocked = await api('GET', '/api/devices', null, autre);
  ok('boutique suspendue : accès coupé (402)', blocked.status === 402, blocked.status);
  ok('les autres boutiques continuent', (await api('GET', '/api/devices', null, vendeur)).status === 200);

  console.log('\nFacturation automatique');
  const billing = (await api('POST', '/api/admin/run-billing', {}, admin)).body;
  ok('essais expirés détectés', typeof billing.essais_expires === 'number', billing);

  console.log(`\n${pass} tests passés, ${fail} échec(s).\n`);
  srv.close();
  process.exit(fail ? 1 : 0);
})();
