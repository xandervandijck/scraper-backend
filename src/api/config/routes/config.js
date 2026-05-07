'use strict';

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/config/sectors',
      handler: 'config.sectors',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/config/sectors',
      handler: 'config.saveSectors',
      config: { auth: false },
    },
  ],
};
