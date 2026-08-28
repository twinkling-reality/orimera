# Hackathon requirements and submission checklist

Status: VERIFIED against primary sources on 2026-08-27.
Re-verify before submission. Rules pages change.

Primary sources:
- Overview: https://nebiusglobalaihackathon.devpost.com/ (retrieved 2026-08-27)
- Official rules: https://nebiusglobalaihackathon.devpost.com/rules (retrieved 2026-08-27)
- Resources and credits: https://nebiusglobalaihackathon.devpost.com/resources (retrieved 2026-08-27)

## 1. Timeline (VERIFIED)

| Milestone | Date |
| --- | --- |
| Submission period opens | 2026-08-26, 09:00 PT |
| Submission deadline | 2026-10-30, 10:00 PT |
| Judging period | 2026-12-01 to 2026-12-15 |
| Winners announced | 2027-01-11 |

Today is 2026-08-27. Runway to deadline: approximately 64 days.

This is the single most important correction to the working assumptions. The handoff brief reads as
though this were a short sprint. It is not. A 9 week window makes deliberate recapture, remote GPU
reconstruction, real evaluation, and honest iteration feasible. Plans that assume a 48 hour hackathon
are wrong in both directions: they under-scope the achievable product and they over-panic about
reconstruction runtime.

## 2. Eligibility (VERIFIED)

- Open to individuals above the legal age of majority, teams, and organizations.
- Excluded residents: sanctioned countries and certain jurisdictions, listed on the rules page as
  including Brazil, Quebec, Russia, Crimea, Cuba, Iran, and North Korea. Confirm the operator's own
  jurisdiction against the current list before submitting.
- Projects must be "either newly created ... or ... significantly updated after the start of the
  Hackathon Submission Period".

Orimera status: the repository was created 2026-08-27T17:16:26Z, after the submission period opened
on 2026-08-26. The project is newly created inside the window. No pre-existing work disclosure is
required, though the submission will state this plainly.

## 3. Hard platform requirement (VERIFIED)

> "All submissions must run on either Nebius Token Factory or Nebius AI Cloud and use at least one
> NVIDIA open source model."

Both halves are mandatory. Neither is satisfied by intent or by a code path that is never executed.
A truthful runtime call is required, with a verified real model identifier.

## 4. Track selection (VERIFIED)

Four tracks exist. The exact name of the intended track is **"Best Apps and Agents Track"**, not
"Best Apps & Agents" as written in the handoff brief.

> "Build any app or agent someone would actually use, from a productivity tool or copilot to a
> workflow that runs itself."

Track guidance for this track:
> "Power it with Nemotron models on Nebius through Token Factory. Reach for Nemotron 3 Ultra when you
> need serious reasoning, and let Nano or Super handle the fast, everyday calls"
> "Deploy your application with Nebius Serverless Endpoints, or use Nebius Serverless Jobs for
> background processing and asynchronous workflows, though neither is required"

### Track choice is not obvious and is worth revisiting

Orimera also fits the **Personal AI Track**: "Build an always-on, private assistant that works for
you while keeping your data under your control." Orimera is emphatically not always-on, and it is
explicitly forbidden from claiming privacy or local-only processing it does not implement, so
"Best Apps and Agents" remains the honest fit. Recorded here as a considered decision rather than an
unexamined inheritance from the brief. See ADR-0001.

## 5. Prize structure and the award-stacking rule (VERIFIED)

| Award | Prize | Winners |
| --- | --- | --- |
| Grand Prize | $20,000 cash | 1 |
| 2nd Place | $10,000 cash | 1 |
| 3rd Place | $6,000 cash | 1 |
| Best Apps and Agents Track Winner | NVIDIA Jetson Orin Nano | 1 |
| Coding and Agentic Engineering Track Winner | NVIDIA Jetson Orin Nano | 1 |
| Personal AI Track Winner | NVIDIA Jetson Orin Nano | 1 |
| Physical AI Track Winner | NVIDIA Jetson Orin Nano | 1 |
| Best Use of Tavily | $3,000 cash | 1 |
| City Winner Award | $500 cash | 20 |
| Most Valuable Feedback | $100 cash plus NVIDIA swag | 10 |

Critical constraint, quoted from the rules:
> "Each Project is eligible for one Overall Award OR one Track Award and one Bonus Award."

Consequence: the Tavily bonus stacks with a Track Award but not with an Overall Award. This does not
change the build, because the brief already scopes Tavily to a narrow, genuinely useful past to
present layer. It does mean the Tavily integration must be real and substantial rather than
decorative, since it is worth more than the track award it stacks with.

## 6. Required deliverables (VERIFIED)

