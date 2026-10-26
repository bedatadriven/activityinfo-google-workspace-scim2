# Google Workspace → ActivityInfo user sync

Google Workspace can't send users to a custom SCIM endpoint, so this Apps Script runs inside the
customer's Google Workspace instead. Every 4 hours it reads the directory and calls ActivityInfo's
SCIM 2.0 endpoint:

| Google Workspace user                         | ActivityInfo                                   |
|-----------------------------------------------|------------------------------------------------|
| Active and in scope                           | Provisioned, name kept up to date (`POST /Users`) |
| Suspended or archived                         | De-provisioned (`PATCH active=false`)          |
| Deleted within the last 20 days               | De-provisioned (`PATCH active=false`)          |
| Reactivated                                   | Provisioned again                              |

All users in the Google Workspace account are synced, unless `DOMAINS` and/or `GROUP` limit the scope.

### Limitations

The script keeps no record of what it has synced; each run works only from what Google reports.

- **Deleted users** are only reported by Google for 20 days after deletion. A deleted user is
  de-provisioned on the first run in that window. If the script isn't running during those 20 days
  (for example, because the token has expired), the user stays active in ActivityInfo.
- **Users removed from `GROUP` or `DOMAINS`** are no longer synced, but they are not de-provisioned
  while their Google account is still active.

## Prerequisites

- ActivityInfo support has associated the customer's email domain(s) with their billing account,
  and issued a SCIM token for it. Tokens expire after at most 183 days.
- The script must run as a Google Workspace admin who can read users and groups. A super admin
  works; a custom admin role with *Users > Read* and *Groups > Read* is enough.

## Setup

1. Go to <https://script.google.com> and create a new project, e.g. "ActivityInfo user sync".
2. In **Project Settings**, tick *Show "appsscript.json" manifest file in editor*. Replace its
   contents with [`appsscript.json`](appsscript.json), and replace `Code.gs` with
   [`Code.gs`](Code.gs).
3. Under **Project Settings > Script Properties**, add:

   | Property                   | Example / notes                                                                 |
   |----------------------------|---------------------------------------------------------------------------------|
   | `SCIM_BASE_URL`            | `https://www.activityinfo.org/resources/billingAccounts/1234/scim/v2`            |
   | `SCIM_TOKEN`               | The token from ActivityInfo                                                     |
   | `DOMAINS`                  | Optional. e.g. `example.org,example.net`                                        |
   | `GROUP`                    | Optional. e.g. `activityinfo-users@example.org`. Only members of this group (including nested groups) are synced |
   | `NOTIFY_EMAIL`             | Optional. Where errors are emailed; defaults to the account that runs the script |

4. In the editor, run `dryRun` and approve the permissions it asks for. Tick **all** of them:
   the script refuses to run with only some of them granted. Check the execution log
   for the list of users it would provision and de-provision.
5. Run `setup`. It checks the token and installs a trigger that runs `sync` every 4 hours. Run
   `sync` once by hand to start straight away.

Every run sends a request for each user in scope. A run stops after about 4.5 minutes, and the next
one continues where it left off (the position is kept in the `SYNC_CURSOR` script property), so on
a large directory a complete pass can take several runs.

## Operations

- **Token renewal**: when the token expires, every run fails with an HTTP 401 and emails
  `NOTIFY_EMAIL`. Put a new token in `SCIM_TOKEN`; nothing else needs to change.
- **Logs**: see **Executions** in the Apps Script editor. ActivityInfo also logs every SCIM
  request on the server.

## Current ActivityInfo behaviour

Phase 1 of ActivityInfo's SCIM support:

- **Provisioning** marks the account as provisioned. It doesn't use a license or grant access to
  any database; database owners still add users to their databases.
- **De-provisioning** marks the account inactive, but doesn't yet revoke access or delete the
  account.
