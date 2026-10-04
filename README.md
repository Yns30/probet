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
- **Plusieurs matchs à la fois :** ouvrez une page HLTV par match (dans des onglets ou des fenêtres). Tous les matchs sont analysés et enregistrés dans le journal en parallèle ; le menu en haut du panneau choisit celui qui est affiché. Les onglets peuvent rester en arrière-plan, mais ne les fermez pas et ne mettez pas Chrome en veille.

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

**En direct (scorebot de la page) :**

| Donnée HLTV | Utilisation |
|---|---|
| Score, round, côtés CT/T, map | Calcul exact jusqu'à la fin de la map (MR12 + prolongations MR3), avec l'avantage CT/T propre à chaque map |
| Historique des rounds | Force relative des équipes, mise à jour après chaque round ; effet pistol / anti-eco |
| Pour chaque survivant : **PV, arme, armure, kit** | Probabilité du round en cours. Un 4v1 avec 6 PV et un pistolet ne vaut pas un 4v1 en pleine santé. La courbe est calée sur les taux pro : 5v4 ≈ 71 %, 5v3 ≈ 86 %, 4v1 ≈ 96 %, 2v1 ≈ 70 % |
| Bombe posée, **compte à rebours de la bombe**, kit | Probabilité post-plant : le CT doit gagner ses duels ET avoir le temps de désamorcer (10 s, 5 s avec kit) |
| Stats avancées de chaque joueur (K-D, KAST, ADR, assists) + rating 3 mois | Niveau de chaque survivant dans les clutchs (forme du jour mélangée au niveau habituel) ; meilleur joueur de la map |
| Chrono du round, équipement officiel de début de round | Pression sur les T en fin de round ; type d'achat exact (eco / force / full) et achat probable au round suivant selon l'issue |
| Armes et argent | Type d'achat du round (eco / force / demi / full) et achat probable au round suivant |
| Probabilité live affichée par HLTV (widget « Live win probability ») | Comparée ligne à ligne avec ProBet : équipe 1 dans le temps réglementaire, prolongation, équipe 2 ; un écart de 10 points ou plus est signalé |

**Avant-match (lu sur la page, section « Avant-match » du panneau) :**

| Donnée HLTV | Utilisation |
|---|---|
| Cotes des bookmakers (si affichées) | Source principale de la force des équipes (marge retirée) |
| Points VRS (sinon classement HLTV) | Force des équipes quand il n'y a pas de cotes (HLTV masque les cotes en France) |
| Rating moyen des joueurs sur 3 mois | Ajustement léger |
| Taux de victoire sur la map jouée (3 mois) | Ajustement spécifique à la map, pondéré par le nombre de maps jouées |
| Maps déjà jouées dans la série, **mi-temps par mi-temps** | Preuve directe de l'écart entre les équipes (avec le côté CT/T de chaque moitié) |
| Format BO1/BO3/BO5, maps gagnées | Probabilité de gagner la série |

## Marchés calculés

Vainqueur du round en cours, vainqueur de la map, total de rounds (plus/moins), handicaps, prolongation oui/non, vainqueur de la série.

Pour chaque marché, ProBet donne la **probabilité**, la **cote juste** et la **cote minimale à exiger** chez votre bookmaker. Ouvrez **Tous les marchés** et entrez les cotes de votre bookmaker : les paris à espérance positive apparaissent en tête avec le badge **VALUE**, l'avantage en % et une mise conseillée (quart de Kelly, plafonnée à 5 % de la bankroll).

### Des paris stables

Un pari ne doit pas apparaître et disparaître à chaque kill. ProBet stabilise les propositions de plusieurs façons :

