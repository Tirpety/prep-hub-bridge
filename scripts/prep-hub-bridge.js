/* global foundry, game, ui, Hooks, canvas, CONFIG, CONST */
import {
  MODULE_ID,
  announceHtml,
  announcementHtml,
  handoutOwnership,
  ROOT_FOLDER,
  clusterPositions,
  escapeHtml,
  levelPlacement,
  mapActorIndexEntry,
  mapItemIndexEntry,
  normalizeName,
  npcActorSource,
  packPriority,
  rewriteLinks,
  threatLabel,
} from './lib.js';

const log = (...args) => console.log('Prep Hub |', ...args);
const setting = (key) => game.settings.get(MODULE_ID, key);

// Reach core classes through CONFIG and foundry.utils instead of legacy globals, so the same
// code runs on Foundry v12, v13 and v14.
const docClass = (name) => CONFIG[name].documentClass;
const resolveUuid = (uuid) => (foundry.utils.fromUuid ?? globalThis.fromUuid)(uuid);

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

class PrepHubBridge {
  status = 'disconnected'; // disconnected | connecting | connected | reconnecting | error | no-key
  statusDetail = '';
  campaign = null;
  activity = [];
  #source = null;
  #processing = Promise.resolve();
  #seen = new Set();
  #listeners = new Set();

  get url() {
    return String(setting('serverUrl') || 'http://localhost:4100').replace(/\/+$/, '');
  }

  get key() {
    return String(setting('bridgeKey') || '').trim();
  }

