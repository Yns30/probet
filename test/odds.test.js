import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// odds.js est un script de contenu classique : on l'exécute hors navigateur pour tester ses fonctions pures.
const ctx = vm.createContext({});
vm.runInContext(readFileSync(new URL('../extension/odds.js', import.meta.url), 'utf8'), ctx);
const { parseOdds, oppositeId } = ctx.__probetOddsCore;

test('lecture d’une cote dans le texte d’un bouton de bookmaker', () => {
  assert.equal(parseOdds('Vitality 1,85'), 1.85);
  assert.equal(parseOdds('1.85'), 1.85);
  assert.equal(parseOdds('Falcons\n2.10'), 2.1);
  assert.equal(parseOdds(' @ 12.50 '), 12.5);
  assert.equal(parseOdds('Plus de 22.5 1,90'), 1.9); // la ligne (1 décimale) n'est pas une cote
  assert.equal(parseOdds('22.5'), null);
  assert.equal(parseOdds('G2 -2.5'), null);
  assert.equal(parseOdds('1,90 1,85'), null); // deux cotes : ambigu
  assert.equal(parseOdds('Suspendu'), null);
  assert.equal(parseOdds('1,00'), null); // pas une cote jouable
  assert.equal(parseOdds('Vitality'), null);
});

test('marchés à deux issues : l’autre cote est liée automatiquement', () => {
  assert.equal(oppositeId('map:A'), 'map:B');
  assert.equal(oppositeId('series:B'), 'series:A');
  assert.equal(oppositeId('round7:A'), 'round7:B');
  assert.equal(oppositeId('ot:Y'), 'ot:N');
  assert.equal(oppositeId('tot22.5:O'), 'tot22.5:U');
  assert.equal(oppositeId('hcp-2.5:A'), null);
});

test('libellé d’une sélection sans sa cote, et comparaison des libellés', () => {
  const { stripOdds, overlap } = ctx.__probetOddsCore;
  assert.equal(stripOdds('Plus de 22.5\n1,90', 1.9), 'plus de 22.5');
  assert.equal(stripOdds('Vitality 1.85', 1.85), 'vitality');
  assert.equal(overlap('plus de 22.5', 'plus de 22.5'), 1);
  assert.ok(overlap('plus de 23.5', 'plus de 22.5') < 0.8); // autre ligne : pas confondue
  assert.equal(overlap('vitality', ''), 1);
});
