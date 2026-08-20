module.exports = {
  apps: [
    {
      name: 'flight-service',
      script: './src/server.js',
      instances: 1,
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        PORT: 3003,
        ANTHROPIC_API_KEY: '${ANTHROPIC_API_KEY}'
      },
      env_development: {
        NODE_ENV: 'development',
        PORT: 3003
      },
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      watch: false,
      ignore_watch: ['node_modules', 'logs'],
      max_restarts: 10,
      min_uptime: '10s',
      max_memory_restart: '500M',
      kill_timeout: 5000
    }
  ]
};
