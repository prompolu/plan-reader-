import { useState } from "react";
import { Copy, KeyRound, Lock, MessageCircle, Ruler } from "lucide-react";
import { createActivationCode, newKeyPair, normalizeDeviceCode, publicKeyOf } from "../license/codes";
import { LICENSE_KEYS } from "../license/keys";
import { LanguageSwitch } from "../components/LanguageSwitch";
import { locale, t, useLang } from "../i18n";
import { saveBlob } from "../lib/save";
import { addToHistory, forgetKey, hasStoredKey, licenseNumber, readHistory, storeKey, unlockKey, type IssuedLicense } from "./keystore";

/**
 * The vendor's activation-code generator, for its computer and iPhone. The
 * secret key is created (or imported) here, kept on the device encrypted with
 * a PIN, and never sent anywhere. The page itself holds no secret.
 */
type Screen =
  | { readonly kind: "start" }
  | { readonly kind: "backup"; readonly privateKey: string }
  | { readonly kind: "import" }
  | { readonly kind: "pin"; readonly privateKey: string }
  | { readonly kind: "locked" }
  | { readonly kind: "ready"; readonly privateKey: string; readonly publicKey: string };

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = () => iso(new Date());
const inOneYear = () => {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return iso(d);
};
const fmtDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(locale(), { timeZone: "UTC" });

export function GeneratorApp() {
  useLang();
  const [screen, setScreen] = useState<Screen>(hasStoredKey() ? { kind: "locked" } : { kind: "start" });
  const ready = async (privateKey: string) => setScreen({ kind: "ready", privateKey, publicKey: await publicKeyOf(privateKey) });
  return (
    <div className="activation generator" data-testid="generator">
      <div className="card strong activation-card">
        <div className="row between gap wrap">
          <div className="activation-brand">
            <span className="logo">
              <Ruler size={15} />
            </span>
            <span>
              PlanMeasure <b>AI</b> · {t("Activation codes")}
            </span>
          </div>
          <LanguageSwitch compact />
        </div>
        {screen.kind === "start" && (
          <Start onCreate={async () => setScreen({ kind: "backup", privateKey: (await newKeyPair()).privateKey })} onImport={() => setScreen({ kind: "import" })} />
        )}
        {screen.kind === "backup" && <Backup privateKey={screen.privateKey} onDone={() => setScreen({ kind: "pin", privateKey: screen.privateKey })} />}
        {screen.kind === "import" && <Import onDone={(k) => setScreen({ kind: "pin", privateKey: k })} onCancel={() => setScreen({ kind: "start" })} />}
        {screen.kind === "pin" && <NewPin privateKey={screen.privateKey} onDone={() => ready(screen.privateKey)} />}
        {screen.kind === "locked" && <Unlock onDone={ready} onForget={() => setScreen({ kind: "start" })} />}
        {screen.kind === "ready" && <Ready privateKey={screen.privateKey} publicKey={screen.publicKey} onLock={() => setScreen({ kind: "locked" })} />}
      </div>
    </div>
  );
}

function CopyButton({ text, testId, label }: { text: string; testId?: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn" data-testid={testId} onClick={() => void navigator.clipboard?.writeText(text).then(() => setDone(true), () => setDone(false))}>
      <Copy size={14} /> {done ? t("Copied") : label}
    </button>
  );
}

function Start({ onCreate, onImport }: { onCreate: () => void; onImport: () => void }) {
  return (
    <>
      <h1>{t("First use")}</h1>
      <p className="muted">
        {t(
          "Activation codes are signed with your secret key. If you already have one (for example the key you use for Debromp codes), import it. Otherwise create it here, once, then import it on your other device (computer ↔ iPhone).",
        )}
      </p>
      <div className="row gap wrap">
        <button className="btn btn-primary" data-testid="create-key" onClick={onCreate}>
          <KeyRound size={14} /> {t("Create my secret key")}
        </button>
        <button className="btn" data-testid="import-key" onClick={onImport}>
          {t("Import my secret key")}
        </button>
      </div>
    </>
  );
}

function Backup({ privateKey, onDone }: { privateKey: string; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  return (
    <>
      <h1>{t("Back up your secret key")}</h1>
      <p className="muted">
        {t(
          "Copy it into your Notes (or a password manager) and write it down on paper kept somewhere safe. Without it, no more codes can be made for your clients. Never give it to anyone: whoever has it can make codes.",
        )}
      </p>
      <div className="device-code secret" data-testid="secret-key">
        {privateKey}
      </div>
      <div className="row gap">
        <CopyButton text={privateKey} testId="copy-secret" label={t("Copy the secret key")} />
      </div>
      <label className="check">
        <input type="checkbox" data-testid="saved" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>{t("I have backed up my secret key (Notes and paper).")}</span>
      </label>
      <div className="row gap activation-actions">
        <button className="btn btn-primary" data-testid="continue" disabled={!saved} onClick={onDone}>
          {t("Continue")}
        </button>
      </div>
    </>
  );
}

function Import({ onDone, onCancel }: { onDone: (k: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        const k = text.trim().toLowerCase();
        try {
          await publicKeyOf(k);
          onDone(k);
        } catch {
          setError(t("This is not a secret key (64 characters, 0-9 and a-f)."));
        }
      }}
    >
      <h1>{t("Import my secret key")}</h1>
      <p className="muted">{t("Paste the secret key you backed up when it was created.")}</p>
      <label>
        {t("Secret key")}
        <textarea
          className="code-input"
          data-testid="secret-input"
          rows={3}
          value={text}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            setError("");
          }}
        />
      </label>
      {error && <div className="banner banner-warn">{error}</div>}
      <div className="row gap activation-actions">
        <button type="button" className="btn" onClick={onCancel}>
          {t("Cancel")}
        </button>
        <button type="submit" className="btn btn-primary" data-testid="import-ok" disabled={!text.trim()}>
          {t("Import")}
        </button>
      </div>
    </form>
  );
}

