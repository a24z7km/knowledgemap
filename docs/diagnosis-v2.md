# Diagnosis v2: Source-Grounded Extraction

Date: 2026-05-03

## Changes

- Google Books lookup now tries three queries: `intitle + inauthor`, `intitle`, then plain title/author search.
- Google Books now requests up to 5 volumes and chooses the item with the longest description.
- `langRestrict=ja` was removed from Google Books requests.
- Analysis now measures source quality before extraction:
  - `meaningfulChars = description.length sum + tocLines * 20 + userNotes.length`
  - Runs with `meaningfulChars < 200` stop as `insufficient_source` before calling the LLM.
- Extraction now receives a dynamic `targetCount` based on source quality.
- The extraction prompt now permits small output when source is thin and forbids filler.
- `source_explicit` grounding is verified after the LLM response:
  - evidence not found in source text is downgraded to `model_prior`
  - evidence beginning with `Title:` or `Author:` is downgraded to `model_prior`
- Scoring no longer promotes the top 12 candidates automatically.
- Generic self-help terms from the 7つの習慣 failure mode were added to the blocklist.

## Verification

Commands:

- `npx tsc --noEmit`
- `npm run lint`
- `POST /api/analyze/1`
- `POST /api/analyze/2`
- `POST /api/analyze/11`

Static checks:

- TypeScript passed.
- ESLint passed with existing warnings only:
  - `app/books/[id]/page.tsx` missing `load` dependency
  - `app/map/page.tsx` hook dependency warnings
  - `components/graph/CytoscapeView.tsx` missing `buildElements` dependency

## Reanalysis Results

Google Books returned HTTP 429 quota exceeded during verification, so all three target books had empty external metadata in this run. With no user notes and no usable descriptions/TOC, the new guard stopped extraction before LLM generation.

| Book ID | Title | Run ID | Status | raw | clustered | promoted | Result |
| --- | --- | ---: | --- | ---: | ---: | ---: | --- |
| 1 | 7つの習慣 | 34 | failed | 0 | 0 | 0 | `insufficient_source` |
| 2 | 道は開ける | 35 | failed | 0 | 0 | 0 | `insufficient_source` |
| 11 | 精神科医が見つけた 3つの幸福 最新科学から最高の人生をつくる方法 | 36 | failed | 0 | 0 | 0 | `insufficient_source` |

Recorded source quality:

| Book ID | descriptionChars | tocLines | userNoteChars | meaningfulChars |
| --- | ---: | ---: | ---: | ---: |
| 1 | 0 | 0 | 0 | 0 |
| 2 | 0 | 0 | 0 | 0 |
| 11 | 0 | 0 | 0 | 0 |

## Expected Behavior Check

- 道は開ける: now stops as `insufficient_source` instead of returning a forced concept count.
- 7つの習慣: this verification run stopped before extraction because source was empty. The Title/Author evidence downgrade is implemented for the prior hallucination mode where every `evidenceText` was `Title: 7つの習慣 (...)`.
- 3つの幸福: stopped as `insufficient_source` in this run because metadata was empty under Google Books 429.
- Metadata-rich book: not verified in this run because Google Books quota exhaustion made external metadata unavailable. Re-run after quota recovery to confirm 12-30 candidates on a book with descriptions/TOC.

## Notes

The current behavior intentionally prefers `insufficient_source` over hallucinated concepts. A follow-up UI change should surface this as "書誌情報不足" and provide a user notes input path for recovery.
