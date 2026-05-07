'use strict';

const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');

let wss = null;

// workspaceId → Set of authenticated WebSocket clients
const rooms = new Map();

function getRoom(workspaceId) {
  if (!rooms.has(workspaceId)) rooms.set(workspaceId, new Set());
  return rooms.get(workspaceId);
}

function broadcast(workspaceId, type, payload) {
  const room = rooms.get(workspaceId);
  if (!room) return;
  const msg = JSON.stringify({ type, payload });
  for (const ws of room) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function start(httpServer) {
  wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    ws.authenticated = false;

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'auth') {
          const payload = jwt.verify(msg.token, process.env.JWT_SECRET);
          ws.userId = payload.sub;
          ws.authenticated = true;
          ws.send(JSON.stringify({ type: 'auth_ok' }));
        } else if (msg.type === 'subscribe' && ws.authenticated) {
          // subscribe to a workspace room
          ws.workspaceId = msg.workspaceId;
          getRoom(msg.workspaceId).add(ws);
          ws.send(JSON.stringify({ type: 'subscribed', workspaceId: msg.workspaceId }));
        }
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'auth_failed' }));
        ws.close();
      }
    });

    ws.on('close', () => {
      if (ws.workspaceId) {
        rooms.get(ws.workspaceId)?.delete(ws);
      }
    });
  });

  return wss;
}

module.exports = { start, broadcast };
