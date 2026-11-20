# DT-20261120-emails Plan (D-0160)

## Overview
Fix customer e-mail and title wording issues:
1. Fix sector prefix stripping in `src/lib/agentMission/entities.ts` to preserve Arabic root letters (`برمجيات` instead of `رمجيات`).
2. Add capability-based item noun resolution in `src/lib/agentMission/itemNoun.ts` and pass capability/platform in `agent/src/runMission.ts` so comments/posts/videos deliveries never say «جهة تواصل».
3. Condense failure/unserved e-mail lead copy in `src/lib/agentMission/notices.ts` to one clear Arabic sentence while keeping the single charge detail line.
4. Keep `AGENT_PLANNING_WALL_MS` at 20 minutes with zero send delay.
5. Verification: Gate 1 passed GREEN by أشرف; all 12 test suites (188 tests) pass, typecheck and agent:typecheck clean.
