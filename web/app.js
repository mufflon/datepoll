"use strict";

// Where the Cloudflare Worker lives. Set the production URL after `wrangler deploy`.
const API =
  location.hostname === "localhost"
    ? "http://localhost:8787"
    : "https://datepoll.REPLACE-ME.workers.dev";

const MAX_DATES = 60;
const ANSWERS = [
  ["yes", "Yes", "✓"],
  ["maybe", "Maybe", "?"],
  ["no", "No", "✗"],
];

const app = document.getElementById("app");
const newLink = document.querySelector(".new-link");
let viewAbort = new AbortController();
let justCreated = null;

window.addEventListener("hashchange", route);
route();

function route() {
  viewAbort.abort();
  viewAbort = new AbortController();
  const id = location.hash.replace(/^#\/?/, "");
  newLink.hidden = !id;
  window.scrollTo(0, 0);
  if (id) renderPoll(id, viewAbort.signal);
  else renderCreate();
}

// ---------- Create ----------

function renderCreate() {
  document.title = "New poll · datepoll";
  const selected = new Set();
  const today = toKey(new Date());
  let view = new Date();
  view.setDate(1);

  const title = h("input", {
    id: "title",
    type: "text",
    maxlength: 200,
    placeholder: "e.g. Team dinner",
    autocomplete: "off",
  });
  const calendar = h("div", { class: "calendar" });
  const chips = h("ul", { class: "chips", "aria-live": "polite" });
  const error = h("p", { class: "error", role: "alert", hidden: true });
  const submit = h("button", { class: "primary", type: "submit", disabled: true }, "Create poll");

  function update() {
    submit.disabled = !title.value.trim() || selected.size === 0;
    chips.replaceChildren(
      ...(selected.size === 0
        ? [h("li", { class: "fine" }, "Pick one or more days in the calendar.")]
        : [...selected].sort().map((key) =>
            h(
              "li",
              {},
              h(
                "button",
                {
                  type: "button",
                  class: "chip",
                  "aria-label": `Remove ${longDate(key)}`,
                  onclick: () => toggle(key),
                },
                shortDate(key),
                h("span", { "aria-hidden": "true" }, "  ×"),
              ),
            ),
          )),
    );
  }

  function toggle(key) {
    if (selected.has(key)) selected.delete(key);
    else if (selected.size < MAX_DATES) selected.add(key);
    const btn = calendar.querySelector(`[data-date="${key}"]`);
    if (btn) btn.setAttribute("aria-pressed", String(selected.has(key)));
    update();
  }

  function renderCalendar() {
    const y = view.getFullYear();
    const m = view.getMonth();
    const first = new Date(y, m, 1);
    const offset = (first.getDay() + 6) % 7; // Monday first
    const days = new Date(y, m + 1, 0).getDate();
    const now = new Date();
    const isCurrentMonth = y === now.getFullYear() && m === now.getMonth();
    const month = first.toLocaleDateString(undefined, { month: "long", year: "numeric" });

    calendar.replaceChildren(
      h(
        "div",
        { class: "cal-head" },
        h(
          "button",
          {
            type: "button",
            "aria-label": "Previous month",
            disabled: isCurrentMonth,
            onclick: () => {
              view = new Date(y, m - 1, 1);
              renderCalendar();
            },
          },
          "‹",
        ),
        h("strong", { "aria-live": "polite" }, month),
        h(
          "button",
          {
            type: "button",
            "aria-label": "Next month",
            onclick: () => {
              view = new Date(y, m + 1, 1);
              renderCalendar();
            },
          },
          "›",
        ),
      ),
      h(
        "div",
        { class: "cal-grid", role: "group", "aria-label": month },
        weekdayNames().map((n) => h("span", { class: "cal-wd", "aria-hidden": "true" }, n)),
        Array.from({ length: offset }, () => h("span")),
        Array.from({ length: days }, (_, i) => {
          const key = toKey(new Date(y, m, i + 1));
          return h(
            "button",
            {
              type: "button",
              class: key === today ? "cal-day today" : "cal-day",
              "data-date": key,
              "aria-pressed": String(selected.has(key)),
              "aria-label": longDate(key),
              disabled: key < today,
              onclick: () => toggle(key),
            },
            String(i + 1),
          );
        }),
      ),
    );
  }

  const form = h(
    "form",
    {
      class: "card stack",
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        submit.textContent = "Creating…";
        error.hidden = true;
        try {
          const { id } = await api("/polls", {
            title: title.value.trim(),
            dates: [...selected].sort(),
          });
          justCreated = id;
          location.hash = `#/${id}`;
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
          submit.textContent = "Create poll";
          update();
        }
      },
    },
    h("label", { class: "field", for: "title" }, h("span", { class: "label" }, "Title"), title),
    h("div", { class: "field" }, h("span", { class: "label" }, "Dates"), calendar, chips),
    error,
    h("div", { class: "actions" }, submit),
  );

  title.addEventListener("input", update);
  app.replaceChildren(
    h("h1", {}, "New poll"),
    form,
    h(
      "p",
      { class: "fine" },
      "No login. Anyone with the link can vote, and votes can't be changed once submitted. " +
        "Polls delete themselves 30 days after their last date.",
    ),
  );
  renderCalendar();
  update();
  title.focus();
}

