# Revenge Relationship Notifier — 0.1.2 alpha

This revision fixes the repository index itself.

The prior `repo.json` entry was only summary metadata. Revenge treats every
non-`$` entry as a complete plugin manifest, so this package now publishes the
complete spec-3 manifest in both `repo.json` and
`builds/relationship-notifier/manifest.json`.

It also sets `alwaysFetch: true` in the repository entry during alpha testing so
Revenge does not keep reusing an older cached script.

Replace:
- `repo.json`
- `builds/relationship-notifier/manifest.json`
- `builds/relationship-notifier/index.js`

Use the repository URL with the final slash:
https://lapialregalia.github.io/Revenge-Relationship-Notifier/