function NewPin({ privateKey, onDone }: { privateKey: string; onDone: () => void }) {
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const ok = /^\d{4,8}$/.test(pin) && pin === again;
  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ok) return;
        await storeKey(privateKey, pin);
        onDone();
      }}
    >
      <h1>{t("Choose a PIN")}</h1>
      <p className="muted">{t("4 to 8 digits. It protects the generator on this device and is asked every time it opens.")}</p>
      <label>
        {t("PIN")}
        <input data-testid="pin" type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={(e) => setPin(e.target.value)} />
      </label>
      <label>
        {t("Confirm the PIN")}
        <input data-testid="pin-again" type="password" inputMode="numeric" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
      </label>
      <div className="row gap activation-actions">
        <button type="submit" className="btn btn-primary" data-testid="pin-ok" disabled={!ok}>
          {t("Save")}
        </button>
      </div>
    </form>
  );
}

function Unlock({ onDone, onForget }: { onDone: (k: string) => void; onForget: () => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const k = await unlockKey(pin);
        setBusy(false);
        if (k) onDone(k);
        else setError(true);
      }}
    >
      <h1>{t("Enter your PIN")}</h1>
      <label>
        {t("PIN")}
        <input
          data-testid="unlock-pin"
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          autoFocus
          value={pin}
          onChange={(e) => {
            setPin(e.target.value);
            setError(false);
          }}
        />
      </label>
      {error && (
        <div className="banner banner-warn" data-testid="pin-error">
          {t("Wrong PIN.")}
        </div>
      )}
      <div className="row gap activation-actions">
        <button
          type="button"
          className="btn"
          onClick={() => {
            if (window.confirm(t("Forget the secret key on this device? You will need to import it again from your backup."))) {
              forgetKey();
              onForget();
            }
          }}
        >
          {t("Forgot PIN")}
        </button>
        <button type="submit" className="btn btn-primary" data-testid="unlock" disabled={!pin || busy}>
          {t("Open")}
        </button>
      </div>
    </form>
  );
}

