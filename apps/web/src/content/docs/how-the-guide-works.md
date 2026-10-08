---
title: How the guide works
description: "The scripted tour behind the home page: stops, captions, voice clips, reduced motion and what loads when."
section: beings
order: 2
tour: welcome
updated: 2026-10-07
---

## A tour, not a conversation

The guide on the home page is Emily Wilson, rendered as the structure beneath the skin. In this first phase she follows a script. There is no microphone, no language model, and nothing is sent to a server when she speaks. "Talk to Emily" is planned for the next phase, with its own consent step.

The tour has nine stops. Each stop is a small text file in the site's source with four things: where on the page to scroll, a line of at most forty words, what to highlight while the line plays, and how long to pause afterwards. Some stops add a gesture: a nod, a smile, a point to the left or to the right.

The technology stop, for example, is written as `id: technology`, `anchor: "#technology"` and `dwellMs: 700`, with the line
"Watch my face while I talk. Every triangle moves with the sound." as its `text`, `#technology` as its `highlight`, and
one action, `emote: think`.

The site serves the whole script as one file at `/tour/script.json`, and the guide reads it when the tour starts.

## Voice and captions

Emily's voice is AI-generated, and the page says so next to her. Her lines are recorded ahead of time rather than generated while you wait: each stop has a short audio clip and a timeline of mouth shapes, so the triangles of her face move with every sound. The clips are small, and only the current stop and the next one are fetched.

Captions always mirror speech. The words appear as she says them, in a caption bubble that screen readers announce without interrupting. Muting keeps the captions and the lip movement and silences only the audio. If the clips cannot be loaded, the tour continues with captions alone and says so.

## Controls

Start the tour from the hero, then use Next, Back, Replay and Mute. The keyboard works too. Progress is kept in your browser under `em-tour`, so a page reload or a return visit picks up where you left off. Any page can send you to a particular stop with `/?tour=<stop>`; the docs pages use it for "Take the tour from here".

## Reduced motion

If your system asks for reduced motion, the site listens. The page moves between stops without animation, and you advance with a tap or a key instead of a timer. The 3D being is replaced by a still poster, and nothing on the page animates. The tour then runs with captions only: the voice plays with the 3D guide, and a line under the controls says so.

## Without JavaScript or WebGL

Every page works without JavaScript: the content, the navigation and the contact form. The tour is then a set of captions you can read in order. Without WebGL, the being is a poster and the tour runs with captions only.

## What loads when

The order is chosen so that the headline paints first and nothing heavy gets in its way.

1. The page, its styles and two fonts. A tiny script sets your theme before the first paint.
2. A small site script of a few kilobytes. No request to the site's API is made at this point.
3. On a desktop with a mouse, the 3D runtime loads after the headline has painted and the browser is idle. On a phone, it loads only when you tap "Start the tour", so your data plan is not spent on a being you did not ask for.
4. Voice clips, one stop at a time.

If the frame rate drops, the being steps down through simpler looks rather than stuttering.
