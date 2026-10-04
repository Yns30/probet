# ProBet CS2 — assistant de paris en direct (HLTV)

ProBet est une extension Chrome/Edge. Laissez ouverte sur votre PC la page HLTV du match en cours : ProBet lit en direct les données de cette page et affiche, dans un panneau latéral, les probabilités et les paris à jouer.

```
Page de match HLTV ouverte ──► données live reçues par la page (scorebot)
                                │  score, round, côtés, joueurs en vie, PV, argent,
                                │  armes, bombe, historique des rounds, kills…
                                ▼
                         moteur de probabilités ──► panneau ProBet (à côté de la page)
```

- **Gratuit, sans compte, sans API, sans proxy.** ProBet n'envoie aucune requête à HLTV : il écoute les données que la page ouverte reçoit déjà pour afficher son scoreboard live.
- **Plusieurs matchs à la fois :** si plusieurs pages de match sont ouvertes, un menu permet de choisir celui à suivre.

## Installation (2 minutes)

1. Téléchargez ce dépôt (bouton « Code » → « Download ZIP ») et décompressez-le.
2. Ouvrez `chrome://extensions` (ou `edge://extensions`).
3. Activez le **Mode développeur** (en haut à droite).
4. Cliquez sur **Charger l'extension non empaquetée** et choisissez le dossier **`extension`**.
5. Épinglez l'icône ProBet dans la barre d'outils (icône puzzle → épingle).

## Utilisation

1. Ouvrez la page du match HLTV, par exemple `https://www.hltv.org/matches/2398729/furia-vs-mouz-esl-pro-league-season-24`. Si elle était déjà ouverte avant l'installation, **rechargez-la**.
2. Cliquez sur l'icône ProBet : le panneau s'ouvre à côté de la page.
3. Laissez la page HLTV ouverte. Le panneau se met à jour à chaque événement du match.

Le bouton **Essayer avec un match simulé** montre le fonctionnement sans match en cours.

## Ce que ProBet analyse

| Donnée HLTV | Utilisation |
|---|---|
| Score, round, côtés CT/T, map | Calcul exact jusqu'à la fin de la map (MR12 + prolongations MR3), avec l'avantage CT/T propre à chaque map |
| Historique des rounds | Force relative des équipes, mise à jour après chaque round ; effet pistol / anti-eco |
| Joueurs en vie et **points de vie** | Probabilité du round en cours (un 3v2 à 20 PV ne vaut pas un 3v2 à 100 PV) |
| Bombe posée | Probabilité post-plant (retake / défense de la bombe) |
| Armes, armures, argent | Type d'achat (eco / force / full) du round, et achat probable au round suivant |
| Cotes des bookmakers affichées par HLTV | Force des équipes avant les premiers rounds (marge retirée) |
| Maps déjà jouées, format BO1/BO3/BO5 | Probabilité de gagner la série |
| Probabilité live affichée par HLTV | Comparaison avec ProBet ; les écarts importants sont signalés |

## Marchés calculés

Vainqueur du round en cours, vainqueur de la map, total de rounds (plus/moins), handicaps, prolongation oui/non, vainqueur de la série.

Pour chaque marché, ProBet donne la **probabilité**, la **cote juste** et la **cote minimale à exiger** chez votre bookmaker. Ouvrez **Tous les marchés** et entrez les cotes de votre bookmaker : les paris à espérance positive apparaissent en tête avec le badge **VALUE**, l'avantage en % et une mise conseillée (quart de Kelly, plafonnée à 5 % de la bankroll).

Dans **Réglages** : bankroll, avantage minimum exigé pour un pari VALUE, et cotes d'avant-match manuelles si vous préférez les vôtres à celles affichées par HLTV.

## En cas de problème

- **« En attente des données live »** : le match n'a peut-être pas commencé. Sinon, rechargez la page HLTV : l'extension doit être chargée avant le scoreboard.
- **Une donnée semble fausse ou rien ne s'affiche :** dans **Réglages**, cliquez sur **Copier le diagnostic**, puis collez-le dans une conversation. Il contient ce que ProBet a reçu de la page, de quoi l'adapter si HLTV change sa structure.

## Limites

- HLTV a lui aussi quelques secondes de retard sur le match réel, et les cotes live bougent vite. Vérifiez le score chez votre bookmaker avant de valider un pari.
- Le modèle est **statistique** : il estime des probabilités, il ne garantit rien. L'avantage n'existe que si la cote du bookmaker est nettement au-dessus de la cote juste.
- Ne jouez que ce que vous pouvez perdre. Réservé aux 18 ans et plus.

## Structure

```
extension/
  manifest.json   déclaration de l'extension (Chrome/Edge, Manifest V3)
  hook.js         écoute les messages live reçus par la page HLTV (sans requête supplémentaire)
  content.js      lit la page (équipes, format, maps, cotes) et transmet au panneau
  hltv.js         traduit les données HLTV en état de match (scores, côtés, économie, phases)
  engine.js       moteur de probabilités (round, map, totaux, handicaps, série, value)
  panel.*         panneau latéral (interface)
  demo.js         match simulé au format HLTV (mode démo, tests)
  background.js   ouvre le panneau au clic sur l'icône
test/             tests (npm test, Node 20+)
```
