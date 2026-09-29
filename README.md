# datepoll

Find a date that works for everyone. No login, no accounts.

- Create a poll: a title and some dates. You get a unique link.
- Anyone with the link votes Yes, Maybe or No for each date.
- Votes are final: once submitted, they can't be changed.
- Polls delete themselves 30 days after their last date.

## How it works

- `web/`: a static page (plain HTML/CSS/JS, no build step), served by GitHub Pages.
- `worker/`: a Cloudflare Worker with one [Durable Object](https://developers.cloudflare.com/durable-objects/) per poll, which stores the poll and its votes in SQLite. Votes are insert-only, one per name (case-insensitive). An alarm deletes the whole poll when it expires.

A poll link looks like `https://mufflon.github.io/datepoll/#/<id>`, where the id is 128 random bits. Knowing the link is what lets you vote, so there are no secrets in the repo or in links.

Without logins, "can't change a vote" means the server rejects a second vote under the same name. Nothing stops someone voting under a different name, or under someone else's name before they do.

## Run locally

```sh
cd worker && npm install && npx wrangler dev    # API on http://localhost:8787
python3 -m http.server 8000 -d web              # site on http://localhost:8000
```

Open http://localhost:8000. The page talks to the local Worker when served from `localhost`.

## Deploy

Worker:

```sh
cd worker
npx wrangler login
npx wrangler deploy
```

Put the `*.workers.dev` URL it prints into `API` at the top of `web/app.js`.

Site: in the GitHub repo settings, set Pages → Source to **GitHub Actions**. Every push to `main` that touches `web/` publishes it.

`ALLOWED_ORIGINS` in `worker/wrangler.jsonc` lists the sites allowed to call the API from a browser.
