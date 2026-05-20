// MQTT trigger — subscribes to one or more topics; fires once per incoming
// message with the topic + parsed payload.
//
// Broker settings (url, credentials, clientId) live on a stored mqtt
// configuration. The trigger only references it by name + the per-trigger
// topic / qos / parseJson knobs.
//
// Trigger config:
//   config:    "<name>"             required (mqtt config from Configurations)
//   topic:     "sensors/+/temp"     required — string OR array of topics
//   qos:       0 | 1 | 2            default 0
//   parseJson: true                 default true (try JSON.parse on payload)
//
// Payload passed to onFire:
//   { topic, message, qos, retain, receivedAt }

import { log } from "../../utils/logger.js";
import { loadConfigsMap } from "../../configs/loader.js";
import { getMqttClient } from "../../plugins/mqtt/util.js";

export default {
  type: "mqtt",
  description:
    "Fires whenever a message arrives on one or more MQTT topics. " +
    "Set `config` to the name of a stored mqtt configuration.",
  configSchema: {
    type: "object",
    required: ["config", "topic"],
    properties: {
      config: {
        type: "string",
        minLength: 1,
        description: "Name of a stored mqtt configuration.",
      },
      topic: {
        oneOf: [
          { type: "string", minLength: 1 },
          { type: "array",  items: { type: "string", minLength: 1 }, minItems: 1 },
        ],
      },
      qos:       { type: "integer", enum: [0, 1, 2], default: 0 },
      parseJson: { type: "boolean", default: true },
    },
  },

  async subscribe(config, onFire, ctx = {}) {
    if (!config?.config) {
      throw new Error("mqtt trigger: `config` is required (name of a stored mqtt configuration)");
    }

    const configsMap = await loadConfigsMap(ctx.workspaceId, ctx.projectId || null);
    const cfg = configsMap[config.config];
    if (!cfg) {
      throw new Error(
        `mqtt trigger: config "${config.config}" not found. ` +
        `Create a configuration of type mqtt on the Home page → Configurations.`,
      );
    }
    if (!cfg.url) {
      throw new Error(`mqtt trigger: config "${config.config}" has no url set.`);
    }

    const topics = Array.isArray(config.topic) ? config.topic : [config.topic];
    const qos = typeof config.qos === "number" ? config.qos : 0;

    // Reuse / create a connection for these credentials. The same cache
    // serves the mqtt.publish action plugin, so a flow that publishes to
    // the same broker rides on top of the same TCP connection.
    const client = getMqttClient({
      url:      cfg.url,
      username: cfg.username,
      password: cfg.password,
      clientId: cfg.clientId,
    });

    let subscribed = false;
    let stopped = false;

    function doSubscribe() {
      if (stopped || subscribed) return;
      client.subscribe(topics, { qos }, (err, granted) => {
        if (err) {
          log.warn("mqtt subscribe failed", { url: cfg.url, error: err.message });
          return;
        }
        subscribed = true;
        log.info("mqtt subscribed", { url: cfg.url, granted });
      });
    }

    if (client.connected) doSubscribe();
    client.on("connect",   doSubscribe);
    // Re-subscribe after every reconnect — the broker forgets the
    // session unless cleanSession=false (we don't enable that).
    client.on("reconnect", () => { subscribed = false; });

    const onMessage = (topic, payload, packet) => {
      if (stopped) return;
      const raw = payload.toString("utf8");
      let message = raw;
      if (config.parseJson !== false) {
        try { message = JSON.parse(raw); } catch { /* keep as string */ }
      }
      onFire({
        topic,
        message,
        qos:        packet.qos,
        retain:     packet.retain,
        receivedAt: new Date().toISOString(),
      });
    };
    client.on("message", onMessage);

    log.info("mqtt trigger subscribed", { url: cfg.url, topics, qos });

    return {
      stop: async () => {
        stopped = true;
        client.off("message", onMessage);
        try { await new Promise((res) => client.unsubscribe(topics, res)); }
        catch (e) { log.warn("mqtt unsubscribe failed", { error: e.message }); }
        // Don't close the cached client — other triggers / publishers
        // may still be using it. The pool's own "close" handler evicts
        // it if the broker drops the connection.
      },
    };
  },
};
