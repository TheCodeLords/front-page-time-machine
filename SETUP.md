# Front Page Time Machine — Setup State

Hackathon: **Into the Scrape-Verse** (Bright Data × WeMakeDevs), **Aug 17–23, 2026**.
Scraper Studio use is **mandatory for eligibility**.

## Machine facts (checked 2026-08-17)

| Thing             | State                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| Node              | v24.16.0 (CLI needs >=20) — OK                                                                  |
| Docker            | 29.4.3 — OK                                                                                     |
| **Python**        | **BROKEN** — `C:\Program Files\Python312\python.exe` missing. `py`, `python3`, `uv` all absent. |
| git               | 2.54.0                                                                                          |
| `@brightdata/cli` | v0.3.4 installed globally via npm (`brightdata` on PATH)                                        |
| Bright Data auth  | **Live** — admin key, zones `cli_unlocker` + `cli_browser` created, balance **$50.00**          |

Python being broken is why the stack should be **Node/TypeScript**. Both Scraper Studio
boilerplates are cloned, but only the Node one is runnable here.

## Cloned repos (`vendor/`)

| Repo                                                     | Why it's here                                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `cli`                                                    | **Mandatory.** Source of truth for `scraper create/run/heal/approve`.                                  |
| `bright-data-scraper-studio-nodejs-project`              | **Core boilerplate.** `/dca/trigger` + `/dca/dataset` wrapper, retry/backoff.                          |
| `bright-data-scraper-studio-python-project`              | Reference only (Python is broken here).                                                                |
| `skills`                                                 | Claude Code plugin, 21 skills. `skills/scraper-studio/` + `references/recipes.md` are the useful ones. |
| `brightdata-mcp`                                         | MCP server, 60+ tools. Optional.                                                                       |
| `sdk-js` / `brightdata-typescript-sdk`                   | JS/TS SDKs if we want to skip raw HTTP.                                                                |
| `bright-data-quickstart-templates`                       | Index of all quickstarts.                                                                              |
| `bright-data-scraping-browser-nodejs-playwright-project` | Screenshot path _if_ we use Browser API — but see cost note below.                                     |

## The key finding: self-healing is scriptable

Self-healing is **not** UI-only. The docs only describe the IDE panel, but the CLI exposes the
whole loop, which means the Day-6 set piece can be a recorded terminal session driven by code:

```bash
brightdata scraper run  <collector_id> <url> --json -o out.json   # 1. detect (WE decide it's broken)
brightdata scraper heal <collector_id> "<what's wrong>" \
    --url <url> --pretty -o heal.json                             # 2. heal → stops at approval gate
brightdata scraper approve <collector_id> --url <url>             # 3. commit
brightdata scraper run  <collector_id> <url> --pretty             # 4. verify
```

- `heal` stops at `status: "awaiting_approval"` with a `preview_result` — human-in-the-loop by
  default. `--auto-approve` makes it fully autonomous.
- A failed heal is **non-destructive**; the old scraper keeps working.
- `collector_id` is stable across a heal — the scraper is repaired, not replaced.
- **The CLI never decides a scraper is broken. We do.** That detector is ours to build, and it is
  the part judges will score under "reliability and self-healing."

## Architecture consequence: one collector per outlet

`scraper create` takes **one URL + one description**. `--urls` batching is for many pages of the
_same_ shape, so it will not carry 20 different homepage layouts.

So: **20 collectors, one identical plain-language field description.** That is exactly the
"one schema projected onto every layout" idea — the shared description _is_ the schema.

Timing constraint: generation takes **5–10 min each** and the AI Flow caps at **3 concurrent**
(`429` + auto-backoff). 20 collectors ≈ **45–70 min wall clock**. Start early.

### Measured, building five at once (2026-08-17)

Three started immediately; two waited through four exponential-backoff rounds before a slot opened.
Of the five, **three succeeded on the first attempt**, one produced a working-but-nested shape, and
one exhausted the CLI's 600-second polling timeout at the `preview_picker` step and had to be rebuilt
with `--timeout 1500`, leaving an orphaned half-built template behind.

So the realistic planning number is not "5–10 min each" but **"5–10 min each, three at a time, with a
non-trivial chance any one of them needs a second run."** For 20 outlets, budget two hours and expect
to rebuild two or three.

