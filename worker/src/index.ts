import { DurableObject } from "cloudflare:workers";

interface Env {
  POLLS: DurableObjectNamespace<Poll>;
  ALLOWED_ORIGINS: string;
}

type Answer = "yes" | "maybe" | "no";

interface Vote {
  name: string;
  answers: Record<string, Answer>;
  createdAt: number;
}

interface PollData {
  title: string;
  dates: string[];
  phone: string | null;
  votes: Vote[];
  createdAt: number;
  expiresAt: number;
}

type VoteResult =
  | { ok: true; poll: PollData }
  | { ok: false; status: 400 | 404 | 409; error: string };

const MAX_TITLE = 200;
const MAX_NAME = 60;
const MAX_DATES = 60;
const MAX_VOTES = 200;
const MAX_PHONE = 30;
const MAX_BODY = 16_384;
// Every poll is deleted this long after it was created; polls with a phone
// number can pick an earlier delete-by date.
const LIFETIME_MONTHS = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

const ANSWERS = new Set<unknown>(["yes", "maybe", "no"]);
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// One Durable Object per poll. Votes are insert-only: there is no code path
// that updates or deletes a single vote.
export class Poll extends DurableObject<Env> {
  private migrated = false;

  async create(
    title: string,
    dates: string[],
    phone: string | null,
    createdAt: number,
    expiresAt: number,
  ): Promise<PollData> {
    const sql = this.ctx.storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS poll (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        title TEXT NOT NULL,
        dates TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        phone TEXT
      );
      CREATE TABLE IF NOT EXISTS votes (
        name TEXT PRIMARY KEY COLLATE NOCASE,
        answers TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    sql.exec(
      "INSERT INTO poll (id, title, dates, created_at, expires_at, phone) VALUES (1, ?, ?, ?, ?, ?)",
      title,
      JSON.stringify(dates),
      createdAt,
      expiresAt,
      phone,
    );
    this.migrated = true;
    await this.ctx.storage.setAlarm(expiresAt);
    return this.read();
  }

  async get(): Promise<PollData | null> {
    return (await this.live()) ? this.read() : null;
  }

  async vote(rawName: unknown, rawAnswers: unknown): Promise<VoteResult> {
    if (!(await this.live())) return { ok: false, status: 404, error: "Poll not found." };
    const poll = this.read();

    const name = typeof rawName === "string" ? rawName.trim().replace(/\s+/g, " ") : "";
    if (!name || name.length > MAX_NAME) {
      return { ok: false, status: 400, error: `Name must be 1–${MAX_NAME} characters.` };
    }
    if (
      typeof rawAnswers !== "object" ||
      rawAnswers === null ||
      Object.keys(rawAnswers).length !== poll.dates.length ||
      !poll.dates.every((d) => ANSWERS.has((rawAnswers as Record<string, unknown>)[d]))
    ) {
      return { ok: false, status: 400, error: "Answer yes, maybe or no for every date." };
    }
    if (poll.votes.length >= MAX_VOTES) {
      return { ok: false, status: 400, error: "This poll has reached its vote limit." };
    }

    const sql = this.ctx.storage.sql;
    // No await between the check and the insert, so no other request can interleave.
    if (sql.exec("SELECT 1 FROM votes WHERE name = ?", name).toArray().length > 0) {
      return {
        ok: false,
        status: 409,
        error: `Someone called “${name}” has already voted, and votes can't be changed. If that wasn't you, pick another name.`,
      };
    }
    const answers = Object.fromEntries(
      poll.dates.map((d) => [d, (rawAnswers as Record<string, Answer>)[d]]),
    );
    sql.exec(
      "INSERT INTO votes (name, answers, created_at) VALUES (?, ?, ?)",
      name,
      JSON.stringify(answers),
      Date.now(),
    );
    return { ok: true, poll: this.read() };
  }

  // Fires at the poll's expiry, whether or not anyone opens it again.
  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  // True if the poll exists and hasn't expired. An expired poll is deleted on
  // the spot, in case its alarm hasn't run yet.
  private async live(): Promise<boolean> {
    // Tables only exist once create() has run, so looking up an unknown id
    // doesn't leave an empty object behind.
    const sql = this.ctx.storage.sql;
    if (sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'poll'").toArray().length === 0) {
      return false;
    }
    this.migrate();
    const p = sql.exec<{ created_at: number; expires_at: number }>("SELECT created_at, expires_at FROM poll").one();
    // Polls created before the 6-month rule may have a later expiry.
    if (Date.now() < Math.min(p.expires_at, addMonths(p.created_at, LIFETIME_MONTHS))) return true;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return false;
  }

  // Polls created before phone numbers existed lack the column.
  private migrate(): void {
    if (this.migrated) return;
    const sql = this.ctx.storage.sql;
    const columns = sql.exec<{ name: string }>("PRAGMA table_info(poll)").toArray();
    if (!columns.some((c) => c.name === "phone")) sql.exec("ALTER TABLE poll ADD COLUMN phone TEXT");
    this.migrated = true;
  }

  private read(): PollData {
    const sql = this.ctx.storage.sql;
    const p = sql
      .exec<{ title: string; dates: string; phone: string | null; created_at: number; expires_at: number }>(
        "SELECT title, dates, phone, created_at, expires_at FROM poll",
      )
      .one();
    const votes = sql
      .exec<{ name: string; answers: string; created_at: number }>(
        "SELECT name, answers, created_at FROM votes ORDER BY created_at, rowid",
      )
      .toArray()
      .map((v) => ({ name: v.name, answers: JSON.parse(v.answers), createdAt: v.created_at }));
    return {
      title: p.title,
      dates: JSON.parse(p.dates),
      phone: p.phone,
      votes,
      createdAt: p.created_at,
      expiresAt: Math.min(p.expires_at, addMonths(p.created_at, LIFETIME_MONTHS)),
    };
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const origin = request.headers.get("Origin");
    const allowed = env.ALLOWED_ORIGINS.split(/\s+/).filter(Boolean);
    const headers: Record<string, string> = { "Cache-Control": "no-store", Vary: "Origin" };

    // Requests without an Origin (curl etc.) can't be stopped anyway; browsers on
    // other sites can.
    if (origin !== null) {
      if (!allowed.includes(origin)) return json({ error: "Origin not allowed." }, 403, headers);
      headers["Access-Control-Allow-Origin"] = origin;
    }
    if (request.method === "OPTIONS") {
      headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
      headers["Access-Control-Allow-Headers"] = "Content-Type";
      headers["Access-Control-Max-Age"] = "86400";
      return new Response(null, { status: 204, headers });
    }

    try {
      const [status, body] = await route(request, env);
      return json(body, status, headers);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status, headers);
      console.error(err);
      return json({ error: "Something went wrong." }, 500, headers);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<[number, unknown]> {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const method = request.method;

  if (parts[0] !== "polls") throw new HttpError(404, "Not found.");

  // POST /polls {title, dates, phone?, deleteAt?}
  // phone and deleteAt (epoch ms) come together; plain polls can't set a deleteAt.
  if (parts.length === 1 && method === "POST") {
    const body = await readJson(request);
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title || title.length > MAX_TITLE) {
      throw new HttpError(400, `Title must be 1–${MAX_TITLE} characters.`);
    }
    const dates = parseDates(body.dates);
    if (!dates) throw new HttpError(400, `Pick between 1 and ${MAX_DATES} valid dates.`);

    const now = Date.now();
    const maxExpiry = addMonths(now, LIFETIME_MONTHS);
    let phone: string | null = null;
    let expiresAt = maxExpiry;
    if (body.phone !== undefined || body.deleteAt !== undefined) {
      phone = parsePhone(body.phone);
      if (!phone) throw new HttpError(400, "Enter a valid phone number.");
      const deleteAt = body.deleteAt;
      // A day of slack: the browser sends local midnight, which can land just
      // past the cap across a daylight-saving change.
      if (typeof deleteAt !== "number" || !(deleteAt > now && deleteAt <= maxExpiry + DAY_MS)) {
        throw new HttpError(400, `Pick a delete-by date within the next ${LIFETIME_MONTHS} months.`);
      }
      expiresAt = Math.min(deleteAt, maxExpiry);
    }

    const id = newId();
    const poll = await env.POLLS.getByName(id).create(title, dates, phone, now, expiresAt);
    return [201, { id, poll }];
  }

  const id = parts[1];
  if (!ID_RE.test(id)) throw new HttpError(404, "Poll not found.");
  const stub = env.POLLS.getByName(id);

  // GET /polls/:id
  if (parts.length === 2 && method === "GET") {
    const poll = await stub.get();
    if (!poll) throw new HttpError(404, "Poll not found.");
    return [200, { poll }];
  }

  // POST /polls/:id/votes {name, answers}
  if (parts.length === 3 && parts[2] === "votes" && method === "POST") {
    const body = await readJson(request);
    const result = await stub.vote(body.name, body.answers);
    if (!result.ok) throw new HttpError(result.status, result.error);
    return [201, { poll: result.poll }];
  }

  throw new HttpError(404, "Not found.");
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY) {
    throw new HttpError(413, "Request too large.");
  }
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "Request too large.");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "Expected a JSON object.");
  }
  return body as Record<string, unknown>;
}

// Returns sorted, de-duplicated YYYY-MM-DD strings, or null if anything is off.
function parseDates(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_DATES) return null;
  const dates = new Set<string>();
  for (const d of value) {
    if (typeof d !== "string" || !DATE_RE.test(d)) return null;
    const t = new Date(`${d}T00:00:00Z`);
    if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== d) return null;
    dates.add(d);
  }
  return [...dates].sort();
}

// Digits, spaces, dashes, parentheses and an optional leading +; 6–15 digits
// (the E.164 maximum). Returned as typed, tidied.
function parsePhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const phone = value.trim().replace(/\s+/g, " ");
  const digits = phone.replace(/\D/g, "").length;
  const ok = /^\+?[0-9 ()-]+$/.test(phone) && phone.length <= MAX_PHONE && digits >= 6 && digits <= 15;
  return ok ? phone : null;
}

function addMonths(ms: number, months: number): number {
  const d = new Date(ms);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.getTime();
}

// 128 random bits, base64url: 22 characters.
function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return Response.json(body, { status, headers });
}
