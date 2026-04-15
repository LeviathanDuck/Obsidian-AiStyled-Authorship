# Ai Styled Text Authorship For Obsidian

An Obsidian plugin that replicates iA Writer's "paste as AI author" feature: text pasted via the plugin's command is visually marked with a colored gradient, tracked per-character, and persists across sessions and devices.

*A project of the Leviathan Duck from Leftcoast Media House Inc.*

## Inspired by iA Writer

This plugin exists because of the work of [iA Writer](https://ia.net/writer) and its Authorship feature. iA Writer is my favorite Markdown editor and the tool whose feel I keep trying to bring into other environments — this plugin is one of those attempts.

If you haven't tried iA Writer, I'd encourage you to. It's a paid app made by Information Architects Inc., a small independent design studio, and their attention to craft is what made the Authorship feature worth recreating.

This plugin is an independent implementation. No iA Writer code is used. iA Writer® is a trademark of Information Architects Inc.

## Status

Under active development. Spec lives at `../../1.Orthanc/workshop/Plugins/aistyled-authorship-plugin/`.

## Development

```sh
npm install
npm run dev      # watches main.ts and rebuilds main.js
npm run build    # production build (minified, no sourcemaps)
```

### Install into an Obsidian vault

Either symlink the plugin folder into a vault's `.obsidian/plugins/` directory, or copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/aistyled-authorship/` after a build. Then enable Community Plugins in Obsidian and turn on **AiStyled-Authorship**.

## Disclaimer

> **Use at your own risk.** This plugin reads and writes files in your vault. Back up your data. The author accepts no liability for data loss, corruption, or any other issues arising from its use. See [LICENSE](./LICENSE) for full terms.

## Trademarks

iA Writer® is a trademark of Information Architects Inc. Obsidian® is a trademark of Dynalist Inc. All other trademarks are the property of their respective owners.

## License

MIT. Copyright © 2026 Leftcoast Media House Inc.
