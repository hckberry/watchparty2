# Watch Party

A shared room for watching with friends. One person hosts, everyone else joins with a code or an invite link.

## Deploy on Render (free)

1. Put these files in a new GitHub repo, keeping the `public` folder (with `index.html` inside) as it is.
2. On render.com choose New, then Web Service, and connect that repo.
3. Use these settings (or pick Blueprint and let `render.yaml` fill them in):
   - Build command: `npm install`
   - Start command: `npm start`
4. When it finishes, open your `onrender.com` link, create a room, and send your friends the invite link.

Notes:
- On the free plan the service sleeps after a while with no visitors, so the first load can take up to a minute.
- Rooms live in memory. If the service restarts, rooms close and people need to make a new one.

## Run locally

    npm install
    npm start

Then open http://localhost:3000

To add or change a server, edit `SERVERS` in `public/index.html` and add its domain to `ALLOWED_HOSTS` in `server.js`.
