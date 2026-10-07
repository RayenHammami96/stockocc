-- =====================================================================
-- Stock Occasion — schéma multi-boutique
-- Règle d'or : toute table métier porte tenant_id. Aucune requête
-- applicative ne tourne sans filtre sur tenant_id (voir db.js / scope()).
-- Écrit en SQL portable : passage à PostgreSQL = INTEGER PRIMARY KEY ->
-- BIGSERIAL, datetime('now') -> now(), + Row Level Security.
-- =====================================================================

PRAGMA foreign_keys = ON;

-- ---------- Boutiques clientes (tenants) ----------
CREATE TABLE IF NOT EXISTS tenants (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL,
  slug          TEXT    NOT NULL UNIQUE,
  city          TEXT,
  phone         TEXT,
  color         TEXT    NOT NULL DEFAULT '#0F5E5C',
  logo_url      TEXT,
  status        TEXT    NOT NULL DEFAULT 'essai'
                CHECK (status IN ('essai','attente_paiement','actif','suspendu','ferme')),
  plan          TEXT    NOT NULL DEFAULT 'essai',
  trial_ends_at TEXT,
  paid_until    TEXT,
  device_limit  INTEGER NOT NULL DEFAULT 30,   -- plafond pendant l'essai
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------- Points de vente ----------
CREATE TABLE IF NOT EXISTS pdv (
  id         INTEGER PRIMARY KEY,
  tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, name)
);

-- ---------- Utilisateurs ----------
-- tenant_id NULL = compte éditeur (console d'administration).
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  tenant_id     INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  phone         TEXT    NOT NULL,
  pin_hash      TEXT    NOT NULL,
  role          TEXT    NOT NULL
                CHECK (role IN ('editeur','proprio','gerant','stock','vendeur')),
  pdv_id        INTEGER REFERENCES pdv(id) ON DELETE SET NULL,
  status        TEXT    NOT NULL DEFAULT 'actif'
                CHECK (status IN ('invite','actif','desactive')),
  last_seen_at  TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, phone)
);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);

-- ---------- Tiers ----------
CREATE TABLE IF NOT EXISTS suppliers (
  id        INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name      TEXT    NOT NULL,
  phone     TEXT,
  UNIQUE (tenant_id, name)
);

-- Particuliers : clients acheteurs et vendeurs de reprise.
-- On stocke le NUMÉRO de pièce d'identité, jamais d'image.
CREATE TABLE IF NOT EXISTS customers (
  id          INTEGER PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  phone       TEXT,
  id_doc_type TEXT CHECK (id_doc_type IN ('cin','passeport')),
  id_doc_num  TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, phone)
);
CREATE INDEX IF NOT EXISTS idx_customers_tenant ON customers(tenant_id);

-- ---------- Appareils ----------
CREATE TABLE IF NOT EXISTS devices (
  id              INTEGER PRIMARY KEY,
  tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  imei            TEXT    NOT NULL,
  imei2           TEXT,
  serial          TEXT,
  brand           TEXT    NOT NULL,
  model           TEXT    NOT NULL,
  capacity        TEXT,
  color           TEXT,
  is_new          INTEGER NOT NULL DEFAULT 0,
  grade           TEXT    CHECK (grade IN ('A','B','C') OR grade IS NULL),
  battery         INTEGER CHECK (battery BETWEEN 0 AND 100 OR battery IS NULL),
  status          TEXT    NOT NULL DEFAULT 'test'
                  CHECK (status IN ('test','bloque','stock','reserve','vendu','sav','sorti')),
  pdv_id          INTEGER REFERENCES pdv(id) ON DELETE SET NULL,
  -- provenance
  source_type     TEXT    NOT NULL CHECK (source_type IN ('fournisseur','reprise')),
  supplier_id     INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  seller_id       INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  acquired_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  -- argent (jamais exposé au rôle vendeur, voir serialize())
  purchase_price  REAL    NOT NULL DEFAULT 0,
  repair_cost     REAL    NOT NULL DEFAULT 0,
  sale_price      REAL,
  -- garantie
  warranty_months INTEGER NOT NULL DEFAULT 3 CHECK (warranty_months IN (3,6,12)),
  sold_at         TEXT,
  warranty_end    TEXT,
  notes           TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, imei)
);
CREATE INDEX IF NOT EXISTS idx_devices_tenant_status ON devices(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_devices_imei ON devices(tenant_id, imei);

-- ---------- Journal d'événements (rien ne s'efface) ----------
CREATE TABLE IF NOT EXISTS device_events (
  id         INTEGER PRIMARY KEY,
  tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id  INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  type       TEXT    NOT NULL
             CHECK (type IN ('acquisition','test','reparation','mise_en_vente',
                             'transfert','reservation','vente','sav','retour','sortie')),
  payload    TEXT,            -- JSON
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  pdv_id     INTEGER REFERENCES pdv(id) ON DELETE SET NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_device ON device_events(tenant_id, device_id);

-- ---------- Ventes ----------
CREATE TABLE IF NOT EXISTS sales (
  id             INTEGER PRIMARY KEY,
  tenant_id      INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id      INTEGER NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  customer_id    INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  pdv_id         INTEGER REFERENCES pdv(id) ON DELETE SET NULL,
  price          REAL    NOT NULL,
  discount       REAL    NOT NULL DEFAULT 0,
  payment_method TEXT    NOT NULL DEFAULT 'especes'
                 CHECK (payment_method IN ('especes','d17','carte','virement','facilite')),
  deposit        REAL    NOT NULL DEFAULT 0,
  -- reprise liée : l'appareil entré en échange lors de cette vente
  trade_in_id    INTEGER REFERENCES devices(id) ON DELETE SET NULL,
  warranty_months INTEGER NOT NULL DEFAULT 3,
  sold_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sales_tenant ON sales(tenant_id, sold_at);

-- ---------- Abonnement de la boutique (côté éditeur) ----------
CREATE TABLE IF NOT EXISTS payments (
  id            INTEGER PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  amount        REAL    NOT NULL,
  method        TEXT    NOT NULL CHECK (method IN ('virement','d17','especes','cheque')),
  reference     TEXT,
  months        INTEGER NOT NULL DEFAULT 1,
  covers_until  TEXT    NOT NULL,
  validated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments(tenant_id);

-- ---------- Piste d'audit ----------
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  tenant_id  INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT    NOT NULL,
  entity     TEXT,
  entity_id  INTEGER,
  detail     TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_log(tenant_id, created_at);
