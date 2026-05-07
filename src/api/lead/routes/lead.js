'use strict';

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/leads',
      handler: 'lead.list',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/leads/export/:format',
      handler: 'lead.export',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/download/:format',
      handler: 'lead.export',
      config: { auth: false },
    },
  ],
};
