#!/bin/sh
# Vercel "Ignored Build Step" (vercel.json ignoreCommand): exit 0 = skip this build, exit 1 = build it.
# Production always builds. A preview is skipped only when the commit message contains [skip ci] or [skip deploy], so work-in-progress
# pushes do not use the Hobby plan's 100 deployments per 24 hours. Vercel has no built-in commit-message marker; this is the documented way.
case "${VERCEL_ENV:-}" in
  production) exit 1 ;;
esac
case "${VERCEL_GIT_COMMIT_MESSAGE:-}" in
  *"[skip ci]"*|*"[skip deploy]"*) exit 0 ;;
esac
exit 1
