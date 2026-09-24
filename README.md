# My Meeting App

Browser-to-browser live classes with video, whiteboard, PDF sharing, chat, hand raise, attendance and recording.
No server needed (WebRTC via PeerJS). Host it free on GitHub Pages.

## Files (upload these to the repo root)
| File | Purpose |
|---|---|
| `index.html`, `style.css`, `app.js` | the app |
| `config.js` | **your settings** (name, logo, colour, room, passcode hash) |
| `.nojekyll` | tells GitHub Pages to serve files as-is |
| `make-passcode-hash.html` | optional: keep on your computer, used once to make a passcode hash |
| `logo.png` | optional: your own logo (then set `LOGO: "logo.png"` in config.js) |

## Customise (config.js)
- `APP_NAME`, `TAGLINE`, `WELCOME_TEXT`, `FOOTER_TEXT` – text on the join screen
- `LOGO` – an emoji like `"🎓"` or an uploaded image like `"logo.png"` (also becomes the browser-tab icon)
- `TEACHERS` – one line per teacher, each with their own passcode (see below)
- `BRAND_COLOR` – e.g. `"#7c3aed"` recolours buttons and highlights everywhere
- `TEACHER_LABEL` – name students see on your video, e.g. `"Mohan Sir"`

## Teacher features
- **People panel**: see who is online, mute one or all, remove a student, allow drawing, lower raised hands
- **Lock class**: stops new students joining (students already inside stay)
- **Student chat on/off**
- **Attendance CSV**: names, join/leave times, minutes present (offered automatically when you end the class)
- **Record**: click Record, choose **"This tab"** and tick **"Share tab audio"**. Saved as a video to your Downloads when you stop. Students see a red "REC" notice. Use desktop Chrome/Edge. Long classes use memory, so record in sessions of about an hour or less.
- **End class** tells all students the class has ended.

## Student features
- Raise/lower hand (✋), chat, see the teacher, view the whiteboard

## Separate passcode for each teacher
In `config.js`, add one line per teacher inside `TEACHERS`:
```js
TEACHERS: [
  { name: "Mohan Sir",   hash: "HASH-1" },
  { name: "Priya Madam", hash: "HASH-2", rooms: ["maths-batch-a", "maths-batch-b"] },
],
```
1. Give each teacher a different passcode. Open `make-passcode-hash.html` on your computer, type it, copy the hash into that teacher's line. Do this for each teacher, and tell each teacher only their own passcode.
2. `name` is shown to students and written in that teacher's attendance file and recording file name. The teacher can't change it.
3. `rooms` (optional) limits which rooms that passcode can host. Leave it out to allow any room.
4. **To remove a teacher**, delete their line and upload `config.js` again. Their passcode stops working right away.

## Before you go live
1. Replace the sample hash (`change-me-123`) with real passcode hashes. The app warns you until you do.
2. Change `ROOM` and `NAMESPACE` to something unique.
3. GitHub Pages: repo **Settings → Pages → Deploy from a branch → main / (root)**.

## Notes
- Keep the teacher's tab open during class; closing it disconnects everyone (the app asks you to confirm).
- GitHub Pages is public, so the passcode hash is a deterrent, not bank-level security. Use a long passcode.
- Students on strict school/office networks may need a TURN server (`EXTRA_ICE_SERVERS` in config.js).
