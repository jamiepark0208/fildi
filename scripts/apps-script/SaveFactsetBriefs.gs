/**
 * TradeDash Desk Ingest — Gmail → Drive (JSON only, multi-account)
 *
 * Banner (Executions): [usc_v2] or [personal_v2] — account + script revision.
 *   If you do NOT see that tag, Code.gs is stale / wrong project.
 *
 * Trigger (each account): every 15 min → saveFactsetBriefs or saveDeskBriefs
 *
 * Every run automatically:
 *   1) trashes .eml when a same-stem .json exists (legacy dual-write cleanup)
 *   2) prunes Drive files older than RETENTION_DAYS
 *   3) saves new labeled mail as ONE .json each (no .eml)
 *
 * v2: label-ONLY query (no FactSet OR), captures HTML + outbound links.
 * Optional Script Property ACCOUNT_TAG=usc|personal if Session email is blank.
 *
 * Multi-account → SAME shared folder "TradeDash Briefs".
 */

var SCRIPT_REV = 'v2'; // bump only on breaking file-format changes
var LABEL_NAME = 'tradedash-brief';
var SAVED_LABEL = 'tradedash-brief/saved';
var FOLDER_NAME = 'TradeDash Briefs';
var MAX_THREADS = 60;
var MAX_RUNTIME_MS = 4.5 * 60 * 1000;
var NEWER_THAN = '3d';
var RETENTION_DAYS = 21;
var BODY_PLAIN_MAX = 12000;
var BODY_HTML_MAX = 20000;
var MAX_LINKS = 40;

function saveDeskBriefs() {
  runNewMailIngest_('saveDeskBriefs');
}

function saveFactsetBriefs() {
  runNewMailIngest_('saveFactsetBriefs');
}

function runNewMailIngest_(entryName) {
  var t0 = Date.now();
  var account = accountTag_();
  var banner = account + '_' + SCRIPT_REV;
  PropertiesService.getScriptProperties().deleteProperty('threadStart');

  ensureLabels_();
  var folder = getOrCreateFolder_(FOLDER_NAME);
  var briefLabel = GmailApp.getUserLabelByName(LABEL_NAME);
  var savedLabel = GmailApp.getUserLabelByName(SAVED_LABEL);

  var dupEml = trashDuplicateEmls_(folder);
  var pruned = pruneOldFiles_(folder, RETENTION_DAYS);

  var query = buildNewMailQuery_();
  console.log(
    '[' + banner + '] entry=' + entryName +
      ' account=' + account +
      ' dupEmlTrashed=' + dupEml +
      ' pruned=' + pruned +
      ' query=' + query
  );

  var existingNames = listFileNames_(folder);
  var threads = GmailApp.search(query, 0, MAX_THREADS);
  if (!threads.length) {
    console.log('[' + banner + '] No new desk mail (ok, empty).');
    return;
  }

  var saved = 0;
  var skipped = 0;
  var bySource = {};

  for (var i = 0; i < threads.length; i++) {
    if (Date.now() - t0 >= MAX_RUNTIME_MS) {
      console.log('[' + banner + '] runtime cap — continue next trigger');
      break;
    }
    var thread = threads[i];
    var messages = thread.getMessages();
    for (var j = 0; j < messages.length; j++) {
      if (Date.now() - t0 >= MAX_RUNTIME_MS) break;
      var message = messages[j];
      var subject = message.getSubject() || '';
      var from = message.getFrom() || '';
      var source = detectSource_(subject, from);
      var parsed = parseMessage_(message, source, account, banner);
      var base = buildBaseName_(parsed, account);
      var jsonName = base + '.json';

      if (hasGmailId_(existingNames, parsed.gmailMessageId) || existingNames[jsonName]) {
        skipped++;
      } else {
        folder.createFile(
          Utilities.newBlob(JSON.stringify(parsed, null, 2), 'application/json', jsonName)
        );
        existingNames[jsonName] = true;
        saved++;
        bySource[source] = (bySource[source] || 0) + 1;
      }
    }
    thread.addLabel(briefLabel);
    thread.addLabel(savedLabel);
  }

  console.log(
    '[' + banner + '] done threads=' + threads.length +
      ' saved=' + saved + ' skipped=' + skipped +
      ' bySource=' + JSON.stringify(bySource)
  );
}

/** usc | personal | Script Property override | sanitized local-part */
function accountTag_() {
  try {
    var override = PropertiesService.getScriptProperties().getProperty('ACCOUNT_TAG');
    if (override) {
      var o = String(override).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 16);
      if (o) return o;
    }
  } catch (e0) {}

  var email = '';
  try {
    email = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  } catch (e) {}
  if (!email) {
    try {
      email = String(Session.getActiveUser().getEmail() || '').toLowerCase();
    } catch (e2) {}
  }
  if (email.indexOf('@usc.edu') >= 0 || email === 'parkjami@usc.edu') return 'usc';
  if (email === 'jamiepark0208@gmail.com') return 'personal';
  var local = (email.split('@')[0] || '').replace(/[^a-z0-9]+/g, '');
  if (local) return local.slice(0, 16);
  return 'desk';
}

