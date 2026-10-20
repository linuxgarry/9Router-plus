import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function rowToSub(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    url: row.url,
    name: row.name,
    enabled: row.enabled === 1 || row.enabled === true,
    nodeCount: row.nodeCount || 0,
    lastLoadedAt: row.lastLoadedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function subToRow(s) {
  const { id, url, name, enabled, nodeCount, lastLoadedAt, createdAt, updatedAt, ...rest } = s;
  return {
    id,
    url,
    name,
    enabled: enabled === false ? 0 : 1,
    nodeCount: nodeCount || 0,
    lastLoadedAt,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
  };
}

function upsert(db, s) {
  const r = subToRow(s);
  db.run(
    `INSERT INTO clashSubscriptions(id, url, name, enabled, nodeCount, lastLoadedAt, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       url=excluded.url, name=excluded.name, enabled=excluded.enabled,
       nodeCount=excluded.nodeCount, lastLoadedAt=excluded.lastLoadedAt,
       data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.url, r.name, r.enabled, r.nodeCount, r.lastLoadedAt, r.data, r.createdAt, r.updatedAt]
  );
}

export async function getClashSubscriptions(filter = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.enabled !== undefined) {
    where.push("enabled = ?");
    params.push(filter.enabled ? 1 : 0);
  }
  const sql = `SELECT * FROM clashSubscriptions${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  const list = db.all(sql, params).map(rowToSub);
  list.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  return list;
}

export async function getClashSubscriptionById(id) {
  const db = await getAdapter();
  return rowToSub(db.get(`SELECT * FROM clashSubscriptions WHERE id = ?`, [id]));
}

export async function createClashSubscription(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const sub = {
    id: data.id || uuidv4(),
    url: data.url,
    name: data.name || new URL(data.url).hostname,
    enabled: data.enabled !== undefined ? data.enabled : true,
    nodeCount: 0,
    lastLoadedAt: null,
    rawYaml: data.rawYaml || "",
    createdAt: now,
    updatedAt: now,
  };
  upsert(db, sub);
  return sub;
}

export async function updateClashSubscription(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM clashSubscriptions WHERE id = ?`, [id]);
    if (!row) return;
    const merged = {
      ...rowToSub(row),
      ...data,
      updatedAt: new Date().toISOString(),
    };
    upsert(db, merged);
    result = merged;
  });
  return result;
}

export async function deleteClashSubscription(id) {
  const db = await getAdapter();
  let removed = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM clashSubscriptions WHERE id = ?`, [id]);
    if (!row) return;
    removed = rowToSub(row);
    db.run(`DELETE FROM clashSubscriptions WHERE id = ?`, [id]);
  });
  return removed;
}
