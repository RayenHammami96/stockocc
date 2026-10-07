# Déploiement sur Render.com — Stock Occasion

## 1. Préparer le dépôt GitHub

```bash
# Dans le dossier du projet
git init
git add .
git commit -m "Initial commit — Stock Occasion v0.1"

# Créer un repo sur github.com (bouton + New repository)
# Nom suggéré : stockocc
git remote add origin https://github.com/TON_COMPTE/stockocc.git
git push -u origin main
```

---

## 2. Créer le Web Service sur Render

1. Va sur **render.com** → **New +** → **Web Service**
2. Connecte ton compte GitHub si ce n'est pas déjà fait
3. Sélectionne le repo **stockocc**
4. Configure :

| Champ | Valeur |
|---|---|
| **Name** | stockocc |
| **Region** | Frankfurt EU (le plus proche) |
| **Branch** | main |
| **Runtime** | Node |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Plan** | Free |

5. Clique **Advanced** → **Add Environment Variable** :

| Variable | Valeur |
|---|---|
| `PORT` | `10000` |
| `NODE_ENV` | `production` |
| `SECRET` | *(clique "Generate"* — Render génère automatiquement) |
| `DB_PATH` | `/opt/render/project/src/data.db` |
| `EDITOR_PHONE` | `98000000` *(ou ton vrai numéro)* |
| `EDITOR_PIN` | *(un vrai code à 4 chiffres, pas 1234)* |

6. Clique **Create Web Service**

---

## 3. Premier démarrage

Render va builder le projet (~2 min) puis démarrer.

Au premier démarrage, `start.js` détecte que `data.db` n'existe pas et crée :
- le schéma complet (via `schema.sql`)
- le compte éditeur avec le numéro et code choisis

Tu verras dans les logs :
```
Premier démarrage — création du compte éditeur.
Éditeur créé : numéro=98000000  code=****
Stock Occasion — http://localhost:10000
```

---

## 4. Accéder à l'application

L'URL est de la forme : **`https://stockocc.onrender.com`**

> ⚠️ Sur le plan gratuit, le service se "endort" après 15 min d'inactivité.
> Le premier accès après inactivité prend ~30 secondes (cold start).
> Pour éviter ça en prod : passer sur le plan **Starter ($7/mois)**.

---

## 5. Ajouter une boutique de démonstration (optionnel)

Pour peupler la base avec les boutiques de démo (PStore+, Phone House) :

Dans les **Shell** Render (onglet Shell dans le dashboard) :
```bash
node server/seed.js
```

⚠️ **Attention** : `seed.js` efface TOUTES les données. Ne faire qu'en phase de test.

---

## 6. Sauvegardes (important)

Le fichier SQLite est dans `/opt/render/project/src/data.db`.

Sur le plan gratuit, **le disque est réinitialisé à chaque redéploiement**.

**Solution pour ne pas perdre les données :**

**Option A (recommandée pour le test)** : Ne redéployer qu'en urgence.
Télécharger la base avant chaque déploiement :
```bash
# Depuis le Shell Render
cat /opt/render/project/src/data.db | base64
# Copier-coller → reconstituer localement
```

**Option B (production)** : Ajouter un **Render PostgreSQL** (plan gratuit disponible) et migrer `db.js` vers `pg`. Schéma PostgreSQL disponible dans `server/schema.pg.sql`.

**Option C (plus simple)** : Passer sur le plan **Starter** Render qui inclut un **Persistent Disk** — le fichier SQLite survit aux redéploiements.

---

## 7. Mise à jour du code

```bash
# Modifier le code localement
git add .
git commit -m "Fix: ..."
git push
```
Render détecte le push et redéploie automatiquement (~2 min).

---

## 8. Variables d'environnement à ne jamais publier

- `SECRET` — clé de signature des jetons JWT
- `EDITOR_PIN` — code d'accès à la console d'administration

Ces valeurs ne doivent être que dans le dashboard Render, jamais dans le code ni dans `.env` commité sur GitHub.
