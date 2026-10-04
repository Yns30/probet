# ProBet CS2 — assistant de paris en direct

ProBet regarde le match CS2 **en même temps que vous** (YouTube, Twitch ou tout stream ouvert sur votre écran). Il lit l'état de la partie en continu et calcule **en direct** les probabilités de chaque marché pour vous proposer les paris à placer.

**100 % gratuit et local :** aucune API payante, aucun compte. La lecture du stream se fait dans votre navigateur, par OCR (Tesseract) et analyse des couleurs du HUD.

```
Stream (onglet du navigateur) ──► capture chaque seconde ──► OCR + analyse de pixels (local)
                                                                      │  score, chrono, joueurs en vie,
                                                                      │  côtés CT/T, bombe posée
                                                                      ▼
                     suivi des rounds (filtre d'erreurs) ──► moteur de probabilités ──► interface live épurée
```

## Ce qui est analysé

| Facteur | Source | Effet |
|---|---|---|
| Score, round, côtés CT/T | HUD du stream | Propagation exacte MR12 + prolongations MR3 |
| Joueurs en vie, bombe posée, chrono | Cartes joueurs grisées / chrono rouge | Probabilité de gagner le round en cours |
| Biais CT/T de la map | Map choisie dans les réglages | Taux de base par côté (ex. Nuke côté CT, Anubis côté T) |
| Pistol et anti-eco | Historique des rounds | Les rounds 2-3 favorisent fortement le vainqueur du pistol |
| Force relative des équipes | Cotes d'avant-match + rounds joués | Mise à jour bayésienne après chaque round |
| État de la série (BO1/3/5) | Réglages | Probabilité de gagner la série |

## Marchés calculés

- Vainqueur du round en cours (mis à jour à chaque kill)
- Vainqueur de la map
- Total de rounds (plus/moins), handicaps en rounds
- Prolongation oui/non
- Vainqueur de la série

Pour chacun, l'assistant donne la **probabilité du modèle**, la **cote juste** et la **cote minimale à prendre**. Si vous saisissez les cotes de votre bookmaker, il signale les paris **VALUE** (espérance positive) et propose une mise : un quart de Kelly, plafonné à 5 % de la bankroll et pondéré par la fiabilité.

## Installation

Il faut seulement Node.js 20+ (gratuit : https://nodejs.org).

```bash
npm install
npm start
```

Ouvrez ensuite **http://localhost:3000** dans Chrome, Edge ou Firefox. Tout fonctionne hors ligne une fois installé.

## Utilisation

1. Ouvrez le match sur YouTube ou Twitch dans un onglet, en grand, avec le HUD bien visible (qualité 720p ou plus).
2. Dans ProBet, cliquez sur **Connecter le stream** et choisissez l'onglet du match.
3. **Calibrez le HUD** (une seule fois par organisateur de tournoi : la calibration est mémorisée). Faites-le de préférence **pendant le temps d'achat**, quand les 10 joueurs sont en vie. Pour chaque zone, tracez un rectangle serré sur l'image :
   - **Score gauche / Score droite** (obligatoires) : juste les chiffres ;
   - **Chrono du round** : sert aussi à détecter la bombe (le chrono passe au rouge ou disparaît) ;
   - **Cartes joueurs gauche / droite** : le bloc des 5 joueurs de chaque équipe (les morts sont grisés) ;
   - **Couleur équipe gauche / droite** : une zone colorée par le côté (bleu = CT, orange = T), souvent le cadre du score.

   La ligne « Lecture test » affiche ce que l'assistant lit : vérifiez qu'elle correspond à l'image. Si des joueurs vivants sont comptés morts (ou l'inverse), ajustez la **sensibilité**.
4. Dans **Réglages**, indiquez les noms des équipes, la map, le format (BO1/BO3/BO5) et, si possible, les **cotes d'avant-match** des deux équipes. Elles calibrent la force des équipes avant les premiers rounds.
5. Suivez le panneau **Paris à jouer**. Il se met à jour chaque seconde.
6. Pour détecter la value, ouvrez **Tous les marchés** et entrez les cotes de votre bookmaker.

Le bouton **Démo** (ou `http://localhost:3000/?demo=1`) lance un match simulé pour essayer l'interface sans stream.

Si la lecture se trompe, **Réglages → Correction manuelle** permet de corriger le score, les maps gagnées, les côtés ou l'ordre des équipes. L'assistant repart de ces valeurs.

## Fiabilité intégrée

- Un score n'avance que **d'un round à la fois**. Tout autre saut (erreur de lecture, arrivée en cours de match, nouvelle map) doit être **confirmé par deux lectures identiques**.
- Joueurs en vie, côtés et bombe ne changent qu'après **deux lectures identiques** (un flash ou une transition ne fausse rien).
- Après un round, l'assistant attend le début du suivant (10 joueurs en vie ou chrono plein) avant de relire les joueurs.
- Si le diffuseur inverse les équipes à la mi-temps, l'inversion est détectée par les scores. Elle ne l'est pas quand les scores sont égaux : utilisez alors **Inverser gauche/droite**.
- Quand le score est illisible (replay, desk des analystes, pub), la lecture est mise en pause.
- L'indicateur **Fiabilité** combine la confiance de l'OCR, l'incertitude sur la force des équipes et le nombre de rounds observés. Les mises conseillées baissent avec elle.

## Ce que la lecture locale ne voit pas

Contrairement à un humain, l'OCR ne reconnaît ni les armes ni l'argent : le type d'achat (eco/force/full) n'est pas lu. L'effet économique du pistol et des rounds anti-eco reste pris en compte grâce à l'historique des rounds.

## Limites — à lire avant de parier

- **Retard du stream :** une diffusion YouTube/Twitch a souvent 10 à 60 s de retard sur le match réel, donc sur les cotes live des bookmakers. Vérifiez toujours le score affiché chez votre bookmaker avant de valider un pari.
- Le modèle est **statistique** : il estime des probabilités, il ne garantit rien. Une cote juste ne vaut que ce que vaut le modèle, et l'avantage n'existe que si la cote du bookmaker est nettement au-dessus.
- Ne jouez que ce que vous pouvez perdre. Réservé aux 18 ans et plus.

## Structure

```
server.js           serveur HTTP local (interface + fichiers de l'OCR)
public/reader.js    lecture locale du HUD : OCR Tesseract + calibration des zones
public/pixels.js    analyse de pixels (joueurs en vie, côtés, bombe, binarisation)
public/engine.js    moteur de probabilités (rounds, map, totaux, handicaps, série, value)
public/tracker.js   suivi de l'état du match à partir des lectures successives
public/demo.js      simulateur de match (mode démo)
public/app.js       interface, capture du stream, rendu
test/               tests (npm test)
```
