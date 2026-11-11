"use strict";

// Where the Cloudflare Worker (worker/) lives.
const API =
  location.hostname === "localhost"
    ? "http://localhost:8787"
    : "https://datepoll.mufflon.workers.dev";

const MAX_DATES = 60;
const MAX_OPTIONS = 20;
// Every poll is deleted this long after it's created (enforced by the Worker).
const LIFETIME_MONTHS = 6;
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

  // Optional variant: every voter leaves a phone number, which requires a delete-by date.
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const lastDeleteBy = new Date();
  lastDeleteBy.setMonth(lastDeleteBy.getMonth() + LIFETIME_MONTHS);
  const deleteBy = h("input", { id: "delete-by", type: "date", min: toKey(tomorrow), max: toKey(lastDeleteBy) });
  const phoneFields = h(
    "div",
    { class: "stack", hidden: true },
    h(
      "p",
      { class: "fine", style: "margin:0" },
      "Everyone who votes must leave a phone number. The numbers are shown in the results as tap-to-call links, " +
        "to everyone with the link.",
    ),
    h(
      "label",
      { class: "field", for: "delete-by" },
      h("span", { class: "label" }, "Delete by"),
      deleteBy,
      h(
        "span",
        { class: "fine" },
        `The poll and all phone numbers are deleted at the start of this day. At most ${LIFETIME_MONTHS} months ahead.`,
      ),
    ),
  );
  const collectPhones = h("input", {
    id: "collect-phones",
    type: "checkbox",
    onchange: () => {
      phoneFields.hidden = !collectPhones.checked;
      update();
    },
  });
  const deleteByValid = () => deleteBy.value >= deleteBy.min && deleteBy.value <= deleteBy.max;

  // Optional variant: a drop-down every voter must answer.
  const choice = choiceEditor(() => update());
  const addChoice = h("input", {
    id: "add-choice",
    type: "checkbox",
    onchange: () => {
      choice.el.hidden = !addChoice.checked;
      if (addChoice.checked) choice.focus();
      update();
    },
  });

  function update() {
    const choiceProblem = addChoice.checked ? choice.problem() : "";
    choice.hint.textContent = choiceProblem;
    submit.disabled =
      !title.value.trim() ||
      selected.size === 0 ||
      (collectPhones.checked && !deleteByValid()) ||
      Boolean(choiceProblem);
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
        const body = { title: title.value.trim(), dates: [...selected].sort() };
        if (collectPhones.checked) {
          body.collectPhones = true;
          body.deleteAt = fromKey(deleteBy.value).getTime(); // local midnight
        }
        if (addChoice.checked) body.choice = choice.value();
        try {
          const { id } = await api("/polls", body);
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
    h("label", { class: "check", for: "collect-phones" }, collectPhones, "Ask voters for their phone number"),
    phoneFields,
    h("label", { class: "check", for: "add-choice" }, addChoice, "Add a required drop-down list"),
    choice.el,
    error,
    h("div", { class: "actions" }, submit),
  );

  title.addEventListener("input", update);
  deleteBy.addEventListener("input", update);
  app.replaceChildren(
    h("h1", {}, "New poll"),
    form,
    h(
      "p",
      { class: "fine" },
      "No login. Anyone with the link can vote, and votes can't be changed once submitted. " +
        `All polls are deleted after ${LIFETIME_MONTHS} months, or earlier if a delete-by date is set.`,
    ),
  );
  renderCalendar();
  update();
  title.focus();
}

