/**
 * Google Workspace -> ActivityInfo user sync.
 *
 * Reads the Google Workspace directory with the Admin SDK and provisions / de-provisions the
 * matching ActivityInfo accounts through ActivityInfo's SCIM 2.0 endpoint:
 *
 *   - Active Google users in scope are provisioned (POST /Users, which ActivityInfo treats as an
 *     upsert keyed on email address, and which also updates the name and re-activates a previously
 *     de-provisioned user).
 *   - Suspended and archived Google users in scope, and users deleted within the last 20 days, are
 *     looked up in ActivityInfo and de-provisioned (PATCH active=false) if still active there.
 *
 * The script keeps no record of what it synced: every run works from what the directory reports.
 * This has two consequences. Users deleted more than 20 days ago are no longer reported by Google,
 * so they are only de-provisioned if a run sees them within that window. And a user removed from
 * GROUP (or from DOMAINS) while still active in Google is simply no longer synced; they are not
 * de-provisioned.
 *
 * Every run sends one request per user, so the trigger runs every few hours rather than hourly.
 * A run that hits the Apps Script time limit stores how far it got in the SYNC_CURSOR script
 * property, and the next run continues from there.
 *
 * Configuration lives in Script Properties (Project Settings > Script Properties):
 *
 *   SCIM_BASE_URL             required, e.g. https://www.activityinfo.org/resources/billingAccounts/1234/scim/v2
 *   SCIM_TOKEN                required, the SCIM token generated for the billing account
 *   DOMAINS                   optional, comma-separated email domains to sync (default: all)
 *   GROUP                     optional, email of a group whose members (including nested groups) are synced
 *   NOTIFY_EMAIL              optional, address for failure notifications (default: the script's user)
 *
 * Entry points: setup() (checks configuration and installs the trigger), dryRun(), sync() (what
 * the trigger runs) and testConnection().
 */

const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const SCIM_CONTENT_TYPE = 'application/scim+json';

/** Script property holding the position in the sorted user list where the next run resumes. */
const CURSOR_PROPERTY = 'SYNC_CURSOR';

/** Number of users whose SCIM requests are sent in parallel with UrlFetchApp.fetchAll. */
const BATCH_SIZE = 20;

/**
 * Apps Script stops executions after 6 minutes. The sync stops issuing requests after this budget
 * and records its position; the next run continues from there.
 */
const TIME_BUDGET_MS = 4.5 * 60 * 1000;

/**
 * Hours between scheduled syncs. Each run sends a request for every user in scope, and Apps
 * Script allows a Workspace account 100,000 outbound requests a day.
 */
const SYNC_INTERVAL_HOURS = 4;

const SYNC_HANDLER = 'sync';

/** Runs a sync. This is the function the trigger calls. */
function sync() {
  run_(false);
}

/** Logs what sync() would change, without changing anything in ActivityInfo. */
function dryRun() {
  run_(true);
}

/** Checks that the SCIM URL and token are accepted by ActivityInfo. */
function testConnection() {
  const config = readConfig_();
  const response = UrlFetchApp.fetch(config.baseUrl + '/ServiceProviderConfig', scimRequest_(config, 'get', ''));
  const status = response.getResponseCode();
  if (status !== 200) {
    throw new Error('ActivityInfo returned HTTP ' + status + ': ' + response.getContentText());
  }
  console.log('Connected to ActivityInfo SCIM endpoint at ' + config.baseUrl);
}

/** Validates the configuration and (re)installs the sync trigger. */
function setup() {
  ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
  testConnection();
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === SYNC_HANDLER)
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger(SYNC_HANDLER).timeBased().everyHours(SYNC_INTERVAL_HOURS).create();
  console.log('Installed a trigger running ' + SYNC_HANDLER + '() every ' + SYNC_INTERVAL_HOURS + ' hours.');
}

function run_(dryRun) {
  // Google's consent screen lets the user grant only some of the requested permissions. Fail
  // up front, with Google's own prompt to grant the rest, rather than part-way through a sync.
  ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    console.warn('Another sync is still running; skipping this run.');
    return;
  }
  let config;
  try {
    config = readConfig_();
    const report = new SyncRun_(config, dryRun).execute();
    console.log(report.summary());
    if (report.errors.length > 0 && !dryRun) {
      notify_(config, 'ActivityInfo user sync completed with errors', report.summary());
    }
  } catch (e) {
    console.error(e);
    if (config) {
      notify_(config, 'ActivityInfo user sync failed', String(e && e.stack || e));
    }
    throw e;
  } finally {
    lock.releaseLock();
  }
}

/**
 * A single sync run: lists the users in scope, then provisions the active ones and de-provisions
 * the inactive ones in batches, until the list or the time budget runs out.
 */
class SyncRun_ {
  constructor(config, dryRun) {
    this.config = config;
    this.dryRun = dryRun;
    this.deadline = Date.now() + TIME_BUDGET_MS;
    this.errors = [];
    this.counts = { provisioned: 0, deprovisioned: 0, unchanged: 0 };
    this.incomplete = false;
  }