// ---------- Poll ----------

async function renderPoll(id, signal) {
  document.title = "datepoll";
  app.replaceChildren(h("p", { class: "muted" }, "Loading…"));

  let poll;
  try {
    ({ poll } = await api(`/polls/${encodeURIComponent(id)}`));
  } catch (err) {
    if (signal.aborted) return;
    const missing = err.status === 404;
    app.replaceChildren(
      h("h1", {}, missing ? "Poll not found" : "Something went wrong"),
      h("p", {}, missing ? "This poll doesn't exist, or it has expired and been deleted." : err.message),
      h("p", {}, h("a", { href: "#/" }, "Create a new poll")),
    );
    return;
  }
  if (signal.aborted) return;

  document.title = `${poll.title} · datepoll`;
  const storageKey = `datepoll:voted:${id}`;
  const results = h("div", { class: "card" });
  const voteArea = h("div", { class: "card" });
  const created = justCreated === id;
  justCreated = null;

  function renderResults() {
    if (poll.votes.length === 0) {
      results.replaceChildren(h("p", { class: "muted", style: "margin:0" }, "No votes yet."));
      return;
    }
    const mine = (store.get(storageKey) || "").toLowerCase();
    const tallies = poll.dates.map((d) => ({
      yes: poll.votes.filter((v) => v.answers[d] === "yes").length,
      maybe: poll.votes.filter((v) => v.answers[d] === "maybe").length,
    }));
    // Most yeses wins; maybes break ties.
    const top = tallies.reduce(
      (best, t) => (t.yes > best.yes || (t.yes === best.yes && t.maybe > best.maybe) ? t : best),
      { yes: 0, maybe: 0 },
    );
    const isBest = (t) => (top.yes || top.maybe) && t.yes === top.yes && t.maybe === top.maybe;

    results.replaceChildren(
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          {},
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              h("th", { scope: "col" }, "Date"),
              h("th", { scope: "col" }, "Total"),
              poll.votes.map((v) =>
                h(
                  "th",
                  { scope: "col", title: v.name, class: v.name.toLowerCase() === mine ? "mine" : null },
                  v.name,
                ),
              ),
            ),
          ),
          h(
            "tbody",
            {},
            poll.dates.map((d, i) =>
              h(
                "tr",
                { class: isBest(tallies[i]) ? "best" : null },
                h(
                  "th",
                  { scope: "row" },
                  shortDate(d),
                  isBest(tallies[i]) ? h("span", { class: "badge" }, "Best") : null,
                ),
                h(
                  "td",
                  {},
                  h(
                    "span",
                    { class: "tally" },
                    h("span", { class: "t-yes", title: "Yes" }, `✓ ${tallies[i].yes}`),
                    h("span", { class: "t-maybe", title: "Maybe" }, `? ${tallies[i].maybe}`),
                  ),
                ),
                poll.votes.map((v) => {
                  const [key, label, glyph] = ANSWERS.find(([k]) => k === v.answers[d]);
                  return h("td", { class: `a-${key}`, title: `${v.name}: ${label}` }, glyph);
                }),
              ),
            ),
          ),
        ),
      ),
    );
  }

  function renderVoteArea(showForm = false) {
    const votedAs = store.get(storageKey);
    if (votedAs && !showForm) {
      voteArea.replaceChildren(
        h("p", { class: "voted" }, "✓ You voted as ", h("strong", {}, votedAs), "."),
        h("button", { type: "button", class: "link", onclick: () => renderVoteArea(true) }, "Vote for someone else"),
      );
      return;
    }

    const answers = {};
    const name = h("input", { id: "name", type: "text", maxlength: 60, autocomplete: "name" });
    const progress = h("span", { class: "fine" });
    const error = h("p", { class: "error", role: "alert", hidden: true });
    const submit = h("button", { class: "primary", type: "submit", disabled: true }, "Submit vote");

    function update() {
      const n = Object.keys(answers).length;
      progress.textContent = `${n} of ${poll.dates.length} dates answered`;
      submit.disabled = !name.value.trim() || n < poll.dates.length;
    }

    const rows = poll.dates.map((d, i) =>
      h(
        "div",
        { class: "vote-row", role: "radiogroup", "aria-label": longDate(d) },
        h("span", {}, shortDate(d)),
        h(
          "div",
          { class: "seg" },
          ANSWERS.map(([key, label]) =>
            h(
              "label",
              { class: key },
              h("input", {
                type: "radio",
                name: `d${i}`,
                value: key,
                onchange: () => {
                  answers[d] = key;
                  update();
                },
              }),
              h("span", {}, label),
            ),
          ),
        ),
      ),
    );

    const form = h(
      "form",
      {
        class: "stack",
        onsubmit: async (e) => {
          e.preventDefault();
          const who = name.value.trim().replace(/\s+/g, " ");
          if (!confirm(`Submit your vote as “${who}”?\n\nVotes can't be changed afterwards.`)) return;
          submit.disabled = true;
          submit.textContent = "Submitting…";
          error.hidden = true;
          try {
            ({ poll } = await api(`/polls/${encodeURIComponent(id)}/votes`, { name: who, answers }));
            store.set(storageKey, who);
            renderResults();
            renderVoteArea();
          } catch (err) {
            error.textContent = err.message;
            error.hidden = false;
            submit.textContent = "Submit vote";
            update();
          }
        },
      },
      h("label", { class: "field", for: "name" }, h("span", { class: "label" }, "Your name"), name),
      h("div", {}, rows),
      error,
      h("div", { class: "actions" }, submit, progress),
      h("p", { class: "fine", style: "margin-bottom:0" }, "Votes are final: once submitted, they can't be changed."),
    );

    name.addEventListener("input", update);
    voteArea.replaceChildren(form);
    update();
  }

  app.replaceChildren(
    h("h1", {}, poll.title),
    created ? h("p", { class: "notice" }, "Poll created. Share this link: anyone who has it can vote.") : null,
    shareRow(`${location.origin}${location.pathname}#/${id}`),
    h("h2", {}, "Results"),
    results,
    h("h2", {}, "Your vote"),
    voteArea,
    h(
      "p",
      { class: "fine" },
      `This poll deletes itself on ${new Date(poll.expiresAt).toLocaleDateString(undefined, {
        day: "numeric",
        month: "long",
        year: "numeric",
      })}.`,
    ),
  );
  renderResults();
  renderVoteArea();

  // Pick up other people's votes when coming back to the tab.
  document.addEventListener(
    "visibilitychange",
    async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const data = await api(`/polls/${encodeURIComponent(id)}`);
        if (signal.aborted) return;
        poll = data.poll;
        renderResults();
      } catch {
        // Keep showing what we have.
      }
    },
    { signal },
  );
}