/** Label-only — intentional inbox. No FactSet OR (avoids unlabeled noise). */
function buildNewMailQuery_() {
  return 'label:' + LABEL_NAME + ' newer_than:' + NEWER_THAN + ' -label:' + SAVED_LABEL;
}

function detectSource_(subject, from) {
  var s = String(subject || '').toLowerCase();
  var f = String(from || '').toLowerCase();
  if (f.indexOf('factset') >= 0 || s.indexOf('streetaccount') >= 0) return 'factset';
  if (f.indexOf('seekingalpha') >= 0 || f.indexOf('seekingalpha.com') >= 0) return 'seekingalpha';
  if (f.indexOf('bloomberg') >= 0) return 'bloomberg';
  if (f.indexOf('axios') >= 0) return 'axios';
  if (f.indexOf('zerohedge') >= 0) return 'zerohedge';
  if (f.indexOf('tipranks') >= 0) return 'tipranks';
  if (f.indexOf('finimize') >= 0) return 'finimize';
  if (f.indexOf('thedailyupside') >= 0 || f.indexOf('dailyupside') >= 0) return 'thedailyupside';
  if (f.indexOf('beehiiv') >= 0) return 'beehiiv';
  var m = f.match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
  if (m) {
    var host = m[1].toLowerCase()
      .replace(/^mail\./, '')
      .replace(/^email\./, '')
      .replace(/^news\./, '')
      .replace(/^click\./, '')
      .replace(/^link\./, '');
    var parts = host.split('.');
    if (parts.length >= 2) {
      var slug = parts[parts.length - 2].replace(/[^a-z0-9]+/g, '');
      if (slug) return slug.slice(0, 24);
    }
  }
  return 'desk';
}

function fromDomain_(from) {
  var m = String(from || '').match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
  if (!m) return null;
  return m[1].toLowerCase()
    .replace(/^mail\./, '')
    .replace(/^email\./, '')
    .replace(/^news\./, '');
}

function parseMessage_(message, source, account, banner) {
  var subject = message.getSubject() || '';
  var receivedAt = message.getDate();
  var from = message.getFrom() || '';
  var plain = message.getPlainBody() || '';
  var html = '';
  try {
    html = message.getBody() || '';
  } catch (e) {
    html = '';
  }

  var outboundLinks = extractLinks_(html, plain);

  return {
    parserVersion: 2,
    source: source,
    account: account,
    script: banner,
    kind: classifyKind_(subject, source),
    gmailMessageId: message.getId(),
    subject: subject,
    from: from,
    fromDomain: fromDomain_(from),
    receivedAt: receivedAt.toISOString(),
    ingestedAt: new Date().toISOString(),
    tickersMentioned: extractTickers_(plain + ' ' + subject),
    synopsis: extractSynopsis_(plain, subject),
    bodyPlain: plain.slice(0, BODY_PLAIN_MAX),
    bodyHtml: html.slice(0, BODY_HTML_MAX),
    outboundLinks: outboundLinks,
  };
}

function classifyKind_(subject, source) {
  var s = String(subject || '').toLowerCase();
  if (/subscribed|welcome to|congratulations on your subscription/i.test(s)) return 'promo';
  if (source === 'factset' || s.indexOf('streetaccount') >= 0) {
    if (s.indexOf('overnight') >= 0) return 'us_overnight';
    if (s.indexOf('market recap') >= 0) return 'us_market_recap';
    if (s.indexOf('politics') >= 0) return 'politics';
    if (s.indexOf('sector') >= 0 && s.indexOf('consumer') >= 0) return 'sector_consumer';
    if (s.indexOf('sector') >= 0 && s.indexOf('energy') >= 0) return 'sector_energy';
    if (s.indexOf('sector') >= 0 && s.indexOf('techno') >= 0) return 'sector_technology';
    if (s.indexOf('oil') >= 0) return 'macro_oil';
    if (s.indexOf('week ahead') >= 0) return 'us_week_ahead';
    if (s.indexOf('weekend') >= 0) return 'us_week_ahead';
    if (s.indexOf('watchlist') >= 0) return 'morning_watchlist';
  }
  return source || 'other';
}

