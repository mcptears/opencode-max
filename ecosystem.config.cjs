// pm2 process file: `pm2 start ecosystem.config.cjs` then `pm2 startup` for boot persistence.
module.exports = {
  apps: [
    {
      name: 'opencode-max',
      script: './dist/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: '8080',
      },
    },
  ],
};
