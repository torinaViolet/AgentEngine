import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Message, Role, Usage } from "../../src/message";
import { MatchMode, Priority, Session } from "../../src/session";

function createBranchedSession(): {
  session: Session;
  firstUser: Message;
  firstAssistant: Message;
  branchUser: Message;
  branchAssistant: Message;
} {
  const session = Session.create("system prompt");
  const firstUser = session.addUser("first user").tag("entry");

  const firstAssistant = Message.assistant("first answer").tag("answer", "legacy");
  firstAssistant.usage = new Usage(2, 3, 5);
  session.addAssistant(firstAssistant);

  session.rewind(firstUser);
  const branchUser = session.addUser("branch question").tag("branch");

  const branchAssistant = Message.assistant("branch answer").tag("answer", "current");
  branchAssistant.usage = new Usage(7, 11, 18);
  session.addAssistant(branchAssistant);

  return { session, firstUser, firstAssistant, branchUser, branchAssistant };
}

describe("Session", () => {
  it("creates a session with a system root and tracks cursor history", () => {
    const session = Session.create("You are helpful");

    assert.equal(session.systemPrompt, "You are helpful");
    assert.equal(session.cursor, session.root);
    assert.equal(session.history().length, 1);
    assert.deepEqual(session.messages, session.history());

    const user = session.addUser("hello");
    const assistant = Message.assistant("hi");
    session.addAssistant(assistant);

    assert.equal(session.cursor, assistant);
    assert.deepEqual(session.history(), [session.root, user, assistant]);
    assert.deepEqual(session.history(false), [user, assistant]);
  });

  it("creates an empty system root when no prompt is supplied", () => {
    const session = Session.create();
    const user = session.addUser("hello");

    assert.equal(session.root.role, Role.System);
    assert.equal(session.root.text, "");
    assert.deepEqual(session.history(), [user]);
  });

  it("preserves prebuilt messages added through addMessage", () => {
    const session = Session.create("system");
    const msg = Message.user("hello").tag("custom").setMeta("source", "fixture");

    const inserted = session.addMessage(msg);

    assert.equal(inserted, msg);
    assert.equal(session.cursor, msg);
    assert.equal(session.cursor.hasTag("custom"), true);
    assert.equal(session.cursor.metadata.source, "fixture");
  });

  it("adds tool messages in order and leaves the cursor on the last tool result", () => {
    const session = Session.create("system");
    session.addUser("run tools");

    const first = Message.tool("call_1", "first", "tool_a");
    const second = Message.tool("call_2", "second", "tool_b");
    session.addTool([first, second]);

    assert.equal(session.cursor, second);
    assert.deepEqual(session.history().map((msg) => msg.text), [
      "system",
      "run tools",
      "first",
      "second",
    ]);
  });

  it("rewinds to an earlier message and creates a new branch", () => {
    const { session, firstUser, firstAssistant, branchUser, branchAssistant } =
      createBranchedSession();

    assert.equal(session.cursor, branchAssistant);
    assert.deepEqual(firstUser.children, [firstAssistant, branchUser]);
    assert.deepEqual(session.allLeaves, [firstAssistant, branchAssistant]);
    assert.deepEqual(
      session.branches.map((branch) => branch.map((msg) => msg.text)),
      [
        ["system prompt", "first user", "first answer"],
        ["system prompt", "first user", "branch question", "branch answer"],
      ]
    );
  });

  it("rejects rewinding to a message from another session", () => {
    const session = Session.create("system");
    const other = Session.create("other");
    const foreignMessage = other.addUser("foreign");

    assert.throws(() => session.rewind(foreignMessage));
  });

  it("updates the system prompt and clears a session", () => {
    const session = Session.create("old");
    session.addUser("hello");

    session.systemPrompt = "new";
    assert.equal(session.systemPrompt, "new");

    session.clear();
    assert.equal(session.systemPrompt, "");
    assert.equal(session.cursor, session.root);
    assert.deepEqual(session.root.children, []);
    assert.equal(session.totalUsage.totalTokens, 0);
  });

  it("totals usage across the full message tree", () => {
    const { session } = createBranchedSession();

    assert.deepEqual(session.totalUsage.toJSON(), {
      promptTokens: 9,
      completionTokens: 14,
      totalTokens: 23,
    });
  });

  it("serializes and restores id, title, tree, and cursor path", () => {
    const { session, branchAssistant } = createBranchedSession();
    session.title = "Fixture session";

    const restored = Session.fromJSON(session.toJSON());

    assert.equal(restored.id, session.id);
    assert.equal(restored.title, "Fixture session");
    assert.equal(restored.systemPrompt, "system prompt");
    assert.equal(restored.cursor.text, branchAssistant.text);
    assert.deepEqual(
      restored.history().map((msg) => msg.text),
      ["system prompt", "first user", "branch question", "branch answer"]
    );
    assert.deepEqual(restored.totalUsage.toJSON(), {
      promptTokens: 9,
      completionTokens: 14,
      totalTokens: 23,
    });
  });
});

