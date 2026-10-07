const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data.db');
const SECRET = process.env.SECRET || 'dev-secret-a-changer-en-prod';

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

/* ---------- PIN ---------- */
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return `${salt}:${h}`;
}
function checkPin(pin, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, h] = stored.split(':');
  const cand = crypto.scryptSync(String(pin), salt, 32);
  const ref = Buffer.from(h, 'hex');
  return cand.length === ref.length && crypto.timingSafeEqual(cand, ref);
}

/* ---------- Jetons (JWT maison, HS256) ---------- */
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = d => crypto.createHmac('sha256', SECRET).update(d).digest('base64url');

function makeToken(payload, days = 30) {
  const body = { ...payload, exp: Date.now() + days * 864e5 };
  const data = `${b64({ alg: 'HS256' })}.${b64(body)}`;
  return `${data}.${sign(data)}`;
}
function readToken(token) {
  if (!token || token.split('.').length !== 3) return null;
  const [h, p, s] = token.split('.');
  if (sign(`${h}.${p}`) !== s) return null;
  try {
    const body = JSON.parse(Buffer.from(p, 'base64url').toString());
    return body.exp > Date.now() ? body : null;
  } catch { return null; }
}

/* ---------- Cloisonnement ----------
   Toute requête métier passe par scope(). Si tenant_id manque,
   on jette : impossible d'écrire par mégarde une requête globale. */
function scope(tenantId) {
  if (!tenantId) throw new Error('scope(): tenant_id manquant');
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const exec = (kind, sql, args) => {
    if (!/tenant_id/.test(sql)) throw new Error('scope(): requête sans filtre tenant_id -> ' + sql.slice(0, 60));
    const st = db.prepare(sql);
    return args.length === 1 && isObj(args[0])
      ? st[kind]({ ...args[0], tenant: tenantId })
      : st[kind](tenantId, ...args);
  };
  return {
    tenantId,
    all: (sql, ...a) => exec('all', sql, a),
    get: (sql, ...a) => exec('get', sql, a),
    run: (sql, ...a) => exec('run', sql, a),
  };
}

function audit(tenantId, userId, action, entity, entityId, detail) {
  db.prepare(
    `INSERT INTO audit_log (tenant_id,user_id,action,entity,entity_id,detail)
     VALUES (?,?,?,?,?,?)`
  ).run(tenantId || null, userId || null, action, entity || null, entityId || null,
        detail ? JSON.stringify(detail) : null);
}

const today = () => new Date().toISOString().slice(0, 10);
function addMonths(iso, n) {
  const d = new Date(iso);
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 10);
}

module.exports = { db, hashPin, checkPin, makeToken, readToken, scope, audit, today, addMonths, DB_PATH };
