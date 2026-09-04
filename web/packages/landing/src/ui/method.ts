/**
 * Method: a person explaining what this is and how it works.
 *
 * Four rewrites got here, and each failure was a different kind. The first used the design
 * documents' vocabulary, which is precise there and impenetrable to a stranger. The second fixed
 * the vocabulary and kept the packaging: eyebrow, "in four steps", numbered cards. The third
 * dropped the packaging and mistook plain for vague, opening on "Exulanica turns your photographs
 * into places", a metaphor with no mechanism and nothing a reader could check. The fourth put the
 * real numbers back and read like a specification being recited at somebody.
 *
 * The register this needs is a person who built the thing telling you what it does and where it
 * stops. That means first person, because there is a builder and pretending otherwise is what
 * produces the passive institutional voice that reads as generated. It means the reasoning goes
 * with the number rather than after it. And it means saying the awkward parts in the same voice as
 * the good parts, because a page that changes register when it gets to the limitations has told
 * you which half it believes.
 *
 * Every figure quoted is from product-specification.md sections 5 and 11 or from README.md. None
 * was written for effect. Constraints unchanged: no on-device claim, nothing about voices, no
 * completion metric, and the words immutable, WORM and tamper-proof do not appear.
 */

import { el } from './dom.js';
import { LADDER_FIGURE } from './ladder-figure.js';

function para(...children: readonly (Node | string)[]): HTMLElement {
  return el('p', { class: 'prose' }, children);
}

function heading(text: string): HTMLElement {
  return el('h2', { class: 'prose-head', text });
}

/** The one figure. Its caption carries provenance, not a restatement of the paragraph above. */
function figure(svg: string, caption: string): HTMLElement {
  const wrap = el('figure', { class: 'figure-block' });
  const art = el('div', { class: 'figure-art', 'aria-hidden': 'true' });
  art.innerHTML = svg;
  wrap.append(art, el('figcaption', { class: 'figure-caption', text: caption }));
  return wrap;
}

export function buildMethod(): HTMLElement {
  const root = el('section', {
    id: 'method',
    class: 'pane pane-method',
    tabindex: '-1',
    'aria-labelledby': 'method-title',
  });
  const inner = el('article', { class: 'prose-column' });

  inner.append(
    el('h1', { class: 'sr-only', id: 'method-title', text: 'Method' }),
    para(
      'I wanted to be able to walk back into a moment I had photographs of, and ask a question about it, and get an answer I could check. Not a folder, not a slideshow, and not a chatbot with confident opinions about my own life.',
    ),
    para(
      'So Exulanica takes a set of photographs, recovers the geometry the camera saw, and puts that geometry into one continuous space next to every other capture you have given it. Then it holds one rule everywhere: an answer about your past cites the photograph it came from, never the reconstruction.',
    ),
    para(
      'That rule is doing more work than it looks like. It means a region built from four blurry photographs answers a question exactly as reliably as one built from four hundred good ones, because in neither case is the geometry what the answer rests on. Reconstruction quality never touches whether an answer is true.',
    ),

    heading('Why it will never tell you who someone is'),
    para(
      'This is the part I expected to build and then could not, and I would rather explain it than quietly leave it out.',
    ),
    para(
      'Recognising a face across two photographs sounds solved. It is solved in the easy version, where you already know everybody who could be in the picture. The version this product needs is the open one, where the answer might be somebody it has never seen, and there the published numbers are about 60% identification at a false accept rate of 0.01.',
    ),
    para(
      'Matching people by appearance instead does not rescue it. osnet_x1_0 gets 94.2% rank-1 inside the dataset it was tuned on and 52.4% moving from Market1501 to DukeMTMC. And the case I actually care about, the same person years apart in different clothes, is the hardest one: 56 to 58% rank-1 on LTCC.',
    ),
    para(
      'A system that names people correctly slightly more often than a coin flip should not be naming people. So it does not. It will tell you it thinks two photographs might be the same person, and it will use that hunch to arrange things and light things up, but the hunch cannot appear in a sentence until you say yes. The name comes from you or it does not exist.',
    ),
    para(
      'I also have not measured how often Exulanica gets that hunch right, so there is no accuracy number for it anywhere: not here, not in the demo, not in the documentation. When I measure it, it goes on this page whatever it says.',
    ),

    heading('Why some places let you walk around and others do not'),
    para(
      'Reconstruction from an ordinary photo library mostly half works. Holiday photographs are not a scan; they are twelve pictures of a person standing in front of something, and no amount of engineering turns that into a room.',
    ),
    para(
      'Rather than dressing up whatever came out, there are four outcomes and each place gets the one it earned. A full walkable reconstruction needs about 80% of the images to register into a single model, plus low reprojection error and real camera movement. Below that, a path is fitted through the route the camera actually travelled, so you move along the way you walked with real parallax and the unobserved sides fade out instead of being invented. Below that, each photograph becomes a panel with real depth in it, which always works, because depth from a single image is defined for every image. And at the floor, the photographs are laid out by time and by what they have in common, with no geometry at all.',
    ),
    para(
      'The floor is built first and has to be finished before the top is attempted. It is the only one of the four that never fails.',
    ),

    figure(
      LADDER_FIGURE,
      'One synthetic capture at three of those four densities, generated by this project’s own scene synthesizer rather than drawn. The bite out of the facade is not styling: it is where the camera had no line of sight, and the generator leaves it empty rather than filling it in. Just over 40% of the frame carries no geometry at all.',
    ),

    para(
      'Every place says which of the four it is. A region that tells you "this is the path I walked, and I cannot show you the other side of the room" is worth more than one quietly presenting a mess as a room, and it is the difference between a limitation and a bug.',
    ),

    heading('What you see while it is working'),
    para(
      'While a capture is processing you watch it form in the spot it is going to occupy, and each state is labelled with the stage that is actually running and the count that is actually known. No invented percentage, and no estimated time remaining, because nothing in the pipeline reports one. If the only honest thing to show is how many photographs have been decoded so far, that is what it shows.',
    ),

    heading('What I have to be careful how I say'),
    para(
      'Originals are kept and never overwritten. I would like to call that immutable, and I cannot: the object storage this runs on has neither Object Lock nor Legal Hold, so what actually protects your files is bucket versioning, content-addressed keys, and a policy denying delete to the service account. That is a configuration, and a configuration is a promise someone could change. It is append-only by policy, and the stronger words are not used anywhere in this product because they would not be true.',
    ),
    para(
      'Your photographs are also sent to third party cloud services to be processed. Nothing here runs on your device, nothing is anonymous, and I do not inherit any certification from the companies doing the processing.',
    ),

    heading('What it will never do'),
    para(
      'There is no progress ring, no streak, and no count of what is left to sort out. The number of things Exulanica is unsure about is allowed to sit there, unchanged, forever. Every product built around a photo library eventually starts nagging, and the reason is that finishing is easy to measure and remembering is not. A memory is not a task and this will not keep score of one.',
    ),

    el('p', { class: 'prose prose-foot' }, [
      'Every number above comes from the ',
      el('a', {
        class: 'inline-link',
        href: 'https://github.com/twinkling-reality/exulanica/tree/main/docs',
        rel: 'noreferrer',
        text: 'specification',
      }),
      ', which carries the primary source and retrieval date for each one, and a list of everything still unmeasured.',
    ]),
  );

  root.append(inner);
  return root;
}
