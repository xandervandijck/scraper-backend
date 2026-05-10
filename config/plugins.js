'use strict';

module.exports = ({ env }) => {
  const acl = (env('DO_SPACE_ACL', '') ?? '').trim();

  return {
    upload: {
      config: {
        provider: 'aws-s3',
        providerOptions: {
          baseUrl: env('DO_SPACE_CDN'),
          rootPath: env('DO_SPACE_DIRECTORY', ''),
          s3Options: {
            credentials: {
              accessKeyId: env('DO_SPACE_ACCESS_KEY'),
              secretAccessKey: env('DO_SPACE_SECRET_KEY'),
            },
            region: env('DO_SPACE_REGION', 'fra1'),
            endpoint: env('DO_SPACE_ENDPOINT'),
            params: {
              ACL: acl || undefined,
              Bucket: env('DO_SPACE_BUCKET'),
            },
          },
        },
        actionOptions: {
          upload: {},
          uploadStream: {},
          delete: {},
        },
      },
    },
  };
};
