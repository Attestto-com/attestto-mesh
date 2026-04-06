# Translation Guide

Thank you for helping translate Attestto Mesh documentation.

## Adding a New Language

1. Create two files in this directory:
   - `README.{lang}.md` (executive overview)
   - `TECHNICAL.{lang}.md` (developer reference)

2. Use the [ISO 639-1](https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes) two-letter language code (e.g., `fr`, `pt`, `de`, `ja`, `ko`, `zh`).

3. Add a language selector at the top of your files:
   ```markdown
   [English](../../README.md) | [Espanol](./README.es.md) | **[Francais](./README.fr.md)**
   ```

4. Update the language selector in **all existing translations** and in the root `README.md` and `TECHNICAL.md` to include your new language.

## Translation Rules

- **Do not translate** code blocks, API names, type names, or CLI commands.
- **Do not translate** proper nouns: Attestto, Solana, libp2p, Kademlia, GossipSub, etc.
- **Keep** technical terms that are universally understood in English (e.g., "mesh", "gossip", "hash", "blob") — add a brief parenthetical explanation if your language has a common equivalent.
- **Keep** relative links intact — they must point to the correct files from the `docs/translations/` directory.
- **Match** the structure and headings of the English original. Do not add or remove sections.

## Current Translations

| Language | Code | README | TECHNICAL | Translator |
|:---------|:-----|:------:|:---------:|:-----------|
| English | `en` | [README.md](../../README.md) | [TECHNICAL.md](../../TECHNICAL.md) | Core team |
| Espanol | `es` | [README.es.md](./README.es.md) | [TECHNICAL.es.md](./TECHNICAL.es.md) | Core team |

## Questions?

Open an issue on the [repo](https://github.com/Attestto-com/attestto-mesh/issues) with the label `translation`.
