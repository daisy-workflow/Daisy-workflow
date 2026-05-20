// Email trigger — watches an IMAP inbox and fires once per new message.
//
// IMAP server settings come from a stored mail.imap configuration; the
// trigger only references it by name. This keeps credentials out of the
// trigger blob and lets you rotate passwords in one place.
//
// Trigger config:
//   config:         "<name>"               required (mail.imap config)
//   mailbox:        "INBOX"                optional override of the config's `folder`
//   markAsSeen:     true                   default true (uses \Seen flag for dedup)
//   onlyUnseen:     true                   default true — start by ignoring existing read mail
//   pollIntervalMs: 60000                  used when IDLE isn't enabled / available
//   useIdle:        true                   default true; set false to force polling
//
// Payload passed to onFire:
//   { uid, messageId, from, to, cc, subject, date, text, html,
//     attachments[]: { filename, contentType, size } }

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { log } from "../../utils/logger.js";
import { loadConfigsMap } from "../../configs/loader.js";

export default {
  type: "email",
  description:
    "Fires when a new message lands in an IMAP mailbox. " +
    "Set `config` to the name of a stored mail.imap configuration.",
  configSchema: {
    type: "object",
    required: ["config"],
    properties: {
      config: {
        type: "string",
        minLength: 1,
        description: "Name of a stored mail.imap configuration.",
      },
      mailbox:        { type: "string",  default: "INBOX",
                        description: "Override the config's `folder` field." },
      markAsSeen:     { type: "boolean", default: true },
      onlyUnseen:     { type: "boolean", default: true },
      pollIntervalMs: { type: "integer", minimum: 5000, default: 60000 },
      useIdle:        { type: "boolean", default: true },
    },
  },

  async subscribe(config, onFire, ctx = {}) {
    if (!config?.config) {
      throw new Error("email trigger: `config` is required (name of a stored mail.imap configuration)");
    }

    // Resolve the named configuration. Configs loader decrypts secret
    // fields on the way out; we use those plaintext values only for the
    // duration of this connection — they're never persisted anywhere.
    const configsMap = await loadConfigsMap(ctx.workspaceId, ctx.projectId || null);
    const cfg = configsMap[config.config];
    if (!cfg) {
      throw new Error(
        `email trigger: config "${config.config}" not found. ` +
        `Create a configuration of type mail.imap on the Home page → Configurations.`,
      );
    }

    // Map mail.imap field names (host/port/tls/username/password/folder)
    // onto imapflow's expected shape (host/port/secure/auth/mailbox).
    if (!cfg.host) {
      throw new Error(`email trigger: config "${config.config}" has no host set.`);
    }
    if (!cfg.username) {
      throw new Error(`email trigger: config "${config.config}" has no username set.`);
    }

    const host    = cfg.host;
    const port    = cfg.port ?? 993;
    const secure  = cfg.tls !== false;     // mail.imap config schema uses `tls`
    const user    = cfg.username;
    const pass    = cfg.password ?? "";
    const mailbox = config.mailbox || cfg.folder || "INBOX";

    const client = new ImapFlow({
      host,
      port,
      secure,
      auth: { user, pass },
      logger: false,
    });

    let stopped = false;
    let pollHandle = null;

    // Surface async socket errors so they don't escape as unhandled
    // promise rejections and crash the worker. We only log here — the
    // initial `client.connect()` below still throws synchronously for
    // setup-time failures, which the trigger manager catches and records
    // on triggers.last_error.
    client.on("error", (err) => {
      log.warn("imap client error", { host, port, error: err.message });
    });
    client.on("close", () => {
      log.info("imap client closed", { host, port });
    });

    // Collect new messages from the FETCH stream first, then act on them
    // after the iterator finishes. Issuing STORE/messageFlagsAdd while
    // FETCH is still mid-stream wedges the imapflow connection — the next
    // command queues behind the still-running fetch, and Gmail's IDLE
    // notifications never get serviced. Symptom: trigger fires once, then
    // freezes on subsequent mail.
    async function processNewMessages() {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const batch = [];

        for await (const msg of client.fetch(
          { seen: false },
          { uid: true, envelope: true, source: true, internalDate: true },
        )) {
          if (stopped) return;
          let parsed = null;
          try { parsed = await simpleParser(msg.source); }
          catch (e) { log.warn("email parse failed", { uid: msg.uid, error: e.message }); }

          const env = msg.envelope || {};
          const payload = {
            uid: msg.uid,
            messageId: parsed?.messageId || env.messageId || null,
            from:    addrList(parsed?.from?.value || env.from),
            to:      addrList(parsed?.to?.value   || env.to),
            cc:      addrList(parsed?.cc?.value   || env.cc),
            subject: parsed?.subject || env.subject || "",
            date:    (parsed?.date || env.date || msg.internalDate || new Date())
                       .toISOString?.() ?? new Date().toISOString(),
            text:    parsed?.text || "",
            html:    parsed?.html || "",
            attachments: (parsed?.attachments || []).map(a => ({
              filename:    a.filename || "",
              contentType: a.contentType || "",
              size:        a.size || 0,
            })),
          };
          batch.push({ uid: msg.uid, payload });
        }

        // Iterator drained — now safe to issue further IMAP commands.
        for (const item of batch) {
          if (stopped) return;
          onFire(item.payload);
          if (config.markAsSeen !== false) {
            try { await client.messageFlagsAdd(item.uid, ["\\Seen"], { uid: true }); }
            catch (e) { log.warn("email flag failed", { uid: item.uid, error: e.message }); }
          }
        }
      } finally {
        lock.release();
      }
    }

    await client.connect();

    // Optionally process the existing unread queue once on startup.
    if (config.onlyUnseen === false) {
      // We'd need a stable seen marker for this; default behavior keeps it simple.
      log.warn("email trigger: onlyUnseen=false is treated like true (no per-trigger UID watermark yet)");
    }

    // IDLE is allowed only when the server advertises it AND the user
    // hasn't opted out. Servers like Gmail tear down IDLE every few
    // minutes; we manage that with an explicit re-enter loop rather than
    // relying on imapflow's auto-idle. If anything goes wrong (or the
    // user passes useIdle:false) we fall back to a plain poll, which is
    // simpler and works on every IMAP server we've ever met.
    const idleSupported = !!client.serverInfo?.capabilities?.includes("IDLE");
    const useIdle = config.useIdle !== false && idleSupported;

    if (useIdle) {
      log.info("email trigger using IDLE", { host });
      // Open the mailbox once so the IDLE loop has something to listen on.
      try { await client.mailboxOpen(mailbox); }
      catch (e) { log.warn("imap mailboxOpen", { error: e.message }); }

      // Initial sweep covers anything that landed before subscribe().
      await processNewMessages();

      // IDLE loop. `client.idle()` resolves when:
      //   - new EXISTS / EXPUNGE arrives,
      //   - we ourselves call another command,
      //   - the server times us out (Gmail ~5–10 min).
      // After it resolves we re-fetch new mail and immediately re-enter.
      (async () => {
        while (!stopped) {
          try {
            await client.idle();
          } catch (e) {
            if (stopped) return;
            log.warn("imap idle exited", { error: e.message });
            await new Promise(r => setTimeout(r, 5000));
            continue;
          }
          if (stopped) return;
          try { await processNewMessages(); }
          catch (e) { log.warn("imap idle fetch", { error: e.message }); }
        }
      })().catch(e => log.warn("email idle loop crashed", { error: e.message }));
    } else {
      const interval = config.pollIntervalMs ?? 60000;
      log.info("email trigger polling (no IDLE)", {
        intervalMs: interval,
        idleAdvertised: idleSupported,
      });
      const tick = () => processNewMessages().catch(e => log.warn("email poll", { error: e.message }));
      pollHandle = setInterval(tick, interval);
      pollHandle.unref?.();
      await tick();
    }

    return {
      stop: async () => {
        stopped = true;
        if (pollHandle) clearInterval(pollHandle);
        try { await client.logout(); } catch { /* swallow */ }
      },
    };
  },
};

function addrList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(o => o.address || o.name || String(o));
  if (typeof v === "string") return [v];
  if (typeof v === "object") return [v.address || v.name || ""];
  return [];
}
