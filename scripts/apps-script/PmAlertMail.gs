/**
 * Fildi PM alerts → email to yourself (phone gets a normal Mail/Gmail notification; no extra app).
 * Called by scripts/watchlist_sync/pm_alerts.py with {secret, subject, body}.
 *
 * One-time setup (≈2 min):
 *  1. script.google.com → New project → paste this file.
 *  2. Project Settings → Script properties → add PM_ALERT_SECRET = any long random string.
 *  3. Deploy → New deployment → Web app · Execute as: Me · Who has access: Anyone → copy the /exec URL.
 *  4. In fildi/.env.local: PM_ALERT_WEBHOOK=<that URL> and PM_ALERT_SECRET=<same string>.
 * The recipient is the script owner's own address (never sent by fildi). Without the secret the endpoint does nothing.
 */
function doPost(e) {
  var data = {};
  try { data = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false }); }
  var secret = PropertiesService.getScriptProperties().getProperty('PM_ALERT_SECRET');
  if (!secret || data.secret !== secret) return out_({ ok: false });
  var subject = String(data.subject || '[Fildi PM] alert').slice(0, 200);
  var body = String(data.body || '').slice(0, 5000);
  MailApp.sendEmail(Session.getEffectiveUser().getEmail(), subject, body);
  return out_({ ok: true });
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
