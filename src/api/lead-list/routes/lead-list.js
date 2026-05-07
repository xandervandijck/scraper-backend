'use strict';

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/lists',
      handler: 'lead-list.list',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/lists',
      handler: 'lead-list.create',
      config: { auth: false },
    },
    {
      method: 'DELETE',
      path: '/lists/:id',
      handler: 'lead-list.remove',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/lists/:id/extend',
      handler: 'lead-list.extend',
      config: { auth: false },
    },
  ],
};
