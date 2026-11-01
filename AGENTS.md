# Antumi Plugins

Official Antumi plugins, with independent versions and installable ZIPs.

- Plugins live in `plugins/<slug>`; organize by identity, not capability type.
- Keep package names, plugin IDs and source IDs stable. Current SDK supports task sources only; do not add placeholder APIs for future capabilities.
- Common build and release scripts live in `scripts/`; use the root npm lockfile and `npm ci`.
- SDK archives live in `vendor/`; plugins may use different SDK versions.
- Settings belong in each manifest. Pass AbortSignal through network requests; stdout is for SDK communication, logs go to stderr. Never log credentials.
- Run `npm run check` before committing. Every release validates its package, manifest and `<slug>-v<version>` tag.
- Commit as `flyhero <qfwang666@163.com>`. Use conventional commits with a body explaining behavior changes.
- Do not publish release tags unless the user asks. Keep old repositories and imported history intact.
