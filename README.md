# ProBet CS2 — assistant de paris en direct

ProBet regarde le match CS2 **en même temps que vous** (YouTube, Twitch ou tout stream ouvert sur votre écran). Il lit l'état de la partie en continu et calcule **en direct** les probabilités de chaque marché pour vous proposer les paris à placer.

```
Stream (onglet du navigateur) ──► capture d'écran toutes les N s ──► Claude (vision)
                                                                      │  score, côtés, joueurs en vie, bombe,
                                                                      │  chrono, économie, map, série…
                                                                      ▼
                     suivi des rounds (filtre d'erreurs) ──► moteur de probabilités ──► interface live épurée
```

## Ce qui est analysé

| Facteur | Source | Effet |
|---|---|---|
| Score, round, côtés CT/T | HUD du stream | Propagation exacte MR12 + prolongations MR3 |
| Joueurs en vie, bombe posée, chrono | Panneaux joueurs / HUD | Probabilité de gagner le round en cours |
| Type d'achat (eco / force / full) | Équipement visible | Ajustement de force sur le round |
| Biais CT/T de la map | Map lue à l'écran | Taux de base par côté (ex. Nuke côté CT, Anubis côté T) |
| Pistol et anti-eco | Historique des rounds | Les rounds 2-3 favorisent fortement le vainqueur du pistol |
| Force relative des équipes | Cotes d'avant-match + rounds joués | Mise à jour bayésienne après chaque round |
| État de la série (BO1/3/5) | HUD / réglages | Probabilité de gagner la série |

## Marchés calculés

- Vainqueur du round en cours (mis à jour à chaque kill)
- Vainqueur de la map
- Total de rounds (plus/moins), handicaps en rounds
- Prolongation oui/non
- Vainqueur de la série

Pour chacun, l'assistant donne la **probabilité du modèle**, la **cote juste** et la **cote minimale à prendre**. Si vous saisissez les cotes de votre bookmaker, il signale les paris **VALUE** (espérance positive) et propose une mise : un quart de Kelly, plafonné à 5 % de la bankroll et pondéré par la fiabilité.

## Installation

Il faut Node.js 20+ et une clé API Anthropic.

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

Ouvrez ensuite **http://localhost:3000** dans Chrome, Edge ou Firefox.

## Utilisation

1. Ouvrez le match sur YouTube ou Twitch dans un onglet, de préférence en grand dans le lecteur avec le HUD bien visible.
2. Dans ProBet, cliquez sur **Connecter le stream** et choisissez l'onglet (ou la fenêtre) du match.
3. *(Recommandé)* Dans **Réglages**, saisissez les **cotes d'avant-match** des deux équipes et le format (BO1/BO3/BO5). Cela calibre la force des équipes avant les premiers rounds.
4. Suivez le panneau **Paris à jouer**. Il se met à jour tout seul.
5. Pour détecter la value, ouvrez **Tous les marchés** et entrez les cotes de votre bookmaker.

Le bouton **Démo** (ou `http://localhost:3000/?demo=1`) lance un match simulé, sans stream ni clé API, pour essayer l'interface.

Si la lecture se trompe (c'est rare, mais possible sur un HUD inhabituel), **Réglages → Correction manuelle** permet de corriger le score, les côtés ou l'ordre des équipes. L'assistant repart de ces valeurs.

## Fiabilité intégrée

- Un score n'avance que **d'un round à la fois**. Tout autre saut (erreur de lecture, arrivée en cours de match, nouvelle map) doit être **confirmé par deux lectures identiques**.
- Les replays, le desk des analystes et les pubs sont détectés et ignorés.
- L'indicateur **Fiabilité** combine la confiance de la vision, l'incertitude sur la force des équipes et le nombre de rounds observés. Les mises conseillées baissent avec elle.

## Réglages (variables d'environnement)

| Variable | Défaut | Rôle |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Clé API Claude |
| `PROBET_MODEL` | `claude-opus-5-5` | Modèle de vision (`claude-sonnet-5-5` coûte moins cher) |
| `PROBET_EFFORT` | `low` | Effort de raisonnement par image (`low` = rapide) |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Serveur local |

L'intervalle de lecture (6 s par défaut) et la bankroll se règlent dans l'interface.

**Coût :** chaque lecture envoie deux images, soit environ 2 500 tokens en entrée. Avec Opus et une lecture toutes les 6 s, comptez environ **10 à 15 $ par heure de jeu**. Pour réduire la facture, augmentez l'intervalle (10 s) ou passez à `PROBET_MODEL=claude-sonnet-5-5` (environ deux fois moins cher).

Si le modèle refuse une lecture, une requête de repli est envoyée automatiquement côté serveur (`fallbacks: "default"`).

## Limites — à lire avant de parier

- **Retard du stream :** une diffusion YouTube/Twitch a souvent 10 à 60 s de retard sur le match réel, donc sur les cotes live des bookmakers. Vérifiez toujours le score affiché chez votre bookmaker avant de valider un pari.
- Le modèle est **statistique** : il estime des probabilités, il ne garantit rien. Une cote juste ne vaut que ce que vaut le modèle, et l'avantage n'existe que si la cote du bookmaker est nettement au-dessus.
- Ne jouez que ce que vous pouvez perdre. Réservé aux 18 ans et plus.

## Structure

```
server.js           serveur HTTP local (interface + /api/analyze)
src/vision.js       lecture des images du stream par Claude (sortie JSON structurée)
public/engine.js    moteur de probabilités (rounds, map, totaux, handicaps, série, value)
public/tracker.js   suivi de l'état du match à partir des lectures successives
public/demo.js      simulateur de match (mode démo)
public/app.js       interface, capture du stream, rendu
test/               tests (npm test)
```