describe("Session query", () => {
  it("finds messages by content, tags, role, and custom predicates", () => {
    const { session, firstAssistant, branchAssistant } = createBranchedSession();

    assert.deepEqual(
      session.query.findByContent(["answer"]).map((msg) => msg.text),
      ["branch answer"]
    );
    assert.deepEqual(
      session.query.findByContent(["answer"], { scope: "tree" }),
      [firstAssistant, branchAssistant]
    );
    assert.deepEqual(
      session.query.findByTags(["answer"], { scope: "tree" }),
      [firstAssistant, branchAssistant]
    );
    assert.deepEqual(
      session.query.findByRole(Role.Assistant, "branch").map((msg) => msg.text),
      ["branch answer"]
    );
    assert.deepEqual(
      session.query.findBy((msg) => msg.usage !== undefined, "tree"),
      [firstAssistant, branchAssistant]
    );
  });

  it("supports match modes and first/last helpers", () => {
    const { session, firstUser, branchAssistant } = createBranchedSession();

    assert.equal(
      session.query.findFirst({
        content: ["first"],
        roles: [Role.User],
      }),
      firstUser
    );
    assert.equal(
      session.query.findLast({
        tags: ["answer"],
      }),
      branchAssistant
    );
    assert.deepEqual(
      session.query
        .findByContent(["branch", "missing"], { mode: MatchMode.OR })
        .map((msg) => msg.text),
      ["branch question", "branch answer"]
    );
    assert.deepEqual(
      session.query
        .findByContent(["branch", "missing"], { mode: MatchMode.AND })
        .map((msg) => msg.text),
      []
    );
  });
});

describe("Session pagination", () => {
  it("creates paginators for branch points and switches cursor to leftmost leaves", () => {
    const { session, firstAssistant, branchAssistant } = createBranchedSession();

    const [paginator] = session.paginators;
    assert.ok(paginator);
    assert.equal(paginator.total, 2);
    assert.equal(paginator.currentIndex, 1);
    assert.equal(paginator.hasPrev, true);
    assert.equal(paginator.hasNext, false);

    paginator.prev();
    assert.equal(session.cursor, firstAssistant);
    assert.equal(paginator.currentIndex, 0);

    paginator.next();
    assert.equal(session.cursor, branchAssistant);
    assert.equal(paginator.currentIndex, 1);
  });

  it("returns null for non-branch parents and throws on invalid page navigation", () => {
    const session = Session.create("system");
    const user = session.addUser("hello");

    assert.equal(session.paginator(user), null);

    const { session: branched } = createBranchedSession();
    const [paginator] = branched.paginators;

    assert.throws(() => paginator.goTo(-1));
    assert.throws(() => paginator.goTo(2));
    assert.throws(() => paginator.next());
  });
});

describe("Session inserter", () => {
  it("inserts messages after an anchor and then expires", () => {
    const session = Session.create("system");
    const user = session.addUser("hello");
    const assistant = session.addAssistant(Message.assistant("hi"));

    const inserter = session.inserter;
    const inserted = inserter
      .moveTo(user)
      .insertAssistantAfter("alternate answer")
      .execute();

    assert.equal(inserted?.text, "alternate answer");
    assert.equal(inserter.isExpired, true);
    assert.deepEqual(user.children.map((msg) => msg.text), ["hi", "alternate answer"]);
    assert.equal(assistant.parent, user);
    assert.throws(() => inserter.bottom());
  });

  it("inserts messages before an anchor by grafting the old anchor under the new node", () => {
    const session = Session.create("system");
    const user = session.addUser("hello").tag("target");
    const assistant = session.addAssistant(Message.assistant("hi"));

    const inserted = session.inserter
      .moveByTags(["target"], { priority: Priority.OLDEST })
      .move(1)
      .insertUserBefore("between")
      .execute();

    assert.equal(inserted?.text, "between");
    assert.deepEqual(user.children.map((msg) => msg.text), ["between"]);
    assert.equal(assistant.parent, inserted);
    assert.deepEqual(assistant.getHistory().map((msg) => msg.text), [
      "system",
      "hello",
      "between",
      "hi",
    ]);
  });

  it("supports content based movement and validates movement boundaries", () => {
    const session = Session.create("system");
    session.addUser("first");
    session.addAssistant(Message.assistant("second best match").tag("mark"));
    session.addUser("third best match");

    const inserter = session.inserter;
    inserter.moveByContent(["best", "third"], { priority: Priority.BEST_MATCH });

    assert.equal(inserter.current.text, "third best match");
    assert.equal(inserter.position, 3);
    assert.equal(inserter.length, 4);
    assert.throws(() => inserter.move(1));
    assert.throws(() => inserter.moveByTags(["missing"]));
  });
});