- **Tendances figées pendant le round.** Les paris TENDANCE (sans cote saisie) sont choisis entre les rounds, pendant la pause et l'achat, puis restent affichés jusqu'à la fin du round (mention « tendances figées pendant le round »). Une tendance figée n'est retirée que si la sélection n'est plus favorite. Si la probabilité a nettement bougé depuis, le panneau l'indique (« Maintenant … »).
- **Paris VALUE en direct.** Dès que vous entrez une cote, le calcul de valeur se fait en temps réel.
- **Probabilité prudente.** ProBet ne connaît pas exactement l'écart de niveau entre les équipes. Un pari n'est proposé que s'il reste bon quand les équipes sont un peu plus proches que prévu (un écart-type pour les tendances, un demi pour les paris VALUE). L'avantage affiché pour un pari VALUE est cet avantage prudent.
- **Hystérésis.** Un pari affiché reste tant qu'il ne passe pas sous un seuil de sortie plus bas que le seuil d'entrée : 60 % pour entrer en tendance, 55 % pour sortir ; pour un VALUE, la moitié de l'avantage minimum. Dans un même marché, la sélection affichée garde sa place face à une voisine à peine meilleure.
- **Lignes de total fixes** (19,5 à 23,5, comme chez les bookmakers), au lieu de lignes qui se déplacent avec le score.

Sur un match simulé, la liste des paris change environ 60 % moins souvent qu'avant.

Dans **Réglages** : bankroll, avantage minimum exigé pour un pari VALUE, et cotes d'avant-match manuelles si vous préférez les vôtres à celles affichées par HLTV.

## Journal des matchs (mesurer la justesse)

Pendant que vous suivez un match, ProBet enregistre sur votre PC, sans aucune requête :

- au début de chaque round : score, côtés, achats, équipement, ses probabilités et celle de HLTV ;
- à chaque kill ou pose de bombe : joueurs en vie, PV, armes, et les probabilités du moment ;
- le vainqueur de chaque round et le score final de la map (complété depuis la page si vous l'avez manquée) ;
- chaque pari proposé (TENDANCE ou VALUE, avec la cote saisie), réglé automatiquement à la fin.

Dans **Réglages → Journal des matchs** : le bilan (justesse des prévisions, ProBet contre HLTV, paris gagnés par rapport à l'annoncé), un bouton **Exporter le journal** (fichier `.json`) et un bouton **Effacer**. Envoyez l'export pour faire recalibrer le modèle sur de vrais matchs : les chiffres deviennent parlants après une dizaine de maps terminées.

Analyse d'un export (Node 20+) : `node tools/analyse-journal.mjs probet-journal-AAAA-MM-JJ.json`. L'analyse affiche le calibrage par tranche (« annoncé 70 % → observé … »), les paris par marché, et rejoue le modèle actuel sur les rounds enregistrés pour mesurer l'effet d'une modification.

Le score utilisé est l'écart quadratique moyen (score de Brier) : 0,25 correspond à un pile ou face, et plus il est bas, meilleures sont les prévisions.

## En cas de problème

- **« En attente des données live »** : le match n'a peut-être pas commencé. Sinon, rechargez la page HLTV : l'extension doit être chargée avant le scoreboard.
- **Une donnée semble fausse ou rien ne s'affiche :** dans **Réglages**, cliquez sur **Copier le diagnostic**, puis collez-le dans une conversation. Il contient ce que ProBet a reçu de la page, de quoi l'adapter si HLTV change sa structure.

## Calibrage

Les paramètres du modèle (`CAL` dans `extension/engine.js`) sont vérifiés sur des situations réelles où HLTV affichait sa propre probabilité (`test/calibration.test.js`). Exemple : Vitality-NaVi sur Anubis, à 4-0 ProBet donne 87 % (HLTV 87,4 %) et à 10-4 ProBet donne 98,8 % (HLTV 94,2 % + 4,5 % de prolongation).

Le modèle tient compte du fait que les rounds s'enchaînent par séries : le vainqueur d'un round garde l'avantage économique au suivant. Sans cela, une avance au score paraîtrait plus définitive qu'elle ne l'est.

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
  hltv.js         traduit les données HLTV en état de match (scores, côtés, économie, phases, avant-match)
  engine.js       moteur de probabilités (round, map, totaux, handicaps, série, value)
  picks.js        stabilisation des paris affichés (figés pendant le round, hystérésis)
  journal.js      journal des matchs : prévisions, résultats, paris réglés, bilan
  panel.*         panneau latéral (interface)
  demo.js         match simulé au format HLTV (mode démo, tests)
  background.js   ouvre le panneau au clic sur l'icône
tools/            analyse-journal.mjs : analyse d'un export du journal
test/             tests (npm test, Node 20+) ; test/fixtures : extrait réel d'une page de match HLTV
```
