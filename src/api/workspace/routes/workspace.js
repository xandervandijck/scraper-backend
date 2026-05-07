'use strict';

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/workspaces',
      handler: 'workspace.list',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/workspaces',
      handler: 'workspace.create',
      config: { auth: false },
    },
  ],
};
