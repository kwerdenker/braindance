# Decision log

Append-only. One line per answered question, so a decision made once is not re-opened.
Read this before asking anything that sounds settled.

2026-07-31 — Q: Amend `50b8d13` with step 7's review fixes, or commit on top? → Decision: commit on top. Amending orphans the base `own-libfreenect2` is built on, so the merge would carry two commits both claiming to be step 7, one with a footage-loss regression.
2026-07-31 — Q: Merge, rebase or cherry-pick `own-libfreenect2`? → Decision: merge. Shared base and a one-file conflict make it cheap either way; the commit bodies are this repo's documentation, and the branch is checked out in a live worktree so rebasing it in place is out.
2026-07-31 — Q: Resolve the `CLAUDE.md` conflict by taking a side? → Decision: no, union. The two sides describe different things and neither supersedes the other.
2026-07-31 — Q: Should the route sweep assert the open take's size during the drive as well as after close? → Decision: after close only. The during-drive delta reads 0 on 40 of 40 samples but that is a syscall-width window, not a guarantee; one exact row beats two where the extra can lie.
2026-07-31 — Q: Close the query-parameter plant shape? → Decision: no, record it as a known hole. No enumeration of the route table can reach a parameter the table does not declare; a lint over `read` handlers touching `query` is a different tool.
2026-07-31 — Q: Fix `vendor-check` proving the source rather than the built artifact before merging? → Decision: no, land it and record the gap in the merge commit body. It is a coverage gap, not a broken product.
2026-07-31 — Q: Does the open-take sweep blindness block the step-7 commit? → Decision: yes, fixed before committing. The reviewer judged it non-blocking since nothing does that shape today, but the sweep exists to catch a route added later and step 8 adds routes.
2026-07-31 — Q: Change the registration thread count from 2? → Decision: no, not without measuring on the capture node. The Mac's answer was 4 and 4 was the worst setting there.
2026-07-31 — Q: Re-run all 87 mutations independently after round 5, or scope it? → Decision: scope to the 46 library mutations plus the 8 clean runs. Only `server/library.js` and `tools/library-check.mjs` changed; the other tools exercise unchanged `web/main.js` and were already green on this code.
2026-07-31 — Q: Where does the WebSocket `Origin` check live? → Decision: its own commit, after step 7. All five reserved regions in `server/index.js` are byte-identical to `50b8d13` so that commit can own them cleanly.