function extractSynopsis_(plain, subject) {
  var m = String(plain || '').match(
    /Synopsis:([\s\S]{0,800}?)(?:Notable|Market Summary|Commodities|Intraday|$)/i
  );
  if (m) return m[1].replace(/\s+/g, ' ').trim().slice(0, 600);
  // Strip USC Proofpoint banner noise from head
  var cleaned = String(plain || '')
    .replace(/ZjQcmQRYFpfptBannerStart[\s\S]*?ZjQcmQRYFpfptBannerEnd/gi, ' ')
    .replace(/External Sender[\s\S]{0,400}?Report Suspicious[^\n]*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return String(subject || '').slice(0, 200);
  return cleaned.slice(0, 400);
}

function extractTickers_(text) {
  var out = {};
  var stop = {
    US: 1, SA: 1, AM: 1, PM: 1, ET: 1, EST: 1, EDT: 1, PT: 1, PST: 1, PDT: 1, UTC: 1,
    CEO: 1, CFO: 1, IPO: 1, ETF: 1, GDP: 1, CPI: 1, FED: 1, FDA: 1, SEC: 1, AI: 1, EV: 1,
    UK: 1, EU: 1, EWT: 1, HTTP: 1, HTTPS: 1, WWW: 1,
  };
  var re = /\b([A-Z]{1,5})(?:\s*\(|\s+--|\/)/g;
  var m;
  while ((m = re.exec(text)) !== null) {
    var t = m[1];
    if (!stop[t]) out[t] = true;
  }
  return Object.keys(out).slice(0, 40);
}

function extractLinks_(html, plain) {
  var seen = {};
  var out = [];
  var sources = [String(html || ''), String(plain || '')];
  for (var s = 0; s < sources.length; s++) {
    var text = sources[s];
    var re = /https?:\/\/[^\s"'<>\)\]]+/gi;
    var m;
    while ((m = re.exec(text)) !== null && out.length < MAX_LINKS) {
      var raw = m[0].replace(/[.,;:]+$/, '');
      if (seen[raw]) continue;
      seen[raw] = true;
      var host = '';
      try {
        host = raw.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
      } catch (e) {}
      out.push({
        url: raw,
        text: '',
        host: host,
        kindHint: hintLinkKind_(raw, host),
      });
    }
  }
  return out;
}

function hintLinkKind_(url, host) {
  var u = String(url || '').toLowerCase();
  var h = String(host || '').toLowerCase();
  if (/unsubscribe|pref(?:erence)?s?|email-settings|manage.?subscription|opt.?out/i.test(u)) return 'unsubscribe';
  if (/phishalarm|proofpoint\.com\/ewt|safelinks\.protection/i.test(u)) return 'tracking';
  if (/urldefense\.com|click\d*\.email\.|link\.(axios|finimize)/i.test(h)) return 'tracking';
  if (/twitter\.com|x\.com|facebook\.com|linkedin\.com|instagram\.com|youtube\.com/i.test(h)) return 'social';
  if (/account\/newsletters|subscribe|welcome/i.test(u)) return 'promo';
  return 'content';
}

/** yyyy-MM-dd_HHmm-{account}-{source}-{gmailId}-{subj} */
function buildBaseName_(parsed, account) {
  var d = new Date(parsed.receivedAt);
  var ymd = Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd_HHmm');
  var subj = String(parsed.subject || parsed.source || 'desk')
    .replace(/[^\w.\-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return ymd + '-' + account + '-' + parsed.source + '-' + parsed.gmailMessageId + '-' + subj;
}

function ensureLabels_() {
  if (!GmailApp.getUserLabelByName(LABEL_NAME)) GmailApp.createLabel(LABEL_NAME);
  if (!GmailApp.getUserLabelByName(SAVED_LABEL)) GmailApp.createLabel(SAVED_LABEL);
}

function getOrCreateFolder_(name) {
  var it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

function listFileNames_(folder) {
  var out = {};
  var it = folder.getFiles();
  while (it.hasNext()) out[it.next().getName()] = true;
  return out;
}

function hasGmailId_(nameMap, gmailId) {
  if (!gmailId) return false;
  var needle = '-' + gmailId + '-';
  for (var name in nameMap) {
    if (Object.prototype.hasOwnProperty.call(nameMap, name) && name.indexOf(needle) >= 0) return true;
  }
  return false;
}

function pruneOldFiles_(folder, retentionDays) {
  var cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  var it = folder.getFiles();
  var n = 0;
  while (it.hasNext()) {
    var f = it.next();
    var name = f.getName();
    if (!/\.(eml|json)$/i.test(name)) continue;
    try {
      if (f.getDateCreated().getTime() < cutoff) {
        f.setTrashed(true);
        n++;
      }
    } catch (e) {}
  }
  return n;
}

function trashDuplicateEmls_(folder) {
  var names = listFileNames_(folder);
  var trashed = 0;
  for (var name in names) {
    if (!Object.prototype.hasOwnProperty.call(names, name)) continue;
    if (!/\.eml$/i.test(name)) continue;
    var stem = name.replace(/\.eml$/i, '');
    if (!names[stem + '.json']) continue;
    var it = folder.getFilesByName(name);
    while (it.hasNext()) {
      it.next().setTrashed(true);
      trashed++;
    }
  }
  return trashed;
}
