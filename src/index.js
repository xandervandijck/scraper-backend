'use strict';

const wsServer = require('./utils/wsServer.js');

module.exports = {
  register() {},

  bootstrap({ strapi }) {
    // Attach WebSocket server to Strapi's HTTP server after it starts
    strapi.server.httpServer.on('listening', () => {
      wsServer.start(strapi.server.httpServer);
      strapi.log.info('WebSocket server attached to HTTP server');
    });
  },
};
