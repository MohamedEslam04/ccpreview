# Marsad

A local, privacy-first web viewer for your Claude Code sessions. Watch them live, side by side, with diffs, subagents, search and notes.

![Marsad](docs/screenshot.png)

Marsad (مرصد) is Arabic for "observatory". It reads the transcripts Claude Code already writes to `~/.claude/projects` and shows them in a browser. It never talks to Claude and never uploads anything.

## Features

- Live view: sessions update as Claude Code writes them.
- Session list grouped by project or by day, with quick filters (live, waiting for you, open, pinned), a date filter and a title filter.
- Up to 4 sessions side by side.
- Subagent transcripts, with a subagents bar per session.
- Message rail per session, with jump navigation.
- In-session search: Arabic-aware matching, regex, whole word, and a scope selector.
- Diffs for `Edit`, `MultiEdit` and `Write` calls.
- Pinned plan (`ExitPlanMode`) and todo list (`TodoWrite`).
- `AskUserQuestion` cards that show the answer you picked.
- Images and screenshots, with a lightbox.
- Notifications when a session finishes or waits for you.
- Notes pad: pages with thumbnails. Pasting a terminal box-drawing table or markdown turns it into a real table.
- English and Arabic UI (right-to-left), light and dark theme.

## Quick start

### With npx (every browser)

```sh
npx marsad
```

This starts a server on `http://127.0.0.1:4747`, opens it in your browser and reads `~/.claude/projects`. Needs Node 18 or newer.

### Hosted page (Chrome, Edge)

Open <https://mohamedeslam04.github.io/marsad/> and pick your `~/.claude/projects` folder once. The browser reads the files directly through the File System Access API. The page remembers the folder and asks for read permission again when needed.

`~/.claude` is a hidden folder, so the picker may not show it:

- Linux (GTK picker): press `Ctrl+H`, or type `~/.claude/projects` with `Ctrl+L`.
- macOS: press `Cmd+Shift+.`.
- Windows: paste `%USERPROFILE%\.claude\projects` into the picker's address bar.

If you pick `~/.claude` instead of `~/.claude/projects`, Marsad steps into `projects` for you.

Firefox and Safari do not support folder access. Use `npx marsad` there.

## Privacy and security

- The server listens on `127.0.0.1` only.
- Every request must carry a `Host` header of `127.0.0.1:<port>` or `localhost:<port>`. This blocks DNS rebinding.
- No CORS headers are sent, so other websites cannot read responses. Writes (`PUT /api/pages`, `POST /api/shutdown`) also require a same-origin `Origin` header.
- Session ids and folder names are validated against a strict pattern, so `..` and hidden folders are rejected. Static files come from a fixed list.
- Nothing is uploaded. There is no analytics, no telemetry and no external request, in either mode.
- Folder mode requests read-only access. The hosted page never writes to your folder.
- Notes are stored in `~/.marsad/pages.json` in server mode (with daily backups in `~/.marsad/backups`, the last 14 kept) and in the browser's `localStorage` in folder mode.
- Transcripts can contain secrets and source code. Do not expose the server to a network.

## CLI options

```
marsad [options]

  -p, --port <n>       port to listen on (default 4747; 0 picks a free one)
      --projects <dir> Claude Code projects folder (default ~/.claude/projects)
      --data <dir>     where Marsad keeps your notes pages (default ~/.marsad)
      --no-open        don't open the browser
  -v, --version        print the version
  -h, --help           show this help
```

## Optional: start on login

On Linux, systemd socket activation starts Marsad the first time you open `http://127.0.0.1:4747/` and costs nothing while idle. See [docs/systemd](https://github.com/MohamedEslam04/marsad/tree/main/docs/systemd) for the unit files and setup.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `/` | Focus the session filter (sessions tab) |
| `Ctrl+F`, `F3` | Search in the active session; `F3` / `Shift+F3` step to the next / previous hit |
| `Enter`, `Shift+Enter` | Next / previous hit while the search box is focused |
| `Esc` | Close search, lightbox or menus |
| `Home`, `End` | Jump to the first / last message in the active session |
| `Alt+Up`, `Alt+Down` | Previous / next message in the active session (sessions tab); previous / next page (notes tab) |
| `Ctrl+Alt+Left`, `Ctrl+Alt+Right` | Change the content width |
| `Ctrl+\` | Hide or show the sidebar |
| `Alt+1`, `Alt+2` | Notes tab / sessions tab |
| `Ctrl+K` | Search notes pages |
| `Ctrl+Enter` | New notes page |
| `Ctrl+Shift+V` | Paste as plain text (skips the table and markdown conversion) |
| `Left`, `Right` | Next / previous image in the lightbox |

## Browser support

| Browser | `npx marsad` | Hosted page (folder mode) |
| --- | --- | --- |
| Chrome, Edge | Yes | Yes |
| Brave | Yes | Needs `brave://flags/#file-system-access-api` enabled |
| Firefox | Yes | No, use `npx marsad` |
| Safari | Yes | No, use `npx marsad` |

## How it works

`web/core.js` turns transcript lines into compact events (messages, tool calls, diffs, todos, results) and builds the session list. It has no dependencies and runs unchanged in Node and in the browser. Everything environment-specific (listing files, reading from a byte offset, storing images) goes through a small adapter.

`web/source.js` provides the two modes behind one interface:

- Server mode: `lib/server.js` implements the adapter with `fs` and streams events to the page over Server-Sent Events.
- Folder mode: the page implements the adapter with the File System Access API and runs `core.js` itself.

`web/app.js` is the UI and does not care which mode is active. The hosted page is the `web/` folder published to GitHub Pages.

## Development

```sh
git clone https://github.com/MohamedEslam04/marsad.git
cd marsad
npm start          # runs bin/marsad.js on :4747
npm test           # node:test, no dependencies
```

`npm run dev` starts the server without opening a browser.

## بالعربي

مرصد عارض محلي لجلسات Claude Code في المتصفح. بيقرأ ملفات الـ transcripts اللي Claude Code بيكتبها في `~/.claude/projects` وبيعرضها لحظة بلحظة: لحد 4 جلسات جنب بعض، الـ subagents، الـ diffs، البحث (بيفهم العربي)، وصفحة ملاحظات. الواجهة عربي وإنجليزي، فاتح وغامق.

- التشغيل: `npx marsad` ثم افتح `http://127.0.0.1:4747`. بيشتغل في كل المتصفحات.
- من غير تثبيت: افتح <https://mohamedeslam04.github.io/marsad/> واختار مجلد `~/.claude/projects` مرة واحدة (Chrome أو Edge). لو المجلد مخفي: `Ctrl+H` على لينكس، `Cmd+Shift+.` على ماك.
- الخصوصية: مفيش حاجة بتترفع لأي مكان. السيرفر على `127.0.0.1` بس، والوصول للمجلد للقراءة فقط. الملاحظات محفوظة في `~/.marsad/pages.json` (وضع السيرفر) أو في `localStorage` (وضع المجلد).

## Disclaimer

Marsad is an independent project and is not affiliated with or endorsed by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic. The transcript format is undocumented and can change between Claude Code releases, so parts of Marsad may break after an update.

## License

[MIT](LICENSE)
