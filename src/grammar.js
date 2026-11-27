'use strict';
/**
 * Subject–verb agreement for team names. Teams are often plural nouns ("The Grinches", "Jingle Bell Rockers"),
 * so every sentence that puts a verb right after a team name asks this module for the verb.
 *
 *   isPluralTeam('The Grinches')       -> true      isPluralTeam('Team Rudolph')  -> false
 *   isPluralTeam("Frosty's Crew")      -> false     isPluralTeam('Boss')          -> false
 *   verb('The Grinches', 'wins', 'win') -> 'win'     isAre('Elf Help') -> 'is'     hasHave('Elves') -> 'have'
 *   subject('The Grinches', 'is')       -> 'The Grinches are'
 *
 * The SAME functions are exported by public/assets/client.js for the pages; keep the two copies identical
 * (test/game.test.js and test/assets.test.js check the same table).
 */

/** Singular words that end in "s" (a team called "Merry Christmas" or "Santa Claus" is one team). */
const SINGULAR_S = /(?:^|[^\p{L}])(?:christmas|xmas|nicholas|thomas|atlas|texas|vegas|elvis|chris|paris|news)$/iu;

/**
 * True for a team name that reads as a plural noun: it ends in "s" (ignoring trailing punctuation), but not in a
 * possessive "'s" / "’s", a double "ss" (Boss), "us" (Santa Claus, Krampus, Walrus) or a known singular word
 * (Merry Christmas, Saint Nicholas). "The Grinches", "Jingle Bell Rockers", "Elves" -> true;
 * "Team Rudolph", "Elf Help", "Naughty List", "Frosty's Crew" -> false.
 * Several names joined with "and" are plural, but pass that yourself: a team may be called "Milk and Cookie".
 * @param {unknown} name
 */
function isPluralTeam(name) {
  const s = String(name ?? '').trim().replace(/[^\p{L}\p{N}]+$/u, '');
  if (!/s$/i.test(s)) return false;
  if (/['’]s$/i.test(s) || /ss$/i.test(s) || /us$/i.test(s)) return false;
  return !SINGULAR_S.test(s);
}

/** The verb form that agrees with the name: verb(name, 'wins', 'win'). */
function verb(name, singular, plural) {
  return isPluralTeam(name) ? plural : singular;
}
const isAre = (name) => verb(name, 'is', 'are');
const hasHave = (name) => verb(name, 'has', 'have');
const wasWere = (name) => verb(name, 'was', 'were');

const IRREGULAR_VERBS = { is: 'are', has: 'have', was: 'were', does: 'do', goes: 'go' };
/**
 * "Name verb" with the verb agreeing: subject('The Grinches', 'is') -> "The Grinches are".
 * Pass the singular form; regular verbs drop their -s / -es ("wins" -> "win", "catches" -> "catch", "tries" -> "try").
 */
function subject(name, singular) {
  return `${name} ${verb(name, singular, pluralOf(singular))}`;
}
/** The plural (base) form of a singular present-tense verb: wins -> win, catches -> catch, tries -> try, is -> are. */
function pluralOf(singular) {
  const v = String(singular ?? '');
  const lower = v.toLowerCase();
  if (IRREGULAR_VERBS[lower]) return IRREGULAR_VERBS[lower];
  if (/[^aeiou]ies$/i.test(v)) return v.slice(0, -3) + 'y';
  if (/(ss|sh|ch|x|z|o)es$/i.test(v)) return v.slice(0, -2);
  if (/s$/i.test(v) && !/ss$/i.test(v)) return v.slice(0, -1);
  return v;
}

/** possessive('Team Rudolph') -> "Team Rudolph’s"; possessive('The Grinches') -> "The Grinches’" (same as client.js). */
function possessive(name) {
  const s = String(name ?? '').trim();
  if (!s) return '';
  return /s$/i.test(s) ? `${s}’` : `${s}’s`;
}

module.exports = { isPluralTeam, verb, isAre, hasHave, wasWere, subject, pluralOf, possessive };