  onChange(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #setStatus(status, detail = '') {
    this.status = status;
    this.statusDetail = detail;
    for (const fn of this.#listeners) fn();
  }

  #record(label, ok, detail = '') {
    this.activity.unshift({ at: Date.now(), label, ok, detail });
    this.activity = this.activity.slice(0, 20);
    for (const fn of this.#listeners) fn();
  }

  async request(path, { method = 'GET', body } = {}) {
    const res = await fetch(`${this.url}/api/bridge${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Prep-Hub-Key': this.key },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text };
    }
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    return data;
  }

  disconnect() {
    this.#source?.close();
    this.#source = null;
    this.#setStatus('disconnected');
  }

  async connect({ quiet = false } = {}) {
    this.#source?.close();
    this.#source = null;
    if (!this.key) {
      this.#setStatus('no-key', 'Paste the bridge key from Prep Hub into the module settings.');
      if (!quiet) ui.notifications.warn('Prep Hub: no bridge key set. Open the Prep Hub panel to add it.');
      return false;
    }
    this.#setStatus('connecting');
    try {
      const ping = await this.request('/ping');
      this.campaign = ping.campaign;
    } catch (err) {
      this.#setStatus('error', `Could not reach Prep Hub at ${this.url}: ${err.message}`);
      if (!quiet) ui.notifications.error(`Prep Hub: ${this.statusDetail}`);
      return false;
    }

    const params = new URLSearchParams({
      key: this.key,
      world: game.world.id,
      worldTitle: game.world.title,
      user: game.user.name,
      foundryVersion: game.version,
      system: game.system.id,
      systemVersion: game.system.version,
      moduleVersion: game.modules.get(MODULE_ID)?.version ?? '',
    });
    const source = new EventSource(`${this.url}/api/bridge/events?${params}`);
    this.#source = source;
    source.addEventListener('hello', () => {
      this.#setStatus('connected');
      log('Connected to', this.url);
    });
    source.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.#enqueue(msg);
    });
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) this.#setStatus('error', 'Connection refused (check the bridge key).');
      else this.#setStatus('reconnecting', 'Lost connection — retrying…');
    };

    if (setting('autoSyncParty')) {
      this.syncParty({ quiet: true }).catch((err) => log('Party sync failed', err));
    }
    return true;
  }

  #enqueue(msg) {
    if (!msg?.id || this.#seen.has(msg.id)) return;
    this.#seen.add(msg.id);
    this.#processing = this.#processing.then(() => this.#handle(msg));
  }

  async #handle(msg) {
    const handler = HANDLERS[msg.type];
    let ok = true;
    let result;
    let error;
    try {
      if (!handler) throw new Error(`Unsupported message type "${msg.type}" — update the Prep Hub Bridge module.`);
      result = await handler(msg.payload ?? {}, this);
      this.#record(msg.label ?? msg.type, true, result?.summary ?? '');
    } catch (err) {
      ok = false;
      error = err?.message ?? String(err);
      console.error('Prep Hub |', err);
      ui.notifications.error(`Prep Hub: ${msg.label ?? msg.type} failed — ${error}`);
      this.#record(msg.label ?? msg.type, false, error);
    }
    try {
      await this.request('/ack', { method: 'POST', body: { id: msg.id, ok, result, error } });
    } catch (err) {
      log('Failed to acknowledge message', err);
    }
  }

  // ---- Foundry → Prep Hub -------------------------------------------------

  async syncParty({ quiet = false } = {}) {
    const party = game.actors.party?.members?.filter((a) => a?.type === 'character');
    const actors = party?.length ? party : game.actors.filter((a) => a.type === 'character' && a.hasPlayerOwner);
    const members = actors.map((a) => ({
      id: a.id,
      uuid: a.uuid,
      name: a.name,
      level: Number(a.level ?? a.system?.details?.level?.value ?? 1),
      className: a.class?.name ?? '',
      ancestry: a.ancestry?.name ?? '',
      heritage: a.heritage?.name ?? '',
      background: a.background?.name ?? '',
      player: game.users.find((u) => !u.isGM && a.testUserPermission(u, 'OWNER'))?.name ?? '',
      img: a.img,
      hp: a.system?.attributes?.hp?.max,
      ac: a.system?.attributes?.ac?.value,
      perception: a.perception?.mod ?? a.system?.perception?.mod ?? a.system?.attributes?.perception?.value,
    }));
    try {
      const res = await this.request('/party', { method: 'POST', body: { world: game.world.id, system: game.system.id, actors: members } });
      const summary = `${members.length} characters → “${res.campaign}” (${res.created} new, ${res.updated} updated)`;
      this.#record('Party sync', true, summary);
      if (!quiet) ui.notifications.info(`Prep Hub: sent ${summary}.`);
      return { summary };
    } catch (err) {
      this.#record('Party sync', false, err.message);
      if (!quiet) ui.notifications.error(`Prep Hub: party sync failed — ${err.message}`);
      throw err;
    }
  }

  /** Sends an index of the item compendiums (weapons, armour, gear, consumables, treasure) for real loot. */
  async syncItems({ quiet = false } = {}) {
    const fields = ['system.level.value', 'system.price.value', 'system.traits.value', 'system.traits.rarity', 'system.publication.title', 'system.source.value'];
    const items = [];
    const packs = game.packs.filter((p) => p.documentName === 'Item');
    if (!quiet) ui.notifications.info(`Prep Hub: indexing ${packs.length} item compendiums…`);
    for (const pack of packs) {
      try {
        const index = await pack.getIndex({ fields });
        for (const entry of index) {
          const uuid = entry.uuid ?? `Compendium.${pack.collection}.Item.${entry._id}`;
          const item = mapItemIndexEntry({ ...entry, uuid }, pack.metadata.label, game.system.id);
          if (item) items.push(item);
        }
      } catch (err) {
        log(`Skipping pack ${pack.collection}`, err);
      }
    }
    try {
      const res = await this.request('/items', { method: 'POST', body: { world: game.world.title, system: game.system.id, items } });
      const summary = `${res.count} items`;
      this.#record('Item sync', true, summary);
      if (!quiet) ui.notifications.info(`Prep Hub: sent ${summary}.`);
      return { summary };
    } catch (err) {
      this.#record('Item sync', false, err.message);
      if (!quiet) ui.notifications.error(`Prep Hub: item sync failed — ${err.message}`);
      throw err;
    }
  }

  async syncBestiary({ quiet = false } = {}) {
    const fields = [
      'system.details.level.value',
      'system.details.isComplex',
      'system.details.publication.title',
      'system.details.source.value',
      'system.traits.value',
      'system.traits.rarity',
      'system.traits.size.value',
      'system.attributes.hp.max',
      'system.attributes.ac.value',
    ];
    const creatures = [];
    const packs = game.packs.filter((p) => p.documentName === 'Actor');
    if (!quiet) ui.notifications.info(`Prep Hub: indexing ${packs.length} actor compendiums…`);
    for (const pack of packs) {
      try {
        const index = await pack.getIndex({ fields });
        for (const entry of index) {
          if (entry.type !== 'npc' && entry.type !== 'hazard') continue;
          const uuid = entry.uuid ?? `Compendium.${pack.collection}.Actor.${entry._id}`;
          creatures.push(mapActorIndexEntry({ ...entry, uuid }, pack.metadata.label));
        }
      } catch (err) {
        log(`Skipping pack ${pack.collection}`, err);
      }
    }
    for (const actor of game.actors) {
      if ((actor.type !== 'npc' && actor.type !== 'hazard') || actor.hasPlayerOwner || actor.getFlag(MODULE_ID, 'imported')) continue;
      creatures.push(mapActorIndexEntry({ ...actor.toObject(), uuid: actor.uuid, type: actor.type }, `World: ${game.world.title}`));
    }
    try {
      // Prep Hub keeps one bestiary per game system (pf2e, sf2e) and files this sync under the world's.
      const res = await this.request('/bestiary', { method: 'POST', body: { world: game.world.title, system: game.system.id, creatures } });
      const summary = `${res.count} creatures & hazards`;
      this.#record('Bestiary sync', true, summary);
      if (!quiet) ui.notifications.info(`Prep Hub: sent ${summary}.`);
      return { summary };
    } catch (err) {
      this.#record('Bestiary sync', false, err.message);
      if (!quiet) ui.notifications.error(`Prep Hub: bestiary sync failed — ${err.message}`);
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Prep Hub → Foundry handlers
// ---------------------------------------------------------------------------

async function ensureFolder(name, type, parent = null) {
  const parentId = parent?.id ?? null;
  const existing = game.folders.find((f) => f.type === type && f.name === name && (f.folder?.id ?? null) === parentId);
  if (existing) return existing;
  return docClass('Folder').create({ name, type, folder: parentId, color: parent ? undefined : '#7a4b2a' });
}

function findJournal(prepHubId) {
  return game.journal.find((j) => j.getFlag(MODULE_ID, 'id') === prepHubId);
}

const HTML_FORMAT = () => CONST?.JOURNAL_ENTRY_PAGE_FORMATS?.HTML ?? 1;

async function upsertJournals(entries) {
  const root = await ensureFolder(ROOT_FOLDER, 'JournalEntry');
  const folders = new Map();
  const journals = new Map();
  let created = 0;
  let updated = 0;

  // Pass 1: make sure every journal exists so links between them resolve.
  for (const entry of entries) {
    if (!folders.has(entry.folder)) folders.set(entry.folder, await ensureFolder(entry.folder, 'JournalEntry', root));
    let journal = findJournal(entry.prepHubId);
    // Player handouts are readable by everyone (Observer); unsharing hides them again.
    const ownership = handoutOwnership(entry.playerVisible, CONST?.DOCUMENT_OWNERSHIP_LEVELS);
    if (!journal) {
      journal = await docClass('JournalEntry').create({
        name: entry.name,
        folder: folders.get(entry.folder).id,
        flags: { [MODULE_ID]: { id: entry.prepHubId, type: entry.entityType } },
        ...(ownership !== null ? { ownership: { default: ownership } } : {}),
        pages: [{ name: entry.name, type: 'text', text: { content: '', format: HTML_FORMAT() }, flags: { [MODULE_ID]: { main: true } } }],
      });
      created++;
    } else {
      if (ownership !== null && journal.ownership?.default !== ownership) await journal.update({ 'ownership.default': ownership });
      updated++;
    }
    journals.set(entry.prepHubId, journal);
  }

  // Pass 2: write content with links rewritten to @UUID references.
  const resolve = (id) => (journals.get(id) ?? findJournal(id))?.uuid ?? null;
  for (const entry of entries) {
    const journal = journals.get(entry.prepHubId);
    const content = rewriteLinks(entry.html, resolve);
    if (journal.name !== entry.name) await journal.update({ name: entry.name });
    const page = journal.pages.find((p) => p.getFlag(MODULE_ID, 'main')) ?? journal.pages.contents[0];
    if (page) await page.update({ name: entry.name, 'text.content': content, 'text.format': HTML_FORMAT() });
    else
      await journal.createEmbeddedDocuments('JournalEntryPage', [
        { name: entry.name, type: 'text', text: { content, format: HTML_FORMAT() }, flags: { [MODULE_ID]: { main: true } } },
      ]);
  }
  return { created, updated, journals };
}

let compendiumIndexCache = null;

async function compendiumNameIndex() {
  if (compendiumIndexCache) return compendiumIndexCache;
  const map = new Map();
  const packs = game.packs.filter((p) => p.documentName === 'Actor').sort((a, b) => packPriority(a) - packPriority(b));
  for (const pack of packs) {
    const index = await pack.getIndex();
    for (const entry of index) {
      if (entry.type !== 'npc' && entry.type !== 'hazard') continue;
      const key = normalizeName(entry.name);
      if (!map.has(key)) map.set(key, entry.uuid ?? `Compendium.${pack.collection}.Actor.${entry._id}`);
    }
  }
  compendiumIndexCache = map;
  return map;
}

async function resolveSource(spec) {
  if (spec.uuid) {
    const doc = await resolveUuid(spec.uuid).catch(() => null);
    if (doc) return doc;
  }
  const worldMatch = game.actors.find((a) => normalizeName(a.name) === normalizeName(spec.name) && (a.type === 'npc' || a.type === 'hazard') && !a.hasPlayerOwner);
  if (worldMatch) return worldMatch;
  const uuid = (await compendiumNameIndex()).get(normalizeName(spec.name));
  return uuid ? resolveUuid(uuid).catch(() => null) : null;
}

async function applyAdjustment(actor, adjustment) {
  if (!adjustment || adjustment === 'normal' || actor.type !== 'npc') return;
  if (typeof actor.applyAdjustment === 'function') await actor.applyAdjustment(adjustment);
  else await actor.update({ 'system.attributes.adjustment': adjustment });
}

/**
 * Creates (or updates) an NPC actor from a Prep Hub stat block. If this system version rejects
 * part of the data, it falls back step by step; the full stat block is always in the notes.
 */
async function actorFromStatblock(block, { name, folder, flags, notesHtml, existing = null }) {
  const src = npcActorSource(block, { notesHtml, randomId: () => foundry.utils.randomID() });
  let actor = existing;
  try {
    if (actor) await actor.update({ name, system: src.system });
    else actor = await docClass('Actor').create({ name, type: 'npc', folder: folder?.id ?? null, flags, system: src.system });
  } catch (err) {
    log('Full NPC data was rejected; creating a basic actor with the stat block in its notes', err);
    const basic = { details: { level: { value: Number(block.level) || 0 }, publicNotes: notesHtml } };
    if (actor) await actor.update({ name, system: basic }).catch(() => {});
    else actor = await docClass('Actor').create({ name, type: 'npc', folder: folder?.id ?? null, flags, system: basic });
  }
  try {
    const old = actor.items.filter((i) => i.getFlag(MODULE_ID, 'generated'));
    if (old.length) await actor.deleteEmbeddedDocuments('Item', old.map((i) => i.id));
    const items = src.items.map((i) => ({ ...i, flags: { [MODULE_ID]: { generated: true } } }));
    if (items.length) await actor.createEmbeddedDocuments('Item', items);
  } catch (err) {
    log('Could not add Strikes and abilities; they are in the notes', err);
  }
  return actor;
}

/** Imports (or reuses) a world actor for an encounter line. */
async function actorFor(spec, kind, folder) {
  const adjustment = spec.adjustment ?? 'normal';
  const reuse = game.actors.find(
    (a) => a.folder?.id === folder.id && a.getFlag(MODULE_ID, 'specKey') === `${normalizeName(spec.name)}|${adjustment}`,
  );
  if (reuse) return { actor: reuse, placeholder: Boolean(reuse.getFlag(MODULE_ID, 'placeholder')) };

  const flags = { [MODULE_ID]: { imported: true, specKey: `${normalizeName(spec.name)}|${adjustment}` } };
  const source = await resolveSource(spec);
  let actor;
  let placeholder = false;
  if (source?.pack) {
    const data = game.actors.fromCompendium(source);
    data.folder = folder.id;
    data.flags = foundry.utils.mergeObject(data.flags ?? {}, flags);
    actor = await docClass('Actor').create(data);
  } else if (source) {
    const data = source.toObject();
    delete data._id;
    data.folder = folder.id;
    data.flags = foundry.utils.mergeObject(data.flags ?? {}, flags);
    actor = await docClass('Actor').create(data);
  } else if (spec.statblock) {
    // Homebrew from Prep Hub's creature builder: build the real thing.
    flags[MODULE_ID].creatureId = spec.prepHubId ?? null;
    actor = await actorFromStatblock(spec.statblock, { name: spec.name, folder, flags, notesHtml: spec.notesHtml ?? '' });
  } else {
    placeholder = true;
    flags[MODULE_ID].placeholder = true;
    const system =
      kind === 'hazard'
        ? { details: { level: { value: spec.level }, isComplex: Boolean(spec.complex) } }
        : { details: { level: { value: spec.level } } };
    actor = await docClass('Actor').create({ name: spec.name, type: kind === 'hazard' ? 'hazard' : 'npc', folder: folder.id, system, flags });
  }
  await applyAdjustment(actor, adjustment);
  return { actor, placeholder };
}

async function importEncounter(payload) {
  const root = await ensureFolder(ROOT_FOLDER, 'Actor');
  const folder = await ensureFolder(payload.name || 'Encounter', 'Actor', root);
  const lines = [];
  const placeholders = [];

  for (const spec of payload.creatures ?? []) {
    const { actor, placeholder } = await actorFor(spec, 'creature', folder);
    if (placeholder) placeholders.push(spec.name);
    lines.push({ actor, qty: Math.max(1, Number(spec.qty) || 1), spec, kind: 'creature' });
  }
  for (const spec of payload.hazards ?? []) {
    const { actor, placeholder } = await actorFor(spec, 'hazard', folder);
    if (placeholder) placeholders.push(spec.name);
    lines.push({ actor, qty: Math.max(1, Number(spec.qty) || 1), spec, kind: 'hazard' });
  }

  // Optional: drop hidden tokens around the centre of the current view.
  let tokens = [];
  const scene = canvas?.scene;
  if (payload.placeTokens && scene) {
    const gridSize = scene.grid?.size ?? canvas.grid?.size ?? 100;
    const center = canvas.stage?.pivot ?? { x: scene.dimensions?.width / 2, y: scene.dimensions?.height / 2 };
    const total = lines.reduce((s, l) => s + l.qty, 0);
    const positions = clusterPositions(total, center, gridSize);
    const placement = levelPlacement(canvas.level);
    const data = [];
    let i = 0;
    for (const line of lines) {
      for (let n = 0; n < line.qty; n++) {
        const pos = positions[i++];
        const doc = await line.actor.getTokenDocument({ x: pos.x, y: pos.y, hidden: true, ...placement });
        data.push(doc.toObject());
      }
    }
    tokens = await scene.createEmbeddedDocuments('Token', data);
  }

  let combat = null;
  if (payload.createCombat && tokens.length) {
    combat = await docClass('Combat').create({ scene: scene.id, active: true });
    const combatants = tokens
      .filter((t) => t.actor?.type !== 'hazard' || t.actor?.system?.details?.isComplex)
      .map((t) => ({ tokenId: t.id, sceneId: scene.id, actorId: t.actorId, hidden: t.hidden }));
    await combat.createEmbeddedDocuments('Combatant', combatants);
  }

  // Encounter journal with links to the imported actors.
  const rows = lines
    .map(
      ({ actor, qty, spec, kind }) =>
        `<li>${qty}× @UUID[${actor.uuid}]{${escapeHtml(actor.name)}} — level ${spec.level}${
          spec.adjustment && spec.adjustment !== 'normal' ? ` (${spec.adjustment})` : ''
        }${kind === 'hazard' ? ` · ${spec.complex ? 'complex' : 'simple'} hazard` : ''}</li>`,
    )
    .join('');
  const html = `<p><strong>${threatLabel(payload.threat)}</strong> threat · ${payload.totalXp} XP for a party of ${payload.partySize} at level ${payload.partyLevel}</p><ul>${rows}</ul>${
    placeholders.length ? `<p><em>Placeholder actors (not found in compendiums): ${placeholders.map(escapeHtml).join(', ')}</em></p>` : ''
  }${payload.notesHtml ?? ''}`;
  await upsertJournals([{ prepHubId: payload.prepHubId, name: `Encounter: ${payload.name}`, entityType: 'encounter', folder: 'Encounters', html }]);

  const summary = `${lines.length} actors${tokens.length ? `, ${tokens.length} tokens on “${scene.name}”` : ''}${combat ? ', combat created' : ''}${
    placeholders.length ? ` (${placeholders.length} placeholders)` : ''
  }`;
  ui.notifications.info(`Prep Hub: encounter “${payload.name}” ready — ${summary}.`);
  return { summary, actors: lines.length, tokens: tokens.length, placeholders, combat: Boolean(combat) };
}

let itemIndexCache = null;

/** Item uuid by name, for loot that came without one. */
async function itemByName(name) {
  if (!itemIndexCache) {
    itemIndexCache = new Map();
    for (const pack of game.packs.filter((p) => p.documentName === 'Item')) {
      const index = await pack.getIndex().catch(() => []);
      for (const entry of index) {
        const key = normalizeName(entry.name);
        if (!itemIndexCache.has(key)) itemIndexCache.set(key, entry.uuid ?? `Compendium.${pack.collection}.Item.${entry._id}`);
      }
    }
  }
  const uuid = itemIndexCache.get(normalizeName(name));
  return uuid ? resolveUuid(uuid).catch(() => null) : null;
}

/** Treasure rolled in Prep Hub, as a Loot actor in "Prep Hub / Loot" (or a journal if loot actors aren't available). */
async function importLoot(payload) {
  const lines = Array.isArray(payload?.items) ? payload.items : [];
  const docs = [];
  const missing = [];
  for (const line of lines) {
    const doc = (line.uuid ? await resolveUuid(line.uuid).catch(() => null) : null) ?? (await itemByName(line.name));
    if (!doc || doc.documentName !== 'Item') {
      missing.push(line.name);
      continue;
    }
    const data = doc.toObject();
    delete data._id;
    if (data.system && Number(line.qty) > 1) data.system.quantity = Number(line.qty);
    docs.push(data);
  }
  const root = await ensureFolder(ROOT_FOLDER, 'Actor');
  const folder = await ensureFolder('Loot', 'Actor', root);
  const name = payload.name || 'Treasure';
  let actor = null;
  try {
    actor = await docClass('Actor').create({ name, type: 'loot', folder: folder.id, flags: { [MODULE_ID]: { imported: true, loot: true } } });
  } catch (err) {
    log('Loot actors are not available; writing a journal instead', err);
  }
  let summary;
  if (actor) {
    if (docs.length) await actor.createEmbeddedDocuments('Item', docs);
    let coins = '';
    if (payload.coins && Object.values(payload.coins).some((v) => Number(v) > 0) && typeof actor.inventory?.addCoins === 'function') {
      try {
        await actor.inventory.addCoins(payload.coins);
        coins = ' and coins';
      } catch (err) {
        log('Could not add coins', err);
      }
    }
    summary = `loot actor “${name}” with ${docs.length} item${docs.length === 1 ? '' : 's'}${coins}`;
  } else {
    const jroot = await ensureFolder(ROOT_FOLDER, 'JournalEntry');
    const list = docs.map((d) => `<li>${escapeHtml(d.name)}</li>`).join('');
    await docClass('JournalEntry').create({ name, folder: jroot.id, pages: [{ name, type: 'text', text: { content: `<ul>${list}</ul>`, format: HTML_FORMAT() } }] });
    summary = `journal “${name}” listing ${docs.length} items`;
  }
  if (missing.length) summary += ` (not found: ${missing.join(', ')})`;
  ui.notifications.info(`Prep Hub: ${summary}.`);
  return { summary, missing };
}

/** A creature from Prep Hub's creature builder, as an NPC actor in "Prep Hub / Creatures". */
async function importCreature(payload) {
  const block = payload?.statblock;
  if (!block?.name) throw new Error('No stat block in the message');
  const root = await ensureFolder(ROOT_FOLDER, 'Actor');
  const folder = await ensureFolder('Creatures', 'Actor', root);
  const existing = payload.prepHubId ? game.actors.find((a) => a.getFlag(MODULE_ID, 'creatureId') === payload.prepHubId && !a.getFlag(MODULE_ID, 'specKey')) : null;
  const flags = { [MODULE_ID]: { imported: true, creatureId: payload.prepHubId ?? null } };
  const actor = await actorFromStatblock(block, { name: block.name, folder, flags, notesHtml: payload.notesHtml ?? '', existing });
  const summary = `${existing ? 'updated' : 'created'} ${block.name} (level ${block.level})`;
  ui.notifications.info(`Prep Hub: ${summary}.`);
  return { summary, uuid: actor.uuid };
}

const HANDLERS = {
  async journals(payload) {
    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    const { created, updated, journals } = await upsertJournals(entries);
    let summary = `${created} journal entries created, ${updated} updated`;
    // Newly revealed clues can be announced to the table in chat, linking the handout.
    const lines = Array.isArray(payload.announce) ? payload.announce : [];
    if (lines.length) {
      const linkUuid = payload.announceLink ? (journals.get(payload.announceLink) ?? findJournal(payload.announceLink))?.uuid : null;
      const content = announceHtml(lines, linkUuid);
      if (content) {
        await docClass('ChatMessage').create({ content, speaker: { alias: 'Prep Hub' } });
        summary += `, ${lines.length} clue${lines.length === 1 ? '' : 's'} announced in chat`;
      }
    }
    // Other announcements (e.g. a new "Previously on…" recap), linking their journal entry.
    if (payload.announcement?.title) {
      const id = payload.announcement.link;
      const linkUuid = id ? (journals.get(id) ?? findJournal(id))?.uuid : null;
      const content = announcementHtml(payload.announcement, linkUuid);
      if (content) {
        await docClass('ChatMessage').create({ content, speaker: { alias: 'Prep Hub' } });
        summary += ', announced in chat';
      }
    }
    ui.notifications.info(`Prep Hub: ${summary}.`);
    return { summary, created, updated };
  },
  encounter: importEncounter,
  creature: importCreature,
  loot: importLoot,
  'request-party': (_payload, bridge) => bridge.syncParty(),
  'request-bestiary': (_payload, bridge) => bridge.syncBestiary(),
  'request-items': (_payload, bridge) => bridge.syncItems(),
  async ping() {
    ui.notifications.info('Prep Hub says hello! The bridge is working.');
    return { summary: 'pong' };
  },
};

// ---------------------------------------------------------------------------
// UI panel
// ---------------------------------------------------------------------------

const bridge = new PrepHubBridge();

const STATUS_TEXT = {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  error: 'Error',
  'no-key': 'Needs bridge key',
};

class PrepHubPanel extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    classes: ['prep-hub-panel'],
    window: { title: 'Prep Hub Bridge', icon: 'fas fa-book-open', resizable: true },
    position: { width: 440, height: 'auto' },
    actions: {
      save: PrepHubPanel.#onSave,
      connect: PrepHubPanel.#onConnect,
      disconnect: PrepHubPanel.#onDisconnect,
      syncParty: PrepHubPanel.#onSyncParty,
      syncBestiary: PrepHubPanel.#onSyncBestiary,
      syncItems: PrepHubPanel.#onSyncItems,
      openApp: PrepHubPanel.#onOpenApp,
    },
  };

  #unsubscribe = null;

  async _renderHTML() {
    const el = document.createElement('div');
    el.className = 'prep-hub-body';
    const activity = bridge.activity
      .slice(0, 8)
      .map(
        (a) =>
          `<li class="${a.ok ? 'ok' : 'fail'}"><span>${new Date(a.at).toLocaleTimeString()}</span> <strong>${escapeHtml(a.label)}</strong> ${escapeHtml(a.detail)}</li>`,
      )
      .join('');
    el.innerHTML = `
      <p class="status status-${bridge.status}"><i class="fas fa-circle"></i> ${STATUS_TEXT[bridge.status] ?? bridge.status}
        ${bridge.campaign && bridge.status === 'connected' ? ` · campaign <strong>${escapeHtml(bridge.campaign.name)}</strong>` : ''}</p>
      ${bridge.statusDetail ? `<p class="detail">${escapeHtml(bridge.statusDetail)}</p>` : ''}
      <label>Prep Hub URL <input type="text" name="serverUrl" value="${escapeHtml(bridge.url)}" /></label>
      <label>Bridge key <input type="password" name="bridgeKey" value="${escapeHtml(bridge.key)}" placeholder="Copy from Prep Hub → Foundry" /></label>
      <div class="buttons">
        <button type="button" data-action="save"><i class="fas fa-floppy-disk"></i> Save &amp; connect</button>
        ${
          bridge.status === 'connected' || bridge.status === 'reconnecting'
            ? '<button type="button" data-action="disconnect"><i class="fas fa-plug-circle-xmark"></i> Disconnect</button>'
            : '<button type="button" data-action="connect"><i class="fas fa-plug"></i> Connect</button>'
        }
      </div>
      <div class="buttons">
        <button type="button" data-action="syncParty"><i class="fas fa-users"></i> Send party</button>
        <button type="button" data-action="syncBestiary"><i class="fas fa-dragon"></i> Send bestiary</button>
        <button type="button" data-action="syncItems"><i class="fas fa-gem"></i> Send items</button>
        <button type="button" data-action="openApp"><i class="fas fa-up-right-from-square"></i> Open Prep Hub</button>
      </div>
      <h3>Recent activity</h3>
      <ul class="activity">${activity || '<li class="empty">Nothing yet.</li>'}</ul>`;
    return el;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
  }

  _onFirstRender(...args) {
    super._onFirstRender?.(...args);
    this.#unsubscribe = bridge.onChange(() => this.render());
  }

  _onClose(...args) {
    super._onClose?.(...args);
    this.#unsubscribe?.();
  }

  static async #onSave() {
    const url = this.element.querySelector('[name=serverUrl]').value.trim();
    const key = this.element.querySelector('[name=bridgeKey]').value.trim();
    await game.settings.set(MODULE_ID, 'serverUrl', url || 'http://localhost:4100');
    await game.settings.set(MODULE_ID, 'bridgeKey', key);
    await bridge.connect();
  }

  static async #onConnect() {
    await bridge.connect();
  }

  static #onDisconnect() {
    bridge.disconnect();
  }

  static async #onSyncParty() {
    await bridge.syncParty().catch(() => {});
  }

  static async #onSyncBestiary() {
    await bridge.syncBestiary().catch(() => {});
  }

  static async #onSyncItems() {
    await bridge.syncItems().catch(() => {});
  }

  static #onOpenApp() {
    window.open(bridge.url, '_blank', 'noopener');
  }
}

function openPanel() {
  return new PrepHubPanel().render({ force: true });
}

function addDirectoryButton(app, html) {
  if (!game.user.isGM) return;
  const root = (html instanceof HTMLElement ? html : html?.[0]) ?? app?.element;
  const actions = root?.querySelector('.header-actions') ?? root?.querySelector('.directory-header');
  if (!actions || actions.querySelector('.prep-hub-open')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'prep-hub-open';
  button.innerHTML = '<i class="fas fa-book-open"></i> Prep Hub';
  button.addEventListener('click', () => openPanel());
  actions.append(button);
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

Hooks.once('init', () => {
  game.settings.register(MODULE_ID, 'serverUrl', {
    name: 'PREPHUB.Settings.ServerUrl.Name',
    hint: 'PREPHUB.Settings.ServerUrl.Hint',
    scope: 'client',
    config: true,
    type: String,
    default: 'http://localhost:4100',
  });
  game.settings.register(MODULE_ID, 'bridgeKey', {
    name: 'PREPHUB.Settings.BridgeKey.Name',
    hint: 'PREPHUB.Settings.BridgeKey.Hint',
    scope: 'client',
    config: true,
    type: String,
    default: '',
  });
  game.settings.register(MODULE_ID, 'autoConnect', {
    name: 'PREPHUB.Settings.AutoConnect.Name',
    hint: 'PREPHUB.Settings.AutoConnect.Hint',
    scope: 'client',
    config: true,
    type: Boolean,
    default: true,
  });
  game.settings.register(MODULE_ID, 'autoSyncParty', {
    name: 'PREPHUB.Settings.AutoSyncParty.Name',
    hint: 'PREPHUB.Settings.AutoSyncParty.Hint',
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  });
  game.settings.registerMenu(MODULE_ID, 'panel', {
    name: 'PREPHUB.Menu.Name',
    label: 'PREPHUB.Menu.Label',
    hint: 'PREPHUB.Menu.Hint',
    icon: 'fas fa-book-open',
    type: PrepHubPanel,
    restricted: true,
  });
});

Hooks.once('ready', () => {
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = { bridge, openPanel };
  if (!game.user.isGM) return;
  // Only the active GM talks to Prep Hub so nothing gets imported twice.
  const activeGM = game.users.activeGM;
  if (activeGM && !activeGM.isSelf) return;
  if (setting('autoConnect')) bridge.connect({ quiet: true });
});

Hooks.on('renderActorDirectory', addDirectoryButton);
Hooks.on('renderJournalDirectory', addDirectoryButton);
