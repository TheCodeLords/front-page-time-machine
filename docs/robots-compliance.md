# robots.txt compliance record

Fetched 2026-08-17, one file per outlet, stored verbatim under [`docs/robots/`](robots/). PLAN.md
required this check before the first capture; it was actually performed after the first day of
captures — recorded here rather than papered over. Nothing found below invalidates any capture
already taken, but the check should have come first.

## What we fetch, and how

We request exactly one path per outlet — the homepage `/` (or the pinned edition front page) — at
most hourly, through Bright Data's infrastructure. We do not crawl: no link following, no article
fetches, no search endpoints, no APIs. The stored record per story is placement metadata — headline
(verbatim), URL, section, rank — not article bodies.

## Per-outlet reading (rules for `User-agent: *` unless noted)

| Outlet     | Homepage `/` allowed? | Disallows that could matter to us                  | Notes                                                                    |
| ---------- | --------------------- | -------------------------------------------------- | ------------------------------------------------------------------------ |
| NPR        | yes                   | none touch `/`                                     | blocks GPTBot/CCBot/ChatGPT-User by name                                 |
| BBC        | yes                   | none touch `/news`                                 | blocks Amazonbot, CCBot, magpie-crawler by name                          |
| CNN        | yes                   | none touch `/` (blocks `/ads/`, `/api/`, `*.jsx`)  | long list of named AI crawlers                                           |
| Fox News   | yes                   | none touch `/` (search, wires, printer pages only) | shortest file of the six                                                 |
| Al Jazeera | yes                   | none touch `/` (search, tracking-param URLs)       | blocks anthropic-ai, ClaudeBot, ChatGPT-User by name; T&C header — below |
| Guardian   | yes                   | none touch `/international`                        | T&C header re LLM/ML training — below                                    |

Two implications we accept and design around:

**Tracking-parameter URLs are disallowed by Al Jazeera** (`/*?fbclid=`, `/*?traffic_source=` …).
We never fetch article URLs at all, and `normalizeArticleUrl` strips exactly these parameters from
stored identities — so nothing we store points at a disallowed variant.

**Al Jazeera and the Guardian both carry robots.txt headers restricting use of their content for
AI/ML model development,** and several outlets block named AI-training crawlers. This project is not
that: no model is trained on this data, article bodies are never collected, and headlines are stored
verbatim as short factual quotations with timestamps — an archive of what was published where and
when, the same category of record as the Internet Archive's front-page snapshots. We record the
restriction here so the judgement is visible rather than silent. Al Jazeera's terms also describe
content as available for personal, non-commercial use — a hackathon research submission is
consistent with that; a commercial deployment would need a rights review per outlet.

## Re-checking

`docs/robots/*.txt` are point-in-time copies. Re-fetch before scaling the outlet list or extending
the capture window beyond the hackathon:

```bash
for o in npr bbc cnn foxnews aljazeera guardian; do curl -s https://.../robots.txt -o docs/robots/$o.txt; done
```
