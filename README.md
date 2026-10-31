# Watch Party

A shared room for watching with friends. One person hosts, everyone else joins with a code or an invite link.

## Deploy on Render (free)

1. Put these files in a new GitHub repo, keeping the `public` folder as it is.
2. On render.com choose New, then Web Service, and connect that repo.
3. Use these settings (or pick Blueprint and let `render.yaml` fill them in):
   - Build command: `npm install`
   - Start command: `npm start`
4. When it finishes, open your `onrender.com` link, create a room, and send your friends the invite link.

Notes:
- On the free plan the service sleeps after a while with no visitors, so the first load can take up to a minute.
- Rooms live in memory. If the service restarts, rooms close and people need to make a new one.

## Keeping everyone in sync

The video itself lives inside a third-party embed, so the page can't press play or seek for you. What it does:

- Anyone can pick what plays. The host can switch that off with **Guests can pick**.
- **Sync with room** (above the player, everyone): reloads your player at the room's current spot. On VidLink and VidFast it jumps straight to that time. On other servers it reloads and tells you the time to skip to.
- **Sync everyone** (host only): sends the same sync to every guest at once.
- If the embed reports its playback position, the host's real position is used. Otherwise the spot is an estimate from when the show started, and the app says so.
- Dropped connections (phone sleep, wifi blips) now reconnect on their own. If the host drops, the room stays open for a minute.

## Run locally

    npm install
    npm start

Then open http://localhost:3000
