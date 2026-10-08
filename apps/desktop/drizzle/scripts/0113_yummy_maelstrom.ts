function run(db) {
  db.prepare(`
    UPDATE shared_task_events
    SET closure_token = recorded_at,
        recorded_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
    WHERE kind = 'local-close'
      AND revision = 0
      AND closure_token IS NULL
      AND typeof(recorded_at) = 'text'
  `).run();
}

module.exports = { run };
