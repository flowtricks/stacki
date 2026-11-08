// Which update-check failures stay quiet.
//
//   node test/electron/app/autoUpdateErrors.test.js
//
// A background update check that fails because the connection dropped showed a
// warning dialog: "Stacki could not check for updates. Error:
// net::ERR_CONNECTION_CLOSED", while the feed itself answered. Chromium reports
// its transport failures as `net::ERR_…` in the message, and the quiet list only
// knew Node's error codes. The method: feed the classifier the shapes the
// updater produces (Chromium messages, Node codes, a mid-publish 404) and check
// each transient one is expected; then feed it failures the user must hear about
// (a bad signature, a 500, a malformed feed) and check they are not.

const { isExpectedAutoUpdateNetworkError } = require('#dist/electron/app/autoUpdate.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const expected = [
  ['the reported dialog: a closed connection', new Error('net::ERR_CONNECTION_CLOSED')],
  ['a reset connection', new Error('net::ERR_CONNECTION_RESET')],
  ['a network that changed mid-request', new Error('net::ERR_NETWORK_CHANGED')],
  ['an empty response', new Error('net::ERR_EMPTY_RESPONSE')],
  ['a Chromium timeout', new Error('net::ERR_TIMED_OUT')],
  ['a Chromium name lookup', new Error('net::ERR_NAME_NOT_RESOLVED')],
  ['a Chromium code on the error', Object.assign(new Error('request failed'), { code: 'ERR_CONNECTION_CLOSED' })],
  ['Node offline', Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' })],
  ['Node reset', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
  ['a channel file not uploaded yet', new Error('Cannot find latest-mac.yml in the latest release artifacts: HttpError: 404')],
];
for (const [what, error] of expected) {
  check(`quiet: ${what}`, isExpectedAutoUpdateNetworkError(error) === true, String(error));
}

const reported = [
  ['a bad code signature', new Error('Code signature at URL file:///Applications/Stacki.app did not pass validation')],
  ['a server error', new Error('HttpError: 500 Internal Server Error "method: GET url: https://github.com/flowtricks/stacki-releases"')],
  ['a malformed feed', new Error('Cannot parse update info from latest-mac.yml: YAMLException: bad indentation')],
  ['a certificate failure', new Error('net::ERR_CERT_AUTHORITY_INVALID')],
  ['an unknown Chromium failure', new Error('net::ERR_UNSAFE_REDIRECT')],
  ['nothing at all', undefined],
];
for (const [what, error] of reported) {
  check(`reported: ${what}`, isExpectedAutoUpdateNetworkError(error) === false, String(error));
}

if (failures.length) {
  console.error(`\nauto-update-errors: ${failures.length} failed, ${checked - failures.length} passed\n`);
  console.error(failures.join('\n') + '\n');
  process.exit(1);
}
console.log(`auto-update-errors: ${checked} passed`);
