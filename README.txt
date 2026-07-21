DIRECT REVENGE/VENDETTA PLUGIN BUILD — 0.1.3-alpha.1

Replace only these hosted files:

builds/relationship-notifier/manifest.json
builds/relationship-notifier/index.js

You do not need repo.json for direct installation.

After GitHub Pages deploys, install from:

https://lapialregalia.github.io/Revenge-Relationship-Notifier/builds/relationship-notifier/

The manifest follows the same direct-plugin format as the working Message Logger example:
name, description, authors, main, vendetta, and SHA-256 hash.

The script follows the working Vendetta/Revenge IIFE format and executes immediately,
returning a plugin object with onUnload.
