import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RequestConfig } from "../../src/config";

describe("RequestConfig", () => {
  it("starts empty and exposes query helpers", () => {
    const config = RequestConfig.create();

    assert.deepEqual(config.build(), {});
    assert.equal(config.size, 0);
    assert.deepEqual(config.keys, []);
    assert.equal(config.has("temperature"), false);
    assert.equal(config.get("temperature"), undefined);
  });

  it("builds sampling and token parameters with chainable methods", () => {
    const config = RequestConfig.create()
      .temperature(0.8)
      .topP(0.9)
      .topK(20.9)
      .maxTokens(1024.8)
      .frequencyPenalty(0.5)
      .presencePenalty(-0.25)
      .seed(42.9);

    assert.deepEqual(config.build(), {
      temperature: 0.8,
      top_p: 0.9,
      top_k: 20,
      max_tokens: 1024,
      frequency_penalty: 0.5,
      presence_penalty: -0.25,
      seed: 42,
    });
    assert.equal(config.size, 7);
    assert.deepEqual(config.keys, [
      "temperature",
      "top_p",
      "top_k",
      "max_tokens",
      "frequency_penalty",
      "presence_penalty",
      "seed",
    ]);
  });

  it("clamps bounded numeric values and floors integer-like values", () => {
    const config = RequestConfig.create()
      .temperature(-1)
      .topP(2)
      .topK(0)
      .maxTokens(-100)
      .frequencyPenalty(-3)
      .presencePenalty(3)
      .seed(3.99);

    assert.deepEqual(config.build(), {
      temperature: 0,
      top_p: 1,
      top_k: 1,
      max_tokens: 1,
      frequency_penalty: -2,
      presence_penalty: 2,
      seed: 3,
    });
  });

  it("supports stop sequences and removes them when called with no arguments", () => {
    const config = RequestConfig.create().stop("A", "B", "C", "D", "E");

    assert.deepEqual(config.get("stop"), ["A", "B", "C", "D"]);
    assert.equal(config.has("stop"), true);

    config.stop();
    assert.equal(config.has("stop"), false);
    assert.deepEqual(config.build(), {});
  });

  it("sets and clears response formats", () => {
    const config = RequestConfig.create();
    const schema = {
      name: "Answer",
      schema: {
        type: "object",
        properties: {
          answer: { type: "string" },
        },
        required: ["answer"],
      },
    };

    config.responseFormat("json_object");
    assert.deepEqual(config.get("response_format"), { type: "json_object" });

    config.responseFormat("json_schema", schema);
    assert.deepEqual(config.get("response_format"), {
      type: "json_schema",
      json_schema: schema,
    });

    config.responseFormat("json_schema");
    assert.deepEqual(config.get("response_format"), {
      type: "json_schema",
      json_schema: schema,
    });

    config.responseFormat("text");
    assert.equal(config.has("response_format"), false);
  });

  it("supports custom parameters and unset", () => {
    const config = RequestConfig.create()
      .set("stream_options", { include_usage: true })
      .set("metadata", ["a", "b"]);

    assert.deepEqual(config.get("stream_options"), { include_usage: true });
    assert.deepEqual(config.get("metadata"), ["a", "b"]);
    assert.equal(config.has("metadata"), true);

    config.unset("metadata");
    assert.equal(config.has("metadata"), false);
    assert.deepEqual(config.build(), {
      stream_options: { include_usage: true },
    });
  });

  it("provides preset configurations", () => {
    assert.deepEqual(RequestConfig.precise().build(), {
      temperature: 0.1,
      top_p: 0.9,
      frequency_penalty: 0,
      presence_penalty: 0,
    });

    assert.deepEqual(RequestConfig.balanced().build(), {
      temperature: 0.7,
      top_p: 0.95,
      frequency_penalty: 0,
      presence_penalty: 0,
    });

    assert.deepEqual(RequestConfig.creative().build(), {
      temperature: 1.2,
      top_p: 0.95,
      frequency_penalty: 0.3,
      presence_penalty: 0.3,
    });
  });

  it("clones without sharing parameter maps", () => {
    const original = RequestConfig.create().temperature(0.5).set("custom", "a");
    const clone = original.clone();

    clone.temperature(1.5).set("custom", "b");

    assert.deepEqual(original.build(), {
      temperature: 0.5,
      custom: "a",
    });
    assert.deepEqual(clone.build(), {
      temperature: 1.5,
      custom: "b",
    });
  });

  it("merges configs with the other config taking precedence", () => {
    const base = RequestConfig.create()
      .temperature(0.2)
      .maxTokens(100)
      .set("base_only", true);
    const override = RequestConfig.create()
      .temperature(1.1)
      .topP(0.7);

    const merged = base.merge(override);

    assert.deepEqual(merged.build(), {
      temperature: 1.1,
      max_tokens: 100,
      base_only: true,
      top_p: 0.7,
    });
    assert.deepEqual(base.build(), {
      temperature: 0.2,
      max_tokens: 100,
      base_only: true,
    });
    assert.deepEqual(override.build(), {
      temperature: 1.1,
      top_p: 0.7,
    });
  });

  it("returns a plain object snapshot from build", () => {
    const config = RequestConfig.create().temperature(0.4);
    const first = config.build();

    first.temperature = 2;

    assert.deepEqual(config.build(), { temperature: 0.4 });
  });

  it("formats current values for debug output", () => {
    const output = RequestConfig.create()
      .temperature(0.3)
      .set("stream", true)
      .toString();

    assert.match(output, /^RequestConfig \{/);
    assert.match(output, /temperature: 0\.3/);
    assert.match(output, /stream: true/);
  });
});
