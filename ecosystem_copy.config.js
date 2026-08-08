module.exports = {
  apps : [{
    name: "OPS-Dashboard",
      script: "server/index.js",
      cwd: __dirname,                              // anchor relative paths (.vibe/, prompts/, skills/)
      node_args: "--env-file-if-exists=.env",      // mirror what `npm start` does
      exec_mode: "fork",                           // SQLite (better-sqlite3) is single-process; do not cluster
      instances: 1,
      autorestart: true,
      watch: false,                                // PM2's watch fights node --watch; leave off in prod
      max_memory_restart: "1G",
      kill_timeout: 5000,                          // give gracefulShutdown() time to drain active tasks
      env: {
        NODE_ENV: "production",
        // Anything you'd rather set here than in .env can live here:
        // PORT: 3001,
        // ALLOWED_BASE_PATHS: "/home/me/projects",
      }
  }]
};