function shareRow(url) {
  const input = h("input", {
    type: "text",
    readOnly: true,
    value: url,
    "aria-label": "Poll link",
    onfocus: (e) => e.target.select(),
  });
  const button = h(
    "button",
    {
      type: "button",
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(url);
        } catch {
          input.select();
          document.execCommand("copy");
        }
        button.textContent = "Copied";
        setTimeout(() => (button.textContent = "Copy link"), 1500);
      },
    },
    "Copy link",
  );
  return h("div", { class: "share" }, input, button);
}

// ---------- Helpers ----------

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, body) {
  let res;
  try {
    res = await fetch(
      API + path,
      body === undefined
        ? {}
        : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    );
  } catch {
    throw new ApiError(0, "Couldn't reach the server. Check your connection and try again.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status}).`);
  return data;
}

// localStorage can be missing or throw (private mode, blocked storage).
const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Only used to remember who voted from this browser.
    }
  },
};

function toKey(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fromKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function shortDate(key) {
  const d = fromKey(key);
  const opts = { weekday: "short", day: "numeric", month: "short" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}

function longDate(key) {
  return fromKey(key).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function weekdayNames() {
  // 2024-01-01 was a Monday.
  return Array.from({ length: 7 }, (_, i) =>
    new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: "short" }),
  );
}

// Tiny DOM builder. Strings become text nodes, so user content is never parsed as HTML.
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k in el && !k.includes("-")) el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}
