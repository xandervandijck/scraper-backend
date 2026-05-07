'use strict';

module.exports = {
  routes: [
    {
      method: 'POST',
      path: '/auth/register',
      handler: 'app-user.register',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/auth/login',
      handler: 'app-user.login',
      config: { auth: false },
    },
  ],
};
