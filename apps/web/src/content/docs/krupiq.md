---
title: Krupiq
description: "Cybersecurity and compliance: how Krupiq lays a living decoy over your real network and proves what it did."
section: products
order: 2
tour: krupiq
updated: 2026-10-14
---

## The idea

Krupiq lays a living decoy over your network. An intruder who gets in sees a network that looks like yours, and it changes shape before they can map it. Your data stays where it is. The attacker spends their night somewhere that does not exist.

## Why a decoy

Most of an intrusion is reconnaissance. Before anyone steals anything they have to find out what is there: which machines exist, which ports answer, which accounts matter. That work takes time, and it makes noise. A decoy turns both against the intruder.

Time, because every hour spent mapping the decoy is an hour not spent on your real systems. Noise, because nobody who belongs on your network has any reason to touch the decoy, so a single packet into it is a high-confidence signal rather than one alert among thousands.

## Living, not static

Honeypots are old. What makes Krupiq different is that the decoy is alive. It is shaped to look like your network, not like a generic one, and it keeps changing: the map an intruder drew an hour ago is wrong now. A static decoy is mapped once and avoided for ever. A living one cannot be learned.

## Where it sits

Krupiq overlays the network you already have. It is a separate thing that only an intruder would ever see, and your real data and your real services stay exactly where they are.

## What it is not

Krupiq is not a firewall and it is not an intrusion detection system that inspects your real traffic. It does not replace either. It adds a layer those tools do not have: a place for intruders to go that tells you they are there.

## Cybersecurity and compliance

Krupiq is a compliance tool that takes care of cybersecurity. Four things make that true:

- Observe. Every packet the intruder sends is seen, from the first one. Nobody who belongs on your network touches the decoy, so there is no noise to filter.
- Morph. Every five minutes the decoy takes a new shape. It looks like your network and contains nothing real.
- Prove. Every change carries a signed proof, which can be checked offline, that the decoy was drawn exactly as published.
- Comply. GDPR, NIS2, DORA and SEC duties are met by how it is built. A full audit of what was watched, what was touched and what was proved takes minutes and comes out as an immutable PDF.

Krupiq runs on Windows, Linux and macOS, on your own machines. Nothing leaves your network.

## A being for security

Krupiq is the security sibling of Emily Wilson. The same lineage of code that lets Emily see a dashboard and remember a procedure lets Krupiq see a network and remember an intruder's behaviour. Where Emily guides your people, Krupiq watches the people who should not be there.

## Learn more

Krupiq has its own site at [krupiq.com](https://krupiq.com), with the product detail, early access and the security contact. For a conversation about deploying it alongside Emily, email 4d@emersa.io.
