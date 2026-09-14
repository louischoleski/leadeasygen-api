# The scrape worker — a long-lived process driving a real browser.
#
# This exists because the worker is the one part of LeadEasyGen that serverless
# cannot host. The API is request/response and belongs on Vercel; a scrape runs
# for minutes, pins a CPU, and holds a stateful Chromium process, so it needs a
# host that outlives a request. That is a property of the workload, not a
# shortcoming of the platform — no serverless runtime hosts this well.
#
# A Dockerfile rather than a provider-specific config on purpose: Fly, Railway,
# Render and Cloud Run all take one, so the hosting decision stays reversible.
#
# The tag MUST track the `playwright` version in package.json (1.63.0). The
# image ships the matching browsers and their system libraries; a mismatch
# means Playwright looks for a build that isn't there and fails at launch.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app

# Dependencies first, so a source-only change does not reinstall them.
COPY package.json package-lock.json* ./

# `npm ci` needs a lockfile; fall back for a checkout that lacks one.
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; \
    else npm install --no-audit --no-fund; fi

COPY . .

# CHROME_EXECUTABLE_PATH is deliberately NOT set: unset means Playwright's own
# bundled Chromium, which this image provides. It is only set on a dev machine
# where Playwright cannot install its build (see src/scraper/engine.ts).
#
# The image's default user is non-root, so Chromium's sandbox works normally
# here — the --no-sandbox flag in engine.ts is for runtimes that force root.
USER pwuser

# Migrations are NOT run here. They are the API deployment's job, and running
# them from a worker that may scale to several instances invites two processes
# migrating at once. See DEPLOYMENT notes: a schema-adding deploy must migrate.
CMD ["npm", "run", "worker"]