function Ready({ privateKey, publicKey, onLock }: { privateKey: string; publicKey: string; onLock: () => void }) {
  const [client, setClient] = useState("");
  const [device, setDevice] = useState("");
  const [kind, setKind] = useState<"permanent" | "yearly">("permanent");
  const [until, setUntil] = useState(inOneYear());
  const [issued, setIssued] = useState<IssuedLicense | undefined>();
  const [history, setHistory] = useState(readHistory);
  const [showSecret, setShowSecret] = useState(false);
  const [error, setError] = useState("");
  const deviceCode = normalizeDeviceCode(device);
  const valid = !!client.trim() && !!deviceCode && (kind === "permanent" || (!!until && until >= today()));
  const accepted = LICENSE_KEYS.includes(publicKey);
  const validity = (l: IssuedLicense) => (l.expiresOn ? t("valid until {date}", { date: fmtDay(l.expiresOn) }) : t("permanent licence"));
  const reset = () => {
    setIssued(undefined);
    setError("");
  };

  const message = (l: IssuedLicense) =>
    t(
      "Hello {client},\nHere is your PlanMeasure AI activation code ({validity}):\n\n{code}\n\nPaste it into PlanMeasure AI, in the “Activation code” field, then press “Activate”. It only works on the device {device}.",
      { client: l.client, validity: validity(l), code: l.code, device: l.device },
    );

  const exportCsv = () => {
    const rows = [[t("Date"), t("Client"), t("Device code"), t("Licence type"), t("Valid until"), t("Licence no."), t("Activation code")]].concat(
      history.map((l) => [l.date, l.client, l.device, l.expiresOn ? t("Yearly") : t("Permanent"), l.expiresOn ?? "", String(l.number), l.code]),
    );
    const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(";")).join("\n");
    void saveBlob(new Blob(["﻿" + csv], { type: "text/csv" }), `planmeasure-licences-${today()}.csv`);
  };

  return (
    <>
      {!accepted && (
        <div className="banner banner-warn" data-testid="key-not-in-app">
          {t("This version of PlanMeasure AI does not accept codes made with this key. To use it, add its public key (under “Keys” below) to the app and publish a new version.")}
        </div>
      )}
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!valid) return;
          const number = licenseNumber();
          const expiresOn = kind === "yearly" ? until : undefined;
          try {
            const code = await createActivationCode(privateKey, deviceCode!, { number, ...(expiresOn ? { expiresOn: new Date(`${expiresOn}T00:00:00Z`) } : {}) });
            const l: IssuedLicense = { date: today(), client: client.trim(), device: deviceCode!, number, code, ...(expiresOn ? { expiresOn } : {}) };
            setIssued(l);
            setHistory(addToHistory(l));
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
      >
        <h1>{t("New licence")}</h1>
        <label>
          {t("Client")}
          <input
            data-testid="client"
            value={client}
            placeholder={t("e.g. {x}", { x: "Carter Joinery" })}
            onChange={(e) => {
              setClient(e.target.value);
              reset();
            }}
          />
        </label>
        <label>
          {t("Client's device code")}
          <input
            data-testid="device"
            value={device}
            placeholder={t("e.g. {x}", { x: "7K3F-92QX-M4TB" })}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => {
              setDevice(e.target.value);
              reset();
            }}
          />
        </label>
        {device && !deviceCode && <p className="small error-text">{t("Incomplete device code: 12 characters, e.g. {x}.", { x: "7K3F-92QX-M4TB" })}</p>}
        <div className="row gap wrap">
          <label className="radio">
            <input
              type="radio"
              name="kind"
              data-testid="kind-permanent"
              checked={kind === "permanent"}
              onChange={() => {
                setKind("permanent");
                reset();
              }}
            />
            <span>{t("Permanent")}</span>
          </label>
          <label className="radio">
            <input
              type="radio"
              name="kind"
              data-testid="kind-yearly"
              checked={kind === "yearly"}
              onChange={() => {
                setKind("yearly");
                reset();
              }}
            />
            <span>{t("Yearly")}</span>
          </label>
        </div>
        {kind === "yearly" && (
          <label>
            {t("Valid until (inclusive)")}
            <input
              data-testid="until"
              type="date"
              value={until}
              min={today()}
              onChange={(e) => {
                setUntil(e.target.value);
                reset();
              }}
            />
          </label>
        )}
        {error && <div className="banner banner-error">{error}</div>}
        <div className="row gap activation-actions">
          <button type="submit" className="btn btn-primary" data-testid="generate" disabled={!valid}>
            <KeyRound size={14} /> {t("Generate the code")}
          </button>
        </div>
      </form>

      {issued && (
        <div className="gen-section" data-testid="issued">
          <p>
            <b>{issued.client}</b> — {issued.device} — {validity(issued)} — {t("Licence no.")} {issued.number}
          </p>
          <div className="device-code secret" data-testid="activation-result">
            {issued.code}
          </div>
          <div className="row gap wrap">
            <CopyButton text={issued.code} testId="copy-code" label={t("Copy the code")} />
            <a className="btn" data-testid="whatsapp-client" href={`https://wa.me/?text=${encodeURIComponent(message(issued))}`} target="_blank" rel="noreferrer">
              <MessageCircle size={14} /> {t("Send by WhatsApp")}
            </a>
          </div>
        </div>
      )}

      {history.length > 0 && (
        <details className="gen-section" open>
          <summary>{t("Licences issued on this device ({n})", { n: history.length })}</summary>
          <div className="gen-table">
            <table className="table" data-testid="history">
              <thead>
                <tr>
                  <th>{t("Date")}</th>
                  <th>{t("Client")}</th>
                  <th>{t("Device code")}</th>
                  <th>{t("Valid until")}</th>
                </tr>
              </thead>
              <tbody>
                {history.map((l) => (
                  <tr key={`${l.number}-${l.device}-${l.code.slice(-6)}`}>
                    <td className="nowrap">{fmtDay(l.date)}</td>
                    <td>{l.client}</td>
                    <td className="nowrap">
                      <code>{l.device}</code>
                    </td>
                    <td className="nowrap">{l.expiresOn ? fmtDay(l.expiresOn) : t("Permanent")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row gap">
            <button type="button" className="btn" onClick={exportCsv}>
              {t("Export (spreadsheet)")}
            </button>
          </div>
        </details>
      )}

      <details className="gen-section">
        <summary>{t("Keys")}</summary>
        <p className="small muted">{t("Public key – it goes into PlanMeasure AI and cannot make codes:")}</p>
        <div className="device-code secret small" data-testid="public-key">
          {publicKey}
        </div>
        <div className="row gap">
          <CopyButton text={publicKey} testId="copy-public" label={t("Copy the public key")} />
        </div>
        {showSecret ? (
          <>
            <p className="small muted">{t("Secret key – keep it to yourself:")}</p>
            <div className="device-code secret small">{privateKey}</div>
          </>
        ) : (
          <div>
            <button type="button" className="btn" onClick={() => setShowSecret(true)}>
              {t("Show my secret key")}
            </button>
          </div>
        )}
      </details>

      <div className="row gap activation-actions">
        <button type="button" className="btn" data-testid="lock" onClick={onLock}>
          <Lock size={14} /> {t("Lock")}
        </button>
      </div>
    </>
  );
}
