import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Message, Role } from "../../src/message";
import { Injection, PromptBuilder, Rule } from "../../src/prompt";
import { MatchMode } from "../../src/session";

function fixtureHistory(): Message[] {
  return [
    Message.system("system"),
    Message.user("first user").tag("entry"),
    Message.assistant("first answer").tag("answer", "old"),
    Message.user("second user special").tag("entry", "special"),
    Message.assistant("second answer").tag("answer", "new"),
  ];
}

function texts(messages: Message[]): string[] {
  return messages.map((message) => message.text);
}

describe("Rule", () => {
  it("resolves top, bottom, and index anchors with directions", () => {
    const history = fixtureHistory();

    assert.deepEqual(Rule.top().before().resolve(history), [0]);
    assert.deepEqual(Rule.top().after().resolve(history), [1]);
    assert.deepEqual(Rule.bottom().before().resolve(history), [4]);
    assert.deepEqual(Rule.bottom().after().resolve(history), [5]);
    assert.deepEqual(Rule.index(2).before().resolve(history), [2]);
    assert.deepEqual(Rule.index(-1).after().resolve(history), [5]);
    assert.deepEqual(Rule.index(99).after().resolve(history), []);
  });

  it("resolves role, content, tag, and predicate anchors", () => {
    const history = fixtureHistory();

    assert.deepEqual(Rule.byRole(Role.User).first().before().resolve(history), [1]);
    assert.deepEqual(Rule.byRole(Role.User).last().after().resolve(history), [4]);
    assert.deepEqual(
      Rule.byContent(["user", "special"], { mode: MatchMode.AND }).before().resolve(history),
      [3]
    );
    assert.deepEqual(Rule.byTags(["answer"]).all().after().resolve(history), [3, 5]);
    assert.deepEqual(Rule.by((msg) => msg.text.includes("first")).all().before().resolve(history), [1, 2]);
  });

  it("applies offset, scan depth, and scan direction", () => {
    const history = fixtureHistory();

    assert.deepEqual(Rule.byRole(Role.User).last().offset(-1).after().resolve(history), [3]);
    assert.deepEqual(Rule.byRole(Role.System).offset(-1).after().resolve(history), []);
    assert.deepEqual(
      Rule.byTags(["entry"]).all().scanDepth(2).scanReverse().before().resolve(history),
      [3]
    );
    assert.deepEqual(
      Rule.byTags(["entry"]).all().scanDepth(2).scanForward().before().resolve(history),
      [1]
    );
  });
});

describe("Injection", () => {
  it("tracks life, enabled state, probability, priority, and sequence", () => {
    const injection = new Injection(Rule.top(), Message.system("injected"), 2);

    assert.match(injection.id, /^inj-/);
    assert.equal(injection.life, 2);
    assert.equal(injection.isAlive, true);
    assert.equal(injection.isActive, true);

    injection.enabled = false;
    assert.equal(injection.isActive, false);

    injection.enabled = true;
    injection.consume();
    injection.consume();
    assert.equal(injection.life, 0);
    assert.equal(injection.isAlive, false);

    injection.probability = 2;
    assert.equal(injection.probability, 1);
    assert.equal(injection.rollTrigger(), true);

    injection.probability = -1;
    assert.equal(injection.probability, 0);
    assert.equal(injection.rollTrigger(), false);

    injection.priority = Number.NaN;
    assert.equal(injection.priority, 0);
    injection.setPriority(5);
    assert.equal(injection.priority, 5);
    injection.sequence = 7;
    assert.equal(injection.sequence, 7);
  });

  it("does not consume permanent or already expired injections", () => {
    const permanent = new Injection(Rule.top(), Message.system("permanent"));
    const expired = new Injection(Rule.top(), Message.system("expired"), 0);

    permanent.consume();
    expired.consume();

    assert.equal(permanent.life, -1);
    assert.equal(expired.life, 0);
  });
});