  execute() {
    const work = this.listWork_();

    // Guard against a directory query that silently returns nothing (wrong DOMAINS or GROUP, API
    // hiccup): there would be nothing to provision, and it most likely indicates a problem.
    if (!work.some(item => item.user)) {
      throw new Error('The directory returned no active users in scope; refusing to sync. '
        + 'Check the DOMAINS and GROUP script properties.');
    }

    const properties = PropertiesService.getScriptProperties();
    let cursor = this.dryRun ? 0 : parseInt(properties.getProperty(CURSOR_PROPERTY) || '0', 10);
    if (!(cursor < work.length)) {
      cursor = 0;
    }
    while (cursor < work.length && Date.now() < this.deadline) {
      const batch = work.slice(cursor, cursor + BATCH_SIZE);
      this.syncBatch_(batch);
      cursor += batch.length;
    }
    this.incomplete = cursor < work.length;
    if (!this.dryRun) {
      properties.setProperty(CURSOR_PROPERTY, String(this.incomplete ? cursor : 0));
    }
    return this;
  }

  /**
   * Returns the users to sync, sorted by email so that a run cut short by the time limit can be
   * resumed by position: {@code { email, user }} where {@code user} holds the name to provision,
   * or is null for users to de-provision.
   */
  listWork_() {
    const members = this.config.group ? listGroupMembers_(this.config.group) : null;
    const work = new Map();
    listDirectoryUsers_(false)
      .filter(user => inScope_(this.config, members, user))
      .forEach(user => {
        const entry = toDirectoryEntry_(user);
        work.set(user.primaryEmail.toLowerCase(), entry.active ? entry : null);
      });

    // Users deleted within the last 20 days. Deleted users lose their group memberships, so only
    // DOMAINS applies to them. An address that has been re-used by a new account is listed above
    // as well, and that entry wins.
    listDirectoryUsers_(true)
      .filter(user => inScope_(this.config, null, user))
      .map(user => user.primaryEmail.toLowerCase())
      .filter(email => !work.has(email))
      .forEach(email => work.set(email, null));

    return [...work.keys()].sort().map(email => ({ email: email, user: work.get(email) }));
  }

  syncBatch_(batch) {
    this.provision_(batch.filter(item => item.user));
    this.deprovision_(batch.filter(item => !item.user).map(item => item.email));
  }

  provision_(items) {
    if (this.dryRun) {
      items.forEach(item => console.log('Would provision ' + item.email));
      this.counts.provisioned += items.length;
      return;
    }
    this.fetchAll_(items.map(item => scimRequest_(this.config, 'post', '/Users', toScimUser_(item.email, item.user))))
      .forEach((response, i) => {
        const email = items[i].email;
        if (response.status === 200 || response.status === 201) {
          this.counts.provisioned++;
        } else if (response.status === 403) {
          this.errors.push('Could not provision ' + email + ': its email domain is not associated with the '
            + 'ActivityInfo billing account. Exclude it with DOMAINS, or ask ActivityInfo support to add the domain.');
        } else {
          this.errors.push('Could not provision ' + email + ': HTTP ' + response.status + ' ' + errorDetail_(response.body));
        }
      });
  }

  /** Looks up each user in ActivityInfo and de-provisions those that are still active there. */
  deprovision_(emails) {
    const active = [];
    this.fetchAll_(emails.map(email =>
      scimRequest_(this.config, 'get', '/Users?filter=' + encodeURIComponent('userName eq "' + email + '"'))))
      .forEach((response, i) => {
        const email = emails[i];
        if (response.status !== 200) {
          this.errors.push('Lookup of ' + email + ' failed: HTTP ' + response.status + ' ' + errorDetail_(response.body));
          return;
        }
        const found = (response.body.Resources || [])[0];
        if (found && found.active) {
          active.push({ email: email, id: found.id });
        } else {
          this.counts.unchanged++;
        }
      });

    if (this.dryRun) {
      active.forEach(user => console.log('Would de-provision ' + user.email));
      this.counts.deprovisioned += active.length;
      return;
    }
    const patch = {
      schemas: [SCIM_PATCH_SCHEMA],
      Operations: [{ op: 'replace', path: 'active', value: false }],
    };
    this.fetchAll_(active.map(user => scimRequest_(this.config, 'patch', '/Users/' + encodeURIComponent(user.id), patch)))
      .forEach((response, i) => {
        if (response.status === 200 || response.status === 204) {
          this.counts.deprovisioned++;
        } else if (response.status === 404) {
          // The account was removed from ActivityInfo between the lookup and the update.
          this.counts.unchanged++;
        } else {
          this.errors.push('Could not de-provision ' + active[i].email + ': HTTP ' + response.status + ' '
            + errorDetail_(response.body));
        }
      });
  }

