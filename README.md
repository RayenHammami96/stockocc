# Stock Occasion — backend multi-boutique

API de gestion de stock de téléphones d'occasion, en mode multi-boutique
(chaque commerçant a sa boutique, ses utilisateurs, ses données).

## Démarrer

```bash
npm install
npm run seed     # crée data.db et les comptes de démonstration
npm start        # http://localhost:3000
npm test         # 44 tests d'intégration
```

## Comptes de démonstration

| Qui | Numéro | Code |
|---|---|---|
| Éditeur (console d'administration) | 98000000 | 1234 |
| PStore+ — propriétaire | 22100100 | 1111 |
| PStore+ — gérant | 22100200 | 2222 |
| PStore+ — responsable stock | 22100300 | 3333 |
| PStore+ — vendeur | 22100400 | 4444 |
| Phone House — propriétaire (en essai) | 23500100 | 1111 |

## Essayer en ligne de commande

```bash
# Connexion
TOKEN=$(curl -s localhost:3000/api/login -H 'Content-Type: application/json' \
  -d '{"phone":"22100400","pin":"4444"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')

# Le stock de la boutique (le vendeur ne reçoit aucun prix d'achat)
curl -s localhost:3000/api/devices -H "Authorization: Bearer $TOKEN"

# Garantie au comptoir
curl -s localhost:3000/api/warranty/353012110932847 -H "Authorization: Bearer $TOKEN"
```

## Points d'entrée

**Public**
- `POST /api/signup` — crée une boutique, son propriétaire et ses points de vente. Démarre un essai de 14 jours plafonné à 30 appareils.
- `POST /api/login` — numéro + code à 4 chiffres, renvoie un jeton valable 30 jours.

**Boutique** (jeton requis)
- `GET /api/me` — utilisateur, boutique, points de vente
- `GET /api/devices` — filtres `?status=` `?q=`
- `GET /api/devices/:id` — fiche + historique complet
- `POST /api/devices` — entrée de stock (fournisseur ou reprise)
- `POST /api/devices/:id/release` — fin de test, mise en vente
- `POST /api/sales` — vente, pose la garantie
- `GET /api/warranty/:imei` — couverture et jours restants
- `GET`/`POST /api/users`, `POST /api/users/:id/disable` — équipe (gérant et plus)

**Console éditeur** (rôle `editeur`)
- `GET /api/admin/tenants` — boutiques, usage, montant dû ; les impayés en tête
- `GET /api/admin/tenants/:id` — détail, utilisateurs, historique des paiements
- `POST /api/admin/tenants/:id/payments` — **encaisser et activer** (1, 3 ou 12 mois)
- `POST /api/admin/tenants/:id/suspend`
- `POST /api/admin/run-billing` — à passer en tâche quotidienne

## Règles appliquées côté serveur

Ce ne sont pas des règles d'interface : le serveur les fait respecter même si quelqu'un appelle l'API directement.

- **Cloisonnement** : `scope()` refuse toute requête métier qui ne filtre pas sur `tenant_id`. Un appel croisé entre boutiques renvoie 404, jamais une donnée.
- **Rôles** : le vendeur ne reçoit jamais `purchase_price` ni `repair_cost` ; la marge n'est calculée qu'à partir du gérant. Une remise au-delà de 200 DT lui est refusée.
- **Identité** : une reprise à un particulier exige le numéro de CIN ou de passeport. Aucune image de pièce d'identité n'est stockée ni acceptée.
- **IMEI** : 15 chiffres, unique par boutique.
- **iCloud bloqué** : l'appareil ne peut pas être mis en vente.
- **Garantie** : 3, 6 ou 12 mois, posée à la vente, `warranty_end` calculé côté serveur.
- **Abonnement** : une boutique suspendue reçoit 402 sur tous les points d'entrée. Les autres continuent de tourner.
- **Traçabilité** : `device_events` et `audit_log` sont en ajout seul. Désactiver un vendeur conserve ses ventes.

## Avant la mise en production

1. **PostgreSQL.** Le schéma est portable : `INTEGER PRIMARY KEY` → `BIGSERIAL`, `datetime('now')` → `now()`, `TEXT` de dates → `date` / `timestamptz`. Ajouter Row Level Security sur `tenant_id` comme deuxième filet sous `scope()`.
2. **`SECRET`** en variable d'environnement. La valeur par défaut est une valeur de développement.
3. **Limitation de débit** sur `/api/login` : un code à 4 chiffres se force en 10 000 essais.
4. **SMS** : le code provisoire renvoyé par `POST /api/users` doit partir par SMS, pas dans la réponse HTTP.
5. **HTTPS obligatoire**, sinon le jeton circule en clair.
6. **Sauvegardes** et durée de conservation définie pour les numéros de pièce d'identité (déclaration INPDP).
