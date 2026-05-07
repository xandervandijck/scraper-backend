'use strict';

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/scrape/start',
      handler: 'scrape-session.start',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/scrape/stop',
      handler: 'scrape-session.stop',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/scrape/status',
      handler: 'scrape-session.status',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/scrape/sessions',
      handler: 'scrape-session.sessions',
      config: { auth: false },
    },
  ],
};
