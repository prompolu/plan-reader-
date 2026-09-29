# Licences and activation codes

PlanMeasure AI is sold without an account or a server, the same way as
Debromp: each of the client's devices gets an **activation code** that only
works on that device.

## How it works

1. The first time the app opens, it shows the **device code** (e.g.
   `7K3F-92QX-M4TB`) with **Copy** and **Send by WhatsApp** (to Prompolu,
   code already written). Nothing else in the app opens before activation.
   - Mac: derived from the hardware identifier (IOPlatformUUID).
   - Windows: derived from the MachineGuid.
   - iPhone / web: a random identifier kept by the browser. If it is erased
     (Safari data cleared, app removed from the Home Screen), a new device
     code appears and a new activation code is needed.
2. Prompolu types the device code into the **generator** and chooses:
   - **permanent**, or
   - **yearly**: valid until a date (inclusive).
3. The client pastes the activation code they receive (case, spaces, dashes
   and line breaks do not matter) and the app opens.

Codes are signed (Ed25519) with Prompolu's **secret key**. The app only holds
the **public key**: it can check a code, never make one. The check runs on the
device, offline, at every start. A code copied to another device is refused.

- Yearly licence: a banner appears 30 days before the end; the new code is
  entered from the banner or from **Settings → Licence → Enter a new code**.
  An expired licence shows the activation screen again; the projects stay on
  the device.
- A clock turned back to stretch a licence is refused (2 days of tolerance).
- The screen and the messages follow the app's language (English, French,
  Spanish).

### Same key as Debromp, separate codes

The app accepts codes signed with Prompolu's existing key
(`3ff022ed…8d7b58`, the one in Debromp since September 2026), so the **same
secret key** makes the codes of both apps. The codes themselves are not
interchangeable:

- a PlanMeasure code is signed under the prefix `PLANMEASURE-1`, a Debromp
  code under `DEBROMP-1`, so a Debromp code never unlocks PlanMeasure (and the
  other way round);
- the device code is derived differently in each app, so the same computer
  shows a different device code in PlanMeasure and in Debromp. Always use the
  code shown by PlanMeasure.

Format of an activation code: 71 bytes (version, expiry day counted from
2026-01-01 or 0 for permanent, licence number, 64-byte signature) in Crockford
base32, in groups of 6.

## The generator (computer and iPhone)

Private page: `…/generator.html` next to the web app (not indexed by search
engines), installable on the Home Screen ("PlanMeasure Codes"). It is also in
the desktop app's files but not reachable from its screens.

1. **Import the secret key you already use for Debromp codes** (Import my
   secret key), then choose a PIN (4 to 8 digits). *Or*, only for a new key:
   Create my secret key → the secret key is shown once: copy it to your
   password manager and on paper kept somewhere safe.
2. Fill in the client, the client's device code, permanent or yearly →
   **Generate the code** → Copy, or Send by WhatsApp (message written in the
   generator's language).
3. The licences issued stay on that device (history) and export to a
   spreadsheet (CSV).

If the generator shows *"This version of PlanMeasure AI does not accept codes
made with this key"*, the key is not in the app: its codes would be refused.
To use a new key, add its **public key** (Keys, at the bottom of the
generator) to `app/src/license/keys.ts` (`VENDOR_KEYS`) and publish a new
version. Codes made with an old key keep working as long as its public key
stays in that list. An empty list switches activation off.

The secret key is encrypted with the PIN (PBKDF2, 310,000 iterations +
AES-GCM) on the device. Nothing is sent to any server.

**Never share the secret key.** Whoever has it can make codes — for
PlanMeasure *and* for Debromp.

## Limits

No protection is absolute: someone able to modify the app's code can remove
the check. The repository must therefore be **private** (otherwise anyone can
rebuild the app without the check) — and the same goes for the web app's
files, which anyone can download from its address.

## Tests

- `app/src/license/codes.test.ts`: format, signature, device, expiry, a real
  Debromp code refused, no test key in normal builds.
- `app/e2e/license.spec.ts`: activation screen (wrong, foreign, expired and
  pasted codes), yearly banner and renewal, clock turned back, generator (key
  creation, PIN, import), and a generator-made code activating the app.
- Electron: the device code comes from the machine identifier through the
  preload bridge (`deviceIdentity`, `pm:device-identity`).
- The browser tests use a **test key**, accepted only by the test build
  (`npm run build:e2e`, `VITE_PLANMEASURE_TEST=1` from `.env.e2e`). Its
  private key is in `app/e2e/license-helper.ts`, so that build is never
  published: CI builds the web app and the installers with `npm run build`
  and `npm run check:keys` fails the build if the test key is in it (or the
  vendor key is missing).
