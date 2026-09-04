# Companion renderer and customization evaluation

Status: **SVG GEOMETRIC AVATAR ACTIVE; SPLINE AND HUMANOID PROTOTYPE REMOVED**. Updated 2026-08-31
after the supplied Grok Bot reference was identified and the rejected robot was removed.

## 1. Correction

The prior native implementation guessed at the reference and produced a humanoid robot with a
torso, arms, legs, hands, feet, mouth, antenna, and halo. That was not the supplied Grok Bot visual
language. It also placed the character in the PlayCanvas scene, where the composited result could
read as a coloured afterimage over source photography. Both decisions are rejected.

The current Companion is one DOM/SVG silhouette with two slit eyes. It has:

- no humanoid body or mouth;
- no accessories;
- no Spline scene, runtime, fallback query, canvas, or network request;
- no second WebGL renderer and no PlayCanvas character entity;
- pointer-following eyes and a measured blink;
- a three-dot working state;
- a still expression under reduced motion;
- saved shape, colour, and expression choices.

## 2. Verified reference

The supplied crop matches the default Grok Bot avatar system: coloured geometric silhouettes with
two dark slit eyes. The closest reusable open-source reference found is Jérémy Perret's **Bloub**:

- repository: <https://github.com/jeremy-prt/bloub>
- live editor: <https://bloub.vercel.app/>
- license: MIT for its source code;
- catalog: eight shapes, twelve colours, sixteen rest expressions, and fourteen animated states;
- renderer: SVG with no animation library.

Bloub's README explicitly says its MIT license covers the code, not xAI's imitated design. Exulanica
therefore does not copy the project's source or claim xAI affiliation. The local renderer is an
original, smaller implementation of the verified abstract grammar: a configurable silhouette and
two slit eyes. Source comments retain the research attribution.

## 3. Integration decision

Keep the local renderer for the present product scope. It is one 214-line, 8,127-byte TypeScript
module, uses the browser's existing SVG/animation facilities, and adds no package, canvas, network
request, or render loop. The app has no Vue, Mediabunny, Spline, or Bloub dependency.

Bloub is a capable reference application, not a drop-in package: its package is marked private and
the application depends on Vue and Mediabunny. Its reusable `src/bot/` engine is deliberately
framework- and clock-free, so it is a plausible upstream source if Exulanica later needs its measured
14-state morph system. At that point the correct path is a separately reviewed engine adapter with
MIT attribution and a design/licensing review—not embedding the editor application now. The current
requirements are shape, colour, expression, gaze, blink, working feedback, and reduced motion; the
local renderer already supplies those without the extra integration surface.

## 4. Versioned customization contract

`packages/presentation/src/companion-appearance.ts` owns V3:

```text
companionModelVersion: 3
bodyVariant: circle | pebble | squircle | capsule | cloud | droplet
colorVariant: ink | rose | orange | periwinkle | mint
faceVariant: neutral | attentive | curious | happy | sleepy
bodyColor and eyeColor: derived from the catalog
motionProfile: gaze-and-blink
reducedMotionProfile: still-expression
```

Pink circle is the default because that is the selected avatar visible in the supplied reference.
Unknown versions fail closed. V1 and V2 records migrate explicitly to this known V3 default instead
of reinterpreting robot choices as avatar choices.

## 5. Encounter composition

The supplied visual-novel screenshot remains layout authority:

- the active memory is the backdrop;
- the avatar owns upper centre;
- numbered choices remain on the right;
- the dialogue lens spans bottom centre;
- Index, Map, Options, and Controls are circular icon buttons around the dialogue band;
- WASD remains available while answering and the cursor stays free.

Answer cards and the dialogue lens use no drop shadow. The former gold “consequential” outline is
also removed; consequence remains in behavior and copy, not an unexplained decorative glow.

## 6. Separate future humanoid research

VRM remains a credible format if Exulanica later needs a licensed humanoid or anime character:

- VRM specification: <https://vrm-consortium.org/en/>
- MIT authoring candidate: <https://github.com/M3-org/CharacterStudio>
- rejected PlayCanvas adapter: <https://github.com/viverseofficial/playcanvas-vrm> is explicitly
  `UNLICENSED - Internal VIVERSE use only`.

That is a separate asset and licensing decision. It is not evidence for adding a humanoid body to
the current Grok Bot-style reference.
