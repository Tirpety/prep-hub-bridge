# Prep Hub Bridge (PF2e & SF2e)

A Foundry VTT module that connects your Pathfinder 2e or Starfinder 2e world to **Prep Hub**, a campaign
prep, notes and encounter-building app that runs on the GM's computer.

- **Prep Hub → Foundry:** send encounters (actors from your compendiums, hidden tokens, an optional combat
  and an encounter journal) and Codex entries or sessions as journal entries with GM-only secret sections.
- **Player handouts:** a player-readable *What We Know* journal that updates as the GM reveals clues (optionally
  announced in chat), and any entry the GM shares, without GM-only fields or secrets. Needs Prep Hub 0.4.0 or newer.
- **"Previously on…" recaps:** session recaps the GM shares become player handouts and are announced in chat
  with a short excerpt and a link. Needs Prep Hub 0.7.1 or newer.
- **Creatures, loot and items:** creatures from Prep Hub's creature builder become NPC actors, rolled treasure
  becomes a Loot actor, and *Send items* indexes your item compendiums for Prep Hub's real loot. Needs Prep Hub
  0.8.0 or newer.
- **Foundry → Prep Hub:** send your party and index every NPC and hazard in your compendiums for the
  encounter builder.

Requires Foundry VTT v12, v13 or v14 with the `pf2e` or `sf2e` system, and Prep Hub running on the GM's computer.
Prep Hub keeps a separate bestiary per system, so a sync from a Starfinder world fills the Starfinder bestiary
and leaves your Pathfinder one alone.

## Install

In Foundry's setup screen go to **Add-on Modules → Install Module** and paste this manifest URL:

```
https://github.com/Tirpety/prep-hub-bridge/releases/latest/download/module.json
```

## Connect

1. Enable **Prep Hub Bridge (PF2e)** in your world's module settings.
2. As GM open **Game Settings → Configure Settings → Prep Hub → Open Prep Hub panel** (or the *Prep Hub*
   button in the Actors or Journal sidebar).
3. Paste the **URL** and **bridge key** shown on Prep Hub's **Foundry** page and click *Save & connect*.
4. If your browser asks whether Foundry may access devices on your local network, click **Allow**.

The bridge runs inside the GM's browser and talks to Prep Hub on `http://localhost:4100`, so it also works
with hosted Foundry (The Forge, a server). Use `localhost` or `127.0.0.1` as the URL.

## Legal

This module uses trademarks and/or copyrights owned by Paizo Inc., used under Paizo's Community Use Policy
(paizo.com/licenses/communityuse). We are expressly prohibited from charging you to use or access this
content. This module is not published, endorsed, or specifically approved by Paizo. For more information
about Paizo Inc. and Paizo products, visit paizo.com.