  /**
   * Sends the requests in parallel and returns {@code { status, body }} for each. Any 401 aborts
   * the run, since every remaining request would fail the same way.
   */
  fetchAll_(requests) {
    if (requests.length === 0) {
      return [];
    }
    return UrlFetchApp.fetchAll(requests).map(response => {
      const status = response.getResponseCode();
      if (status === 401) {
        throw new Error('ActivityInfo rejected the SCIM token (HTTP 401). SCIM tokens expire after at most '
          + '183 days: generate a new one and update the SCIM_TOKEN script property.');
      }
      return { status: status, body: parseJson_(response.getContentText()) };
    });
  }

  summary() {
    const lines = [
      (this.dryRun ? '[DRY RUN] ' : '') + 'ActivityInfo user sync: '
        + this.counts.provisioned + ' provisioned, '
        + this.counts.deprovisioned + ' de-provisioned, '
        + this.counts.unchanged + ' already inactive or without an account, '
        + this.errors.length + ' errors.',
    ];
    if (this.incomplete) {
      lines.push('The run hit its time limit; the remaining users will be synced on the next run.');
    }
    return lines.concat(this.errors).join('\n');
  }
}

function readConfig_() {
  const props = PropertiesService.getScriptProperties();
  const baseUrl = (props.getProperty('SCIM_BASE_URL') || '').trim().replace(/\/+$/, '');
  const token = (props.getProperty('SCIM_TOKEN') || '').trim();
  if (!baseUrl || !token) {
    throw new Error('Set the SCIM_BASE_URL and SCIM_TOKEN script properties first.');
  }
  return {
    baseUrl: baseUrl,
    token: token,
    domains: (props.getProperty('DOMAINS') || '').split(',')
      .map(domain => domain.trim().toLowerCase())
      .filter(domain => domain.length > 0),
    group: (props.getProperty('GROUP') || '').trim().toLowerCase(),
    notifyEmail: props.getProperty('NOTIFY_EMAIL') || Session.getEffectiveUser().getEmail(),
  };
}

/**
 * Lists every user in the Google Workspace account, or with {@code deleted} set, the users deleted
 * within the last 20 days.
 */
function listDirectoryUsers_(deleted) {
  const users = [];
  let pageToken;
  do {
    const params = {
      customer: 'my_customer',
      maxResults: 500,
      fields: 'nextPageToken,users(primaryEmail,name/fullName,name/givenName,name/familyName,suspended,archived)',
    };
    if (pageToken) {
      params.pageToken = pageToken;
    }
    if (deleted) {
      params.showDeleted = 'true';
    }
    const page = AdminDirectory.Users.list(params);
    (page.users || []).forEach(user => users.push(user));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return users;
}

/** Returns the lower-case email addresses of the users in a group, including nested groups. */
function listGroupMembers_(groupKey) {
  const members = new Set();
  let pageToken;
  do {
    const params = { maxResults: 200, includeDerivedMembership: true };
    if (pageToken) {
      params.pageToken = pageToken;
    }
    const page = AdminDirectory.Members.list(groupKey, params);
    (page.members || [])
      .filter(member => member.type === 'USER' && member.email)
      .forEach(member => members.add(member.email.toLowerCase()));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return members;
}

/**
 * Whether a directory user's email domain is in the configured DOMAINS (all domains when empty)
 * and, when {@code members} is given, the user is a member of GROUP.
 */
function inScope_(config, members, user) {
  const email = (user.primaryEmail || '').toLowerCase();
  if (members && !members.has(email)) {
    return false;
  }
  const domain = email.substring(email.indexOf('@') + 1);
  return config.domains.length === 0 || config.domains.indexOf(domain) >= 0;
}

function toDirectoryEntry_(user) {
  const name = user.name || {};
  return {
    name: name.fullName || ((name.givenName || '') + ' ' + (name.familyName || '')).trim(),
    givenName: name.givenName || '',
    familyName: name.familyName || '',
    active: !user.suspended && !user.archived,
  };
}

function toScimUser_(email, user) {
  return {
    schemas: [SCIM_USER_SCHEMA],
    userName: email,
    name: { formatted: user.name, givenName: user.givenName, familyName: user.familyName },
    displayName: user.name,
    emails: [{ value: email, type: 'work', primary: true }],
    active: true,
  };
}

function scimRequest_(config, method, path, body) {
  const request = {
    url: config.baseUrl + path,
    method: method,
    headers: { Authorization: 'Bearer ' + config.token, Accept: SCIM_CONTENT_TYPE },
    muteHttpExceptions: true,
  };
  if (body) {
    request.contentType = SCIM_CONTENT_TYPE;
    request.payload = JSON.stringify(body);
  }
  return request;
}

function parseJson_(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch (e) {
    return { detail: text };
  }
}

function errorDetail_(body) {
  return (body && body.detail) || '';
}

function notify_(config, subject, body) {
  try {
    MailApp.sendEmail(config.notifyEmail, subject, body);
  } catch (e) {
    console.error('Could not send notification email: ' + e);
  }
}
