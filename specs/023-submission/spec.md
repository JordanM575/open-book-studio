# Hackathon submission package

**Status:** In progress (2026-10-26)
**Number:** 023
**Depends on:** [021](../021-product-film/spec.md) film, [019](../019-illustrations/spec.md),
[017](../017-voice-and-background/spec.md),
[018](../018-agent-toolkit/spec.md), [022](../022-provider-compatibility/spec.md).

## Why

The product is not the submission. The submission is a public repository, a sample library a judge can
open, a three-minute film, a live demo that survives a bad network, and a short statement that makes the
event-built work unmistakable. Everything needed to produce that packet should be in the repository, not
in a last-minute document on someone's desktop.

## Deliverables

| Artefact | Requirement |
| --- | --- |
| Public repository | Apache-2.0, `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md`; no secrets or author data |
| README | Problem, product, architecture, Meta models, setup, tests, and what was built during the event |
| Sample library | `samples/the-salt-road` opens in the app with original text, Story Bible, two chapters, an illustration and an imported synthetic character figure |
| Film | 3:00 master, 0:30 cut, 0:15 vertical, SRT and a public link |
| Submission form | Indie Developer track, Build for Your World, solo, repository and video links |
| Live demo | A fixture-only runbook with a recorded fallback if the provider is unavailable |
| Disclosure | What existed before 2026-10-26 and what was built during the event |

## Requirements

- **FR-001** The submission MUST use the **Indie Developer** track and **Build for Your World**, solo.
- **FR-002** The repository MUST be public at submission and contain no provider key, credential file,
  private library, personal path, email or author manuscript.
- **FR-003** `LICENSE`, `NOTICE` and `THIRD_PARTY_NOTICES.md` MUST be present and cover the shipped
  dependencies. D-158 retired the Spec 020 cutout feature and its SAM dependency. [Decision record](../../docs/DECISIONS.md)
- **FR-004** The README MUST state the problem, the product, the architecture, the Meta models used,
  how to install and run, how to run the tests, and a dated list of event-built features.
- **FR-005** `samples/the-salt-road` MUST be original, open, complete and openable without an account.
  Its images and manifest are part of the sample, not generated at submission time.
- **FR-006** The film MUST have a public or judge-accessible link, a 3:00 master, a 0:30 cut, captions
  and a thumbnail. The link MUST be checked in a private window.
- **FR-007** The submission form MUST name the Representative (the solo entrant), the track, the theme,
  the repository and the video. It MUST be submitted before **November 4, 9:00 PM ET**.
- **FR-008** A secret/author-data scan MUST pass before the repository is made public. A failed scan
  blocks publication; it is not waived for the deadline.
- **FR-009** A clean clone of the submitted revision MUST run `bun install`, `bun run verify` and
  `bun run smoke` on the submitter's machine. The exact commit and test count are recorded.
- **FR-010** The live demo MUST use the fixture library and a throwaway profile. If the network or a
  provider fails, the recorded film and a local writing path are the fallback; the app must remain usable.
- **FR-011** The submission packet MUST identify which features were built during the event and which
  existed before it. The commit history and the disclosure are the evidence.
- **FR-012** No new product feature is required after the feature freeze. The last days are for the
  packet, the film, the sample and the checks.

## Non-goals

- A hosted demo, account, or shared library.
- A separate submission-only codebase or a rewritten history.
- A public GitHub PR or a new GitHub repository in this task; the GitHub mirror is a separate decision.
- Last-minute features that are not in the demo script.

## Acceptance scenarios

1. **Open the sample.** A judge opens `samples/the-salt-road` in the desktop app; the book, cast,
  chapters, illustration and character figure are present, with no author data.
2. **Clean clone.** A fresh clone of the submitted commit installs and passes the documented verify and
   smoke commands.
3. **Public scan.** The secret and author-data scan finds no credential, `.env`, personal path or
   real-library fixture in the tracked tree or history.
4. **Form.** The form links a public repository and a working video, names the Indie track and the
   solo entrant, and is submitted before the deadline.
5. **Offline demo.** With the network disabled, the app opens the sample, edits and saves a chapter, and
   the film plays as the fallback for model features.

## Open decisions

- **D-140** Repository visibility: public at submission, private before the scan. Accepted by author
  direction; the public switch happens only after the scan.
- **D-141** Demo fallback: the recorded film plus a local edit/save is acceptable if a live provider is
  unavailable. The demo never fakes a provider response.