describe("PromptBuilder", () => {
  it("injects messages by rule without mutating the original history array", () => {
    const history = fixtureHistory();
    const builder = new PromptBuilder();

    builder.injectSystem(Rule.top().after(), "context");
    builder.injectUser(Rule.bottom().before(), "pre-final");
    builder.injectAssistant(Rule.bottom().after(), "tail");

    const built = builder.build(history);

    assert.deepEqual(texts(history), [
      "system",
      "first user",
      "first answer",
      "second user special",
      "second answer",
    ]);
    assert.deepEqual(texts(built), [
      "system",
      "context",
      "first user",
      "first answer",
      "second user special",
      "pre-final",
      "second answer",
      "tail",
    ]);
    assert.equal(built[1].role, Role.System);
    assert.equal(built[5].role, Role.User);
    assert.equal(built[7].role, Role.Assistant);
  });

  it("orders same-index insertions by Rule.order and then registration sequence", () => {
    const history = fixtureHistory();
    const builder = new PromptBuilder();

    builder.injectSystem(Rule.top().before().order(10), "late");
    builder.injectSystem(Rule.top().before().order(-1), "early");
    builder.injectSystem(Rule.top().before().order(10), "late-2");

    assert.deepEqual(texts(builder.build(history)).slice(0, 4), [
      "early",
      "late",
      "late-2",
      "system",
    ]);
  });

  it("supports batch and immediate build strategies", () => {
    const history = fixtureHistory();
    const builder = new PromptBuilder();

    builder.injectSystem(Rule.bottom().after(), "inserted");
    builder.injectSystem(Rule.byContent(["inserted"]).after(), "after inserted");

    assert.deepEqual(texts(builder.build(history)), [
      "system",
      "first user",
      "first answer",
      "second user special",
      "second answer",
      "inserted",
    ]);
    assert.deepEqual(texts(builder.build(history, { strategy: "immediate" })), [
      "system",
      "first user",
      "first answer",
      "second user special",
      "second answer",
      "inserted",
      "after inserted",
    ]);
    assert.deepEqual(texts(builder.buildImmediate(history)), [
      "system",
      "first user",
      "first answer",
      "second user special",
      "second answer",
      "inserted",
      "after inserted",
    ]);
  });

  it("consumes life only for active triggered injections and can prune expired ones", () => {
    const history = fixtureHistory();
    const builder = new PromptBuilder();

    const once = builder.injectSystem(Rule.top().before(), "once", 1);
    const never = builder.injectSystem(Rule.top().before(), "never", {
      life: 1,
      probability: 0,
    });
    const disabled = builder.injectSystem(Rule.top().before(), "disabled", 1);
    builder.disable(disabled);

    assert.deepEqual(texts(builder.build(history)).slice(0, 2), ["once", "system"]);
    assert.equal(once.life, 0);
    assert.equal(never.life, 1);
    assert.equal(disabled.life, 1);
    assert.equal(builder.expiredCount, 1);

    builder.prune();
    assert.equal(builder.findById(once.id), undefined);
    assert.equal(builder.aliveCount, 2);
    assert.equal(builder.activeCount, 1);
  });

  it("manages injections by id, rule, enabled state, and clear helpers", () => {
    const builder = new PromptBuilder();
    const rule = Rule.top().before();
    const first = builder.injectSystem(rule, "first");
    const second = builder.injectSystem(rule, "second");

    assert.equal(builder.injections.length, 2);
    assert.deepEqual(builder.findByRule(rule), [first, second]);
    assert.equal(builder.findById(first.id), first);

    builder.disable(first);
    assert.equal(first.enabled, false);
    builder.enable(first);
    assert.equal(first.enabled, true);

    builder.remove(second);
    assert.deepEqual(builder.injections, [first]);
    builder.removeById(first.id);
    assert.equal(builder.injections.length, 0);

    builder.injectSystem(rule, "again");
    builder.clearInjections();
    assert.equal(builder.injections.length, 0);

    builder.injectSystem(rule, "again");
    builder.clear();
    assert.equal(builder.injections.length, 0);
  });

  it("removes injections by rule", () => {
    const builder = new PromptBuilder();
    const firstRule = Rule.top().before();
    const secondRule = Rule.bottom().after();

    builder.injectSystem(firstRule, "first");
    const kept = builder.injectSystem(secondRule, "second");

    builder.removeByRule(firstRule);

    assert.deepEqual(builder.injections, [kept]);
  });

  it("injects multiple messages independently with injectAll", () => {
    const history = fixtureHistory();
    const builder = new PromptBuilder();

    const injections = builder.injectAll(Rule.bottom().after(), [
      Message.system("one"),
      Message.system("two"),
    ], 1);

    assert.equal(injections.length, 2);
    assert.deepEqual(texts(builder.build(history)).slice(-2), ["one", "two"]);
    assert.deepEqual(injections.map((inj) => inj.life), [0, 0]);
  });

  it("applies operation pipeline helpers in registration order", () => {
    const history = fixtureHistory();
    const builder = new PromptBuilder();

    builder
      .insertAt(1, Message.system("inserted"), "insert")
      .removeWhere((msg) => msg.hasTag("old"), "remove-old")
      .replaceWhere(
        (msg) => msg.role === Role.System && msg.text === "system",
        () => Message.system("replaced-system"),
        "replace-system"
      )
      .filter((msg) => msg.text !== "first user", "filter-first")
      .map((msg) => msg.setMeta("seen", true), "mark")
      .slice(0, 4, "slice")
      .transform((messages) => [...messages, Message.user("tail")], "tail");

    const built = builder.build(history);

    assert.deepEqual(texts(built), [
      "replaced-system",
      "inserted",
      "second user special",
      "second answer",
      "tail",
    ]);
    assert.equal(built[0].metadata.seen, true);
    assert.deepEqual(builder.operations.map((operation) => operation.label), [
      "insert",
      "remove-old",
      "replace-system",
      "filter-first",
      "mark",
      "slice",
      "tail",
    ]);

    builder.removeOperation("tail");
    assert.equal(builder.operations.some((operation) => operation.label === "tail"), false);

    builder.clearOperations();
    assert.equal(builder.operations.length, 0);
  });

  it("supports insertAt, removeAt, and replaceWhere edge cases", () => {
    const history = fixtureHistory();
    const builder = new PromptBuilder();

    builder
      .insertAt(-1, Message.system("before-last"))
      .insertAt(999, Message.system("at-end"))
      .removeAt(-2)
      .replaceWhere((msg) => msg.text === "first answer", () => null);

    assert.deepEqual(texts(builder.build(history)), [
      "system",
      "first user",
      "second user special",
      "second answer",
      "at-end",
    ]);
  });

  it("creates system messages from non-string content", () => {
    const history = fixtureHistory();
    const builder = new PromptBuilder();

    builder.injectSystem(Rule.top().before(), [
      { type: "text", text: "part-a" },
      { type: "text", text: "part-b" },
    ]);

    const [inserted] = builder.build(history);
    assert.equal(inserted.role, Role.System);
    assert.equal(inserted.text, "part-apart-b");
  });
});
