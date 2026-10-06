# ProBet CS2 — assistant de paris en direct (HLTV)

ProBet est une extension Chrome/Edge. Laissez ouverte sur votre PC la page HLTV du match en cours : ProBet lit en direct les données de cette page et affiche, dans un panneau latéral, les probabilités et les paris à jouer.

```
Page de match HLTV ouverte ──► données live reçues par la page (scorebot)
                                │  score, round, côtés, joueurs en vie, PV, argent,
                                │  armes, bombe, historique des rounds, kills…
                                ▼
                         moteur de probabilités ──► panneau ProBet (à côté de la page)
```

- **Gratuit, sans compte, sans API, sans proxy.** ProBet n'envoie aucune requête à HLTV : il écoute les données que la page ouverte reçoit déjà pour afficher son scoreboard live. Les cotes sont lues de la même façon sur la page de votre bookmaker.
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
| Taux de victoire sur la map jouée (3 mois) | Ajustement spécifique à la map, pondéré par le nombre de maps jouées (la donnée d'avant-match la plus utile sur les matchs enregistrés) |
| Maps déjà jouées dans la série, **mi-temps par mi-temps** | Preuve directe de l'écart entre les équipes (avec le côté CT/T de chaque moitié) |
| Format BO1/BO3/BO5, maps gagnées | Probabilité de gagner la série |

## Comment parier avec ProBet

La section **Que jouer ?** est un tableau fixe : toujours les mêmes lignes, dans le même ordre (round en cours, vainqueur de la map, handicap, total de rounds, prolongation, vainqueur du match). Chaque ligne a un statut :

| Statut | Signification | Que faire |
|---|---|---|
| **À JOUER** (vert) | Sélection solide | Jouez seulement si la cote du bookmaker est **au moins égale à la cote minimale** affichée |
| **SI BONNE COTE** (orange) | Quasi acquis | La cote sera sûrement trop basse ; jouez seulement si elle atteint le minimum |
| **PAS DE PARI** (gris) | Trop incertain, ou cote saisie trop basse | Ne jouez pas ce marché pour l'instant |

1. Repérez une ligne **À JOUER**, ouvrez ce marché chez votre bookmaker.
2. Comparez sa cote à la **cote minimale** de ProBet : au-dessus, le pari est rentable à long terme ; en dessous, passez.
3. Pour être sûr, tapez la cote du bookmaker dans la case **Cote** de la ligne : ProBet affiche l'avantage et la mise conseillée, ou « pas de pari ».
4. Mises petites et fixes (1 à 2 % de la bankroll), ou celle indiquée après saisie de la cote. Ne cumulez pas « vainqueur de la map » et « handicap » sur la même équipe : ils gagnent ou perdent ensemble.

### Cotes Stake 100 % automatiques

Avec **Stake**, il n'y a rien à faire : ouvrez la page du match sur Stake dans un autre onglet, c'est tout.

- ProBet reconnaît le match tout seul grâce aux noms des équipes (« Falcons » = « Team Falcons », « NAVI » = « Natus Vincere »…) et sait quelle équipe est à domicile chez Stake.
- Il remplit automatiquement les cotes de la **map en cours** : vainqueur de la map, handicap de rounds, total de rounds plus/moins, prolongation, round pistol, et vainqueur du match.
- Les cotes se mettent à jour en direct, avec le conseil (À JOUER / PAS DE PARI, avantage, mise). La ligne « ● Cotes stake.com en direct » sous « Que jouer ? » confirme la connexion.
- Si Stake suspend un marché, ProBet affiche « suspendu » et ne s'en sert pas. Si l'onglet Stake est fermé, les cotes disparaissent.

Comment ça marche : ProBet lit les données que la page Stake reçoit déjà pour s'afficher (la liste des marchés intégrée à la page, puis le flux de mises à jour du site et les cotes affichées). Aucune requête supplémentaire n'est envoyée à Stake, rien n'est cliqué ni ajouté au coupon. Domaines pris en charge : stake.com et ses miroirs (stake.bet, stake.ac, stake.games…).

### Autres bookmakers (liaison en un clic)

Pour un autre bookmaker, ProBet lit les cotes sur sa page ouverte dans un autre onglet, de la même façon qu'il lit HLTV.

1. Ouvrez la page du match chez votre bookmaker (Betclic, Winamax, Unibet…).
2. Dans ProBet, cliquez sur 🔗 à côté d'une ligne (ou dans « Tous les marchés »). La première fois, Chrome demande l'autorisation de lire les pages des sites : acceptez.
3. Dans l'onglet du bookmaker, un cadre vert suit la souris : cliquez sur la cote correspondante. **Ce clic n'ajoute rien à votre coupon.** Pour un marché à deux issues, l'autre cote est liée en même temps.
4. La cote s'affiche en vert dans ProBet et se met à jour chaque seconde. Le lien survit au rechargement de la page ; ✕ le supprime.

Une cote liée à la main est prioritaire sur la cote Stake automatique.

Les conseils sont choisis entre les rounds et figés pendant le round (mention « conseils figés pendant le round ») ; une cote que vous saisissez est évaluée tout de suite.

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

Dans **Réglages → Journal des matchs** : le bilan (justesse des prévisions, ProBet contre HLTV, paris gagnés par rapport à l'annoncé), un bouton **Exporter le journal** (fichier `.json`) et un bouton **Effacer**. Envoyez l'export pour faire recalibrer le modèle sur de vrais matchs : les chiffres deviennent parlants après une dizaine de maps terminées. Les journaux des versions 2.5.x, où une même map pouvait apparaître plusieurs fois, sont nettoyés automatiquement à l'ouverture du panneau.

Analyse d'un export (Node 20+) : `node tools/analyse-journal.mjs probet-journal-AAAA-MM-JJ.json`. L'analyse affiche le calibrage par tranche (« annoncé 70 % → observé … »), les paris par marché, et rejoue le modèle actuel sur les rounds enregistrés pour mesurer l'effet d'une modification.

Le score utilisé est l'écart quadratique moyen (score de Brier) : 0,25 correspond à un pile ou face, et plus il est bas, meilleures sont les prévisions.

## En cas de problème

- **« En attente des données live »** : le match n'a peut-être pas commencé. Sinon, rechargez la page HLTV : l'extension doit être chargée avant le scoreboard.
- **Une donnée semble fausse ou rien ne s'affiche :** dans **Réglages**, cliquez sur **Copier le diagnostic**, puis collez-le dans une conversation. Il contient ce que ProBet a reçu de la page, de quoi l'adapter si HLTV change sa structure.

## Calibrage

Les paramètres du modèle (`CAL` dans `extension/engine.js`) sont vérifiés sur des situations réelles où HLTV affichait sa propre probabilité (`test/calibration.test.js`). Exemple : Vitality-NaVi sur Anubis, à 4-0 ProBet donne 87 % (HLTV 87,4 %) et à 10-4 ProBet donne 98,8 % (HLTV 94,2 % + 4,5 % de prolongation).

**Premier recalage sur 9 maps réelles (127 rounds, 527 moments de jeu enregistrés) :**

- *Achats lus trop tôt.* En début de round, HLTV transmet l'équipement joueur par joueur pendant 1 à 3 secondes. ProBet prenait ces valeurs incomplètes pour l'achat du round (32 rounds lus « eco contre eco », alors que la plupart étaient des full buy). L'achat n'est désormais retenu qu'une fois au moins 4 joueurs par équipe reçus ; d'ici là, il est « inconnu ».
- *À 5 contre 5, la probabilité d'avant-round.* Avant le premier kill, la probabilité du round vient de l'économie, de la force des équipes et du côté : c'est le calcul le mieux calibré sur les matchs enregistrés (eco contre full buy : 18 % annoncé, 17 % observé). Le détail joueur par joueur comptait deux fois la force des équipes et donnait jusqu'à 88 % dans des full buy contre full buy. Dès le premier kill, le modèle de situation (joueurs en vie, PV, armes, bombe), déjà bien calibré sur les moments enregistrés, prend le relais.
- *Tendances* figées à partir du premier kill (et non plus dès le début du round, quand les achats ne sont pas encore connus).
- Résultat sur les débuts de round : score de Brier 0,246 → 0,234. Sur la map, ProBet fait mieux que HLTV sur 7 des 9 maps.

**Deuxième recalage sur 21 maps (dont 9 enregistrées avec les achats bien lus) :**

- Avec la version 2.6, les débuts de round passent à un score de Brier de 0,218 (0,246 avant), et sur la map ProBet fait nettement mieux que la probabilité live de HLTV (0,162 contre 0,209 aux mêmes moments).
- *Prévisions entre les rounds tempérées.* Les tendances « vainqueur du round » proposées pendant la pause ou l'achat reposaient sur l'économie *prévue* : 72 % annoncés, 63 % observés, alors qu'au début du round (achats connus) la probabilité était juste. Tant que les achats ne sont pas connus, la probabilité du round est maintenant tempérée (`CAL.preBuy` = 0,55 sur l'échelle logit).
- Marchés de la map (vainqueur, handicaps, totaux, prolongation) : bien calibrés à tous les moments enregistrés ; les paris perdus se concentrent sur quelques maps à grosse remontée (8-2 → 8-13), où plusieurs paris sur la même équipe perdent ensemble.

**Troisième recalage (journal propre en version 2.7 : 14 maps, puis 31 maps cumulées) :**

- Version 2.7 : ProBet 0,149 contre HLTV 0,175 sur la map ; tendances gagnées 72 % pour 74 % annoncés ; débuts de round et moments en cours de round bien calibrés (aucune correction nécessaire).
- *Avant-match* : sur 31 maps, l'estimation fait mieux que chaque source seule. Le taux de victoire de chaque équipe sur la map jouée (3 mois) est la donnée la plus utile : son poids passe de 0,5 à 0,75 (Brier 0,223 → 0,218), valeur vérifiée sur deux moitiés indépendantes des matchs.
- *Historique des rounds incomplet* : sur une map, HLTV n'envoyait plus l'historique des rounds ; ProBet perdait alors le côté de chaque round. Il complète désormais l'historique avec les changements de score observés en direct.

Le modèle tient compte du fait que les rounds s'enchaînent par séries : le vainqueur d'un round garde l'avantage économique au suivant. Sans cela, une avance au score paraîtrait plus définitive qu'elle ne l'est.

## Limites

- HLTV a lui aussi quelques secondes de retard sur le match réel, et les cotes live bougent vite. Vérifiez le score chez votre bookmaker avant de valider un pari.
- Les cotes Stake affichées dans ProBet peuvent avoir une ou deux secondes de retard : la cote qui compte est celle du coupon Stake au moment de valider.
- Le modèle est **statistique** : il estime des probabilités, il ne garantit rien. L'avantage n'existe que si la cote du bookmaker est nettement au-dessus de la cote juste.
- Les paris « vainqueur de la map » et « handicap » sur la même équipe gagnent ou perdent presque toujours ensemble : en jouer plusieurs sur une même map revient à miser plus gros sur un seul scénario.
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
  advice.js       tableau « Que jouer ? » : une ligne par marché, statut et cote minimale
  odds.js         lecture des cotes sur la page du bookmaker (liaison par clic, suivi en direct)
  stake.js        cotes Stake automatiques (données de la page, flux en direct, cotes affichées)
  stake-relay.js  relais Stake → panneau
  books.js        match Stake ↔ match HLTV (noms d'équipes) et marchés Stake → marchés ProBet
  journal.js      journal des matchs : prévisions, résultats, paris réglés, bilan
  panel.*         panneau latéral (interface)
  demo.js         match simulé au format HLTV (mode démo, tests)
  background.js   ouvre le panneau au clic sur l'icône
tools/            analyse-journal.mjs : analyse d'un export du journal
test/             tests (npm test, Node 20+) ; test/fixtures : extrait réel d'une page de match HLTV
```
