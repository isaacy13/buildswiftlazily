import test from "node:test";
import assert from "node:assert/strict";
import { detectIosProjects } from "../src/github.js";
import {
  assertSafeRef,
  assertSafeRelPath,
  assertSafeRepo,
} from "../src/config.js";
import { scoreGuideAiRelevance } from "../src/cursor.js";

test("detectIosProjects finds workspace and skips Pods", () => {
  const paths = [
    "GuideAI.xcodeproj/project.pbxproj",
    "GuideAI.xcworkspace/contents.xcworkspacedata",
    "Pods/Some.xcodeproj/project.pbxproj",
    "Features/Foo/Foo.xcodeproj/project.pbxproj",
  ];
  const found = detectIosProjects(paths, 4);
  assert.ok(found.some((f) => f.name === "GuideAI" && f.kind === "workspace"));
  assert.ok(!found.some((f) => f.projectPath.includes("Pods")));
  assert.ok(found.some((f) => f.projectPath === "Features/Foo"));
});

test("assertSafeRepo accepts owner/name only", () => {
  assert.equal(assertSafeRepo("isaacy13/GuideAI"), "isaacy13/GuideAI");
  assert.throws(() => assertSafeRepo("../etc/passwd"));
  assert.throws(() => assertSafeRepo("https://github.com/a/b"));
});

test("assertSafeRef rejects traversal and metacharacters", () => {
  assert.equal(assertSafeRef("feature/foo"), "feature/foo");
  assert.throws(() => assertSafeRef("main;rm -rf /"));
  assert.throws(() => assertSafeRef("foo/../bar"));
});

test("assertSafeRelPath rejects absolute and ..", () => {
  assert.equal(assertSafeRelPath("ios/App"), "ios/App");
  assert.throws(() => assertSafeRelPath("../secret"));
  assert.throws(() => assertSafeRelPath("/etc"));
});

test("scoreGuideAiRelevance prefers GuideAI agents", () => {
  const a = scoreGuideAiRelevance(
    { id: "1", name: "GuideAI polish", branches: [{ repoUrl: "github.com/x/GuideAI", branch: "feat" }], updatedAt: new Date().toISOString() },
    "x/GuideAI",
  );
  const b = scoreGuideAiRelevance(
    { id: "2", name: "unrelated", updatedAt: "2020-01-01T00:00:00Z" },
    "x/GuideAI",
  );
  assert.ok(a > b);
});
