/**
 * The overlay's styles, shipped with the binding rather than with the app.
 *
 * The DOM overlay is the primary UI layer and the accessibility surface, because canvas content
 * is invisible to screen readers. Keeping its styles next to the code that positions its nodes
 * means the caps, the offsets and the appearance cannot drift apart across packages.
 *
 * Exported as a string so a host can inject it once; nothing here reads or writes the document.
 */
export const ATLAS_OVERLAY_CSS = `
.atlas-stage { position: relative; width: 100%; height: 100%; overflow: hidden;
  background: #0b0d12; color: #e6ecf5;
  font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
.atlas-stage canvas { display: block; width: 100%; height: 100%; }

.atlas-overlay { position: absolute; inset: 0; pointer-events: none; }
.atlas-leaders { position: absolute; inset: 0; }
.atlas-leaders .leader { stroke: #8fb4e8; stroke-width: 1; stroke-opacity: 0; }

/* Exactly one focus label exists. Offset to the lower right so it never occludes the centre. */
.atlas-focus-label { position: absolute; top: 0; left: 0; display: none;
  max-width: 300px; padding: 8px 11px; border-radius: 8px;
  background: rgba(11,13,18,0.86); border: 1px solid rgba(150,175,215,0.28);
  backdrop-filter: blur(6px); }
.atlas-focus-label.visible { display: block; }
.atlas-focus-label .name { display: block; font-weight: 600; letter-spacing: 0.01em; }
.atlas-focus-label .verb { display: block; margin-top: 3px; font-size: 11.5px;
  color: rgba(200,214,235,0.6); }

.atlas-callout { position: absolute; top: 0; left: 0; display: none;
  padding: 5px 9px; border-radius: 7px; font-size: 12.5px;
  background: rgba(11,13,18,0.78); border: 1px solid rgba(150,175,215,0.2); }
.atlas-callout.visible { display: block; }
.atlas-callout .name { margin-right: 7px; }

/* Four provenance classes are four different things and must be visually distinguishable
   wherever they appear. Colour AND shape, because colour alone is not an accessible channel. */
.chip { display: inline-block; margin-top: 3px; padding: 1px 7px; border-radius: 999px;
  font-size: 11px; letter-spacing: 0.02em; border: 1px solid currentColor; }
.chip.prov-capture   { color: #b9c6d8; border-style: solid; }
.chip.prov-user      { color: #f0c98a; border-style: double; border-width: 3px; }
.chip.prov-inference { color: #8fb4e8; border-style: dashed; }
.chip.prov-external  { color: #9fdcb4; border-style: dotted; }
/* An unconfirmed candidate must LOOK unconfirmed in the overlay too, not only in the cloud. */
.chip.unconfirmed    { opacity: 0.72; }

.atlas-chevron { position: absolute; top: 0; left: 0; display: none;
  margin: -9px 0 0 -7px; font-size: 15px; color: #8fb4e8; opacity: 0.75; }
.atlas-chevron.visible { display: block; }

.atlas-overflow { position: absolute; right: 18px; bottom: 18px; display: none;
  padding: 5px 10px; border-radius: 7px; font-size: 12px; color: rgba(200,214,235,0.75);
  background: rgba(11,13,18,0.7); border: 1px solid rgba(150,175,215,0.2); }
.atlas-overflow.visible { display: block; }

.atlas-reticle { position: absolute; left: 50%; top: 50%; width: 7px; height: 7px;
  margin: -3.5px 0 0 -3.5px; border-radius: 50%; pointer-events: none;
  border: 1px solid rgba(230,236,245,0.8); transition: opacity 120ms linear; }
.atlas-reticle.dimmed { opacity: 0.25; }

/* Meta's locomotion guidance: darken the edges of the screen when movement occurs, to limit the
   amount of visible optic flow. A comfort requirement, so it is not behind a theme. */
.atlas-vignette { position: absolute; inset: 0; pointer-events: none; opacity: 0;
  background: radial-gradient(ellipse at center,
    rgba(0,0,0,0) 42%, rgba(0,0,0,0.55) 82%, rgba(0,0,0,0.85) 100%); }

/* Resume is a real button and never an automatic retry: re-locking needs transient activation. */
.atlas-resume { position: absolute; left: 50%; bottom: 34px; transform: translateX(-50%);
  padding: 9px 15px; border-radius: 999px; cursor: pointer; font: inherit; font-size: 12.5px;
  color: #e6ecf5; background: rgba(18,22,30,0.9);
  border: 1px solid rgba(150,175,215,0.3); }
.atlas-resume.hidden { display: none; }
`;