## Credit math (this is comfortable)

Free tier is 5,000 credits/month ≈ $7.50, so ~$0.0015/credit. The $50 promo ≈ **33,000 credits**.

| Item                                                                                     | Credits     | ≈ $      |
| ---------------------------------------------------------------------------------------- | ----------- | -------- |
| Scraper Studio: 1 credit / **page load**                                                 | —           | —        |
| 20 outlets × 24 h × 7 days                                                               | 3,360       | ~$5      |
| Screenshots via `brightdata scrape -f screenshot` (Unlocker, 1 credit/req), same cadence | 3,360       | ~$5      |
| 20 × `scraper create` + heals                                                            | few hundred | ~$1      |
| **Total for the full week at 20 outlets**                                                | **~7,000**  | **~$10** |

**Cost trap:** `brightdata browser` (Browser API) is **NOT** covered by free/promo credits — it
gets a separate one-time $2 trial (7 days) + $5 bonus (30 days). Use
`brightdata scrape <url> -f screenshot` (Unlocker) for hourly homepage screenshots instead.
Same receipts, covered by credits.

## Blockers — all cleared

1. ~~Bright Data account + API token~~ — done; key is Admin-scoped, stored in gitignored `.env`.
2. ~~Claim the $50 hackathon credits~~ — done; `brightdata budget` reports **$50.00**, $0.00 pending.
3. ~~Authenticate the CLI~~ — done via `brightdata login --api-key <key>`, which is non-interactive
   and **auto-created the `cli_unlocker` and `cli_browser` zones**. No control-panel work was needed.
4. ~~Hackathon registration~~ — done.

## RESOLVED — Scraper Studio automation is enabled

Account 1 now generates collectors. `brightdata scraper create` reaches `Generating scraper...`
instead of `Automation not allowed`, using key `4bbd…d1cd`.

Two operational notes learned while getting here:

- **API keys can carry an IP allowlist.** A key whose allowlist does not include this machine's
  public egress IP fails as `401 Invalid credentials` — the same error text as an expired key, which
  makes it easy to misdiagnose. Corporate NAT egress addresses can rotate, so re-check
  (`curl ifconfig.me`) before concluding a key has died.
- **Two accounts were in play.** Account 2 could generate collectors but its key died; Account 1 had
  the balance and a live key but was gated. Everything now runs on Account 1.

The history below is kept because the failure modes are worth remembering.

## Former blocker — payment method required for Scraper Studio

`brightdata scraper create` fails at the AI-generation step:

```
Template created: c_msx20h0y24mxd8ppib
Triggering AI generation...
Failed to start AI generation: Error: Automation not allowed   Status: 403
```

The template is created; only `POST /dca/collectors/{id}/automate_template` is refused. Cause is
documented in the Scraper Studio quickstart prerequisites: **"An active Bright Data account with a
payment method on file."** Promo credits do not substitute — this gate is separate from balance,
which is why `$50.00` is present and generation still 403s.

Per Bright Data's own CLI docs, adding a card is a _verification_ step: _"you are not charged unless
your free credits are exhausted **and** you have funds deposited"_ — and it adds a $5 bonus. But it is
the account owner's call.

**Diagnostic worth running first:** try creating any scraper by hand at
https://brightdata.com/cp/scrapers. If the UI blocks identically, it is account-level (payment
method). If the UI works, the restriction is API/CLI-only and we can build collectors in the UI and
drive them by `collector_id`, which satisfies the hackathon rules either way.

### Orphaned collectors to delete manually

Bright Data exposes no programmatic delete. Both are empty templates from failed generations:

- `c_msx1ybzn2fn430dkvq` — failed on the 1000-char description limit
- `c_msx20h0y24mxd8ppib` — failed on `Automation not allowed`

Rotate the API key after the hackathon: it has been pasted into a chat transcript.

## Judging criteria (6, equal weight)

Potential impact · Creativity and innovation · Technical excellence · **Use of Scraper Studio** ·
**Reliability and self-healing** · Presentation quality

Tracks: Web-Slinger (best use of Bright Data, NVIDIA DGX Spark) · Suit-Up (best UI, iPad) ·
Spider-Sense (best clean code, Keychron).

Rules: public web data only; no login-protected, paywalled, or restricted data.
