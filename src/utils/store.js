'use strict';

const UIDS = {
  user: 'api::app-user.app-user',
  workspace: 'api::workspace.workspace',
  list: 'api::lead-list.lead-list',
  lead: 'api::lead.lead',
  session: 'api::scrape-session.scrape-session',
};

function docs(type) {
  return strapi.documents(UIDS[type]);
}

function normalize(entry) {
  if (!entry) return null;
  return {
    ...entry,
    id: entry.documentId ?? String(entry.id),
    strapi_id: entry.id,
  };
}

async function findMany(type, options = {}) {
  const rows = await docs(type).findMany(options);
  return rows.map(normalize);
}

async function findOne(type, options = {}) {
  const rows = await findMany(type, { ...options, pagination: { page: 1, pageSize: 1 } });
  return rows[0] ?? null;
}

async function createOne(type, data) {
  return normalize(await docs(type).create({ data }));
}

async function updateOne(type, documentId, data) {
  return normalize(await docs(type).update({ documentId, data }));
}

async function deleteOne(type, documentId) {
  return normalize(await docs(type).delete({ documentId }));
}

async function requireWorkspace(workspaceId, userId) {
  const workspace = await findOne('workspace', {
    filters: {
      documentId: { $eq: workspaceId },
      user_id: { $eq: userId },
    },
  });
  if (!workspace) {
    const err = new Error('Workspace not found');
    err.status = 403;
    throw err;
  }
  return workspace;
}

async function requireList(listId, workspaceId) {
  const list = await findOne('list', {
    filters: {
      documentId: { $eq: listId },
      workspace_id: { $eq: workspaceId },
    },
  });
  if (!list) {
    const err = new Error('List not found');
    err.status = 404;
    throw err;
  }
  return list;
}

module.exports = {
  UIDS,
  findMany,
  findOne,
  createOne,
  updateOne,
  deleteOne,
  requireWorkspace,
  requireList,
};