// Editor for the drop-down: a name and 2–20 options, at most one of them
// ticked as the default. Blank option rows are ignored.
function choiceEditor(onChange) {
  const label = h("input", {
    id: "choice-label",
    type: "text",
    maxlength: 60,
    placeholder: "e.g. Team",
    autocomplete: "off",
    oninput: onChange,
  });
  const list = h("ol", { class: "options" });
  const items = [];
  const addButton = h(
    "button",
    {
      type: "button",
      onclick: () => {
        addRow().text.focus();
        onChange();
      },
    },
    "Add option",
  );
  const hint = h("p", { class: "fine", style: "margin:0", "aria-live": "polite" });

  function addRow() {
    const item = {};
    item.text = h("input", {
      type: "text",
      maxlength: 60,
      autocomplete: "off",
      oninput: onChange,
      // Enter moves to the next option, adding one at the end, instead of submitting the form.
      onkeydown: (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        const next = items[items.indexOf(item) + 1] ?? (items.length < MAX_OPTIONS ? addRow() : null);
        next?.text.focus();
        onChange();
      },
    });
    item.isDefault = h("input", {
      type: "checkbox",
      onchange: () => {
        if (item.isDefault.checked) for (const other of items) if (other !== item) other.isDefault.checked = false;
        onChange();
      },
    });
    item.remove = h(
      "button",
      {
        type: "button",
        "aria-label": "Remove option",
        onclick: () => {
          items.splice(items.indexOf(item), 1);
          item.row.remove();
          refresh();
          onChange();
        },
      },
      "×",
    );
    item.row = h("li", {}, item.text, h("label", { class: "check" }, item.isDefault, "Default"), item.remove);
    items.push(item);
    list.append(item.row);
    refresh();
    return item;
  }

  function refresh() {
    items.forEach((item, i) => {
      item.text.placeholder = `Option ${i + 1}`;
      item.text.setAttribute("aria-label", `Option ${i + 1}`);
      item.remove.disabled = items.length <= 2;
    });
    addButton.disabled = items.length >= MAX_OPTIONS;
  }

  function value() {
    const filled = items.filter((item) => item.text.value.trim());
    return {
      label: label.value.trim(),
      options: filled.map((item) => item.text.value.trim()),
      default: filled.find((item) => item.isDefault.checked)?.text.value.trim() ?? null,
    };
  }

  // What's still missing, or "" when the drop-down is ready.
  function problem() {
    const v = value();
    if (!v.label) return "Give the drop-down a name.";
    if (v.options.length < 2) return "Add at least two options.";
    if (new Set(v.options.map((o) => o.toLowerCase())).size !== v.options.length) {
      return "The options must be different.";
    }
    return "";
  }

  addRow();
  addRow();
  const el = h(
    "div",
    { class: "stack", hidden: true },
    h(
      "p",
      { class: "fine", style: "margin:0" },
      "Every voter must pick one option. Tick Default to pre-select an option; otherwise voters have to choose.",
    ),
    h("label", { class: "field", for: "choice-label" }, h("span", { class: "label" }, "Name of the list"), label),
    h("div", { class: "field" }, h("span", { class: "label" }, "Options"), list, h("div", {}, addButton)),
    hint,
  );
  return { el, value, problem, hint, focus: () => label.focus() };
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
  const deletedOn = new Date(poll.expiresAt).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

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
    const contacts = poll.collectPhones
      ? h(
          "ul",
          { class: "contacts", "aria-label": "Phone numbers" },
          poll.votes
            .filter((v) => v.phone)
            .map((v) =>
              h(
                "li",
                {},
                h("span", {}, v.name),
                h("a", { class: "call", href: telHref(v.phone), "aria-label": `Call ${v.name}` }, phoneIcon(), v.phone),
              ),
            ),
        )
      : null;

    results.replaceChildren(
      ...[
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
              poll.choice
                ? h(
                    "tr",
                    { class: "choice-row" },
                    h("th", { scope: "row", title: poll.choice.label }, poll.choice.label),
                    h("td"),
                    // Votes from before the drop-down existed have no choice.
                    poll.votes.map((v) => h("td", { title: v.choice ?? "" }, v.choice ?? "–")),
                  )
                : null,
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
        contacts,
      ].filter(Boolean),
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
    const phone = poll.collectPhones
      ? h("input", {
          id: "phone",
          type: "tel",
          inputmode: "tel",
          autocomplete: "tel",
          maxlength: 30,
          placeholder: "e.g. 070-123 45 67",
        })
      : null;
    // Without a default, a disabled placeholder forces an active pick.
    const choice = poll.choice
      ? h(
          "select",
          { id: "choice" },
          poll.choice.default ? null : h("option", { value: "", disabled: true, selected: true }, "Choose…"),
          poll.choice.options.map((o) => h("option", { value: o, selected: o === poll.choice.default }, o)),
        )
      : null;
    const progress = h("span", { class: "fine" });
    const error = h("p", { class: "error", role: "alert", hidden: true });
    const submit = h("button", { class: "primary", type: "submit", disabled: true }, "Submit vote");

    function update() {
      const n = Object.keys(answers).length;
      progress.textContent = `${n} of ${poll.dates.length} dates answered`;
      if (phone?.value.trim()) phone.setAttribute("aria-invalid", String(!validPhone(phone.value)));
      else phone?.removeAttribute("aria-invalid");
      submit.disabled =
        !name.value.trim() ||
        n < poll.dates.length ||
        (phone && !validPhone(phone.value)) ||
        (choice && !choice.value);
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
          const body = { name: who, answers };
          const details = [];
          if (phone) {
            body.phone = phone.value.trim();
            details.push(`phone ${body.phone}`);
          }
          if (choice) {
            body.choice = choice.value;
            details.push(`${poll.choice.label}: ${choice.value}`);
          }
          const question =
            `Submit your vote as “${who}”${details.length ? ` (${details.join(", ")})` : ""}?\n\n` +
            (phone
              ? "Votes can't be changed afterwards, and everyone with the link will see your number."
              : "Votes can't be changed afterwards.");
          if (!confirm(question)) return;
          submit.disabled = true;
          submit.textContent = "Submitting…";
          error.hidden = true;
          try {
            ({ poll } = await api(`/polls/${encodeURIComponent(id)}/votes`, body));
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
      phone
        ? h(
            "label",
            { class: "field", for: "phone" },
            h("span", { class: "label" }, "Your phone number"),
            phone,
            h(
              "span",
              { class: "fine" },
              `Everyone with the link can see and call this number until the poll is deleted on ${deletedOn}.`,
            ),
          )
        : null,
      choice
        ? h("label", { class: "field", for: "choice" }, h("span", { class: "label" }, poll.choice.label), choice)
        : null,
      h("div", {}, rows),
      error,
      h("div", { class: "actions" }, submit, progress),
      h("p", { class: "fine", style: "margin-bottom:0" }, "Votes are final: once submitted, they can't be changed."),
    );

    name.addEventListener("input", update);
    phone?.addEventListener("input", update);
    choice?.addEventListener("change", update);
    voteArea.replaceChildren(form);
    update();
  }

  // Filtered because replaceChildren would print a null as the text "null".
  app.replaceChildren(
    ...[
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
        poll.collectPhones
          ? `All polls are deleted after ${LIFETIME_MONTHS} months, or earlier if a delete-by date is set. ` +
              `This poll and everyone's phone numbers are deleted on ${deletedOn}.`
          : `All polls are deleted after ${LIFETIME_MONTHS} months. This one is deleted on ${deletedOn}.`,
      ),
    ].filter(Boolean),
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

// Same rule as the Worker: digits, spaces, dashes, parentheses, optional leading +; 6–15 digits.
function validPhone(value) {
  const phone = value.trim();
  const digits = phone.replace(/\D/g, "").length;
  return /^\+?[0-9 ()-]+$/.test(phone) && phone.length <= 30 && digits >= 6 && digits <= 15;
}

// "+46 (0)70-123 45 67" → "tel:+46701234567". The (0) trunk prefix isn't dialled
// with a country code.
function telHref(phone) {
  return `tel:${phone.replace(/\(0\)/g, "").replace(/[^+0-9]/g, "")}`;
}

function phoneIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute(
    "d",
    "M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25c1.1.37 2.3.57 3.6.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z",
  );
  svg.append(path);
  return svg;
}

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