- [ ] Working project built with NVIDIA Nemotron or another NVIDIA open source model, running on
      Nebius Token Factory or Nebius AI Cloud.
- [ ] Track selected: Best Apps and Agents.
- [ ] Project description covering what was created, why, and how it works.
- [ ] URL to a working demo, hosted application, or test build.
- [ ] Public YouTube video, 3 minutes or shorter, showing the project working, with audio covering
      how Nebius Token Factory and NVIDIA Nemotron were used.
- [ ] Publicly accessible code repository (GitHub, GitLab, or Bitbucket).
- [ ] Open source license file in the repository, "such as Apache 2.0, MIT, or MPL 2.0".
- [ ] License visible in the repository About section.
- [ ] README with setup instructions and clear guidance for running the project.
- [ ] Documentation highlighting NVIDIA model use, where Token Factory accelerated the workflow, and
      any other Nebius tools or services used.
- [ ] Feedback on Nebius Token Factory, Nebius AI Cloud, and NVIDIA tools, models, and technologies.
- [ ] Pre-existing work explanation. Not applicable, but state so explicitly.
- [ ] City event attribution if an in person Builders and Brews event is attended.

Already satisfied:
- Repository is public at https://github.com/twinkling-reality/orimera.
- Apache-2.0 LICENSE is present at the top level and GitHub already reports
  `licenseInfo: apache-2.0`, which populates the About section automatically.

## 7. Judging criteria (VERIFIED, equally weighted)

1. **Technological Implementation.** "How well is the project built, and how effectively does it use
   Nebius Token Factory or AI Cloud model(s), and NVIDIA Nemotron as part of the solution?"
2. **Design.** "Does the project deliver a complete, coherent product experience not just a technical
   proof of concept?"
3. **Potential Impact.** "Does the project make a credible, specific case for solving a real problem
   for a real audience and does the solution actually address it based on what's demonstrated?"
4. **Quality of the Idea.** "Is this a creative, non-obvious use of Nebius Token Factory or AI
   Cloud model(s), and NVIDIA Nemotron and does the team show genuine understanding of the problem
   space?"

Design and Potential Impact together are half the score. That is direct support for the brief's
insistence that the Atlas, the Companion, and the evidence spine matter more than model count.
"based on what's demonstrated" means the 3 minute video, not the ambition in the README.

## 8. Platform access and credits (VERIFIED, and a material constraint)

- $25 Token Factory credits via activation code `NEBIUS-DEVPOST-GLOBAL26` at
  https://nebius.com/promo-code?utm_promo_event_code=2026-devpost-global-ai-hack&utm_promo_code_type=Token_Factory&utm_promo_activation_code=NEBIUS-DEVPOST-GLOBAL26
- A further $25 Token Factory credits by joining the Nebius Builders Program at
  https://dev.nebius.com/builders, which also states free Token Factory, Tavily, and Nebius Academy
  credits.
- In person "Builders and Brews: Hack Edition" attendees "unlock additional Nebius AI Cloud, Token
  Factory, Tavily credits".
- Nebius for AI Builders: https://dev.nebius.com/
- Discord: https://discord.gg/ZdC3rXMJH

**Approximately $50 in Token Factory credits is the confirmed baseline for a remote participant.**
No free Nebius AI Cloud GPU credit allocation is stated anywhere for online participants; GPU credits
are mentioned only in connection with in person events.

This is a real constraint with architectural consequences:
- A multimodal extraction pipeline that pushes many video frames through a large model can exhaust
  $50 quickly. Token spend must be budgeted, measured, and cached per source hash plus pipeline
  version from the first commit, not retrofitted.
- Gaussian splat training needs NVIDIA GPU hours that are probably not free. Either budget real
  money, attend an in person event, or lean harder on the source first fallback ladder.
- Reconstruction is a one time per scene cost for a curated corpus. Three to five scenes reconstructed
  once and cached is bounded and affordable. Reconstructing on demand during judging is not, and is
  also forbidden by the requirement that the hosted demo not depend on a long live GPU job.

**Open:** both credit grants are redeemed and the actual balances recorded, so the budget stops
being an estimate. A Token Factory balance of $25.00 is confirmed from the billing console; see
[runtime-verification.md](runtime-verification.md) section 8.

## 9. Tavily bonus (VERIFIED)

"Best Use of Tavily" is a $3,000 bonus award. No wording on the pages retrieved makes Tavily use
mandatory. The brief's requirement of a real runtime Tavily call remains the standard to hit, since a
mocked call would win nothing and would violate the project's own honesty rules.

## 10. Re-verification schedule

Rules pages change during a 9 week window. Re-fetch all three primary URLs and diff against this
document:
- At architecture freeze.
- Two weeks before the deadline.
- Within 48 hours of submitting.
