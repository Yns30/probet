// Lecture d'une image du stream CS2 par Claude (vision + sortie JSON structurée).
import Anthropic from '@anthropic-ai/sdk';

export const MODEL = process.env.PROBET_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.PROBET_EFFORT || 'low';

let client;

const int = { anyOf: [{ type: 'integer' }, { type: 'null' }] };
const str = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const side = { anyOf: [{ type: 'string', enum: ['CT', 'T'] }, { type: 'null' }] };
const buy = { type: 'string', enum: ['eco', 'force', 'half', 'full', 'unknown'] };

const team = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'score', 'side', 'alive', 'money', 'buy'],
  properties: {
    name: str,
    score: int,
    side,
    alive: int,
    money: int,
    buy,
  },
};

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'hud_visible', 'map', 'left', 'right', 'phase', 'round_timer', 'bomb_planted',
    'bomb_site', 'maps_left', 'maps_right', 'best_of', 'key_facts', 'confidence',
  ],
  properties: {
    hud_visible: { type: 'boolean' },
    map: str,
    left: team,
    right: team,
    phase: {
      type: 'string',
      enum: ['freezetime', 'live', 'bomb_planted', 'round_over', 'timeout', 'halftime', 'map_over', 'replay', 'not_ingame'],
    },
    round_timer: int,
    bomb_planted: { type: 'boolean' },
    bomb_site: { anyOf: [{ type: 'string', enum: ['A', 'B'] }, { type: 'null' }] },
    maps_left: int,
    maps_right: int,
    best_of: int,
    key_facts: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
  },
};

const SYSTEM = `Tu lis des images de retransmissions professionnelles Counter-Strike 2 (YouTube/Twitch) et tu en extrais l'état exact du match.

Tu reçois deux images : l'image complète du stream, puis un zoom haute résolution sur le bandeau du haut (scoreboard).

Règles :
- Ne rapporte que ce qui est visible. Mets null quand une valeur n'est pas lisible ; n'invente jamais.
- "left"/"right" = équipe affichée à gauche/droite du scoreboard du HUD. "name" = nom ou tag de l'équipe tel qu'affiché.
- "score" = rounds gagnés sur la map en cours. "side" = CT (bleu) ou T (orange/jaune), d'après la couleur du HUD.
- "alive" = joueurs encore en vie de l'équipe (0-5), d'après les panneaux joueurs (barres de vie, joueurs grisés/morts).
- "money" = argent total de l'équipe si affiché, sinon null. "buy" = type d'achat estimé d'après l'équipement visible (armes principales, armures) : eco, force, half, full, ou unknown.
- "phase" : freezetime (temps d'achat), live (round en cours), bomb_planted, round_over (après la fin du round), timeout, halftime, map_over, replay (ralenti/replay), not_ingame (desk d'analystes, pub, écran de pause, autre).
- "round_timer" = secondes restantes affichées (convertis m:ss), null si la bombe est posée ou si illisible.
- "maps_left"/"maps_right" = maps gagnées dans la série si affichées ; "best_of" = 1, 3 ou 5 si indiqué.
- "key_facts" : 0 à 3 faits courts et utiles pour un parieur, en français (ex. « AWP côté CT », « clutch 1v2 en cours », « T en eco »). Pas de banalités.
- "confidence" : 0 à 1, ta confiance dans la lecture des scores et joueurs en vie.
- Si ce n'est pas une partie CS2 en cours, mets hud_visible=false et phase=not_ingame.`;

// frame, hud : data URLs JPEG. context : dernier état connu, pour cohérence de lecture.
export async function readFrame({ frame, hud, context }) {
  const image = (dataUrl) => {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(dataUrl || '');
    if (!m) throw new Error('image invalide');
    return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
  };
  const content = [image(frame)];
  if (hud) content.push(image(hud));
  content.push({
    type: 'text',
    text:
      'Lis cette image du match.' +
      (context ? `\nDernier état lu (référence seulement, l'image fait foi) : ${JSON.stringify(context)}` : ''),
  });

  client ??= new Anthropic();
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: EFFORT, format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content }],
  });

  if (response.stop_reason === 'refusal') throw new Error('lecture refusée par le modèle');
  if (response.stop_reason === 'max_tokens') throw new Error('réponse tronquée');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { state: JSON.parse(text), usage: response.usage, model: response.model };
}
